/**
 * Per-session context ledgers, in memory.
 *
 * The gateway sees every tool call. To answer "which turn authorised
 * this one" it also has to see what entered the agent's context and
 * through which channel, which is what the SDK now reports to
 * /api/v1/context.
 *
 * WHY IN MEMORY AND NOT IN SQLITE
 *
 * A ledger is read on the hot path, once per tool call, and the whole
 * point of instruction provenance is that it costs under a millisecond.
 * A SQLite round-trip per call would spend the entire budget on storage
 * for data that is worthless once the session ends. Nothing here is
 * evidence: the decision it contributes to is already written to the
 * signed audit chain, along with the provenance facts that produced it.
 *
 * The cost of that choice is honest and worth stating: a gateway restart
 * loses every live ledger, and sessions that survive the restart degrade
 * to `authorised_by: "unknown"` until their next user turn. That is the
 * fail-soft direction — calls are not blocked, they are simply no longer
 * assessed — and it is why `degraded` is reported rather than inferred
 * from a zero margin.
 *
 * A multi-process deployment has the same seam: a session pinned to one
 * process is assessed, one load-balanced across processes is not. The fix
 * is sticky routing by session_id, not a shared store, for the latency
 * reason above.
 */

import {
  ContextEvent,
  ContextLedger,
  assessAuthority,
  toDslFacts,
  type ProvenanceDslFacts,
} from '@agentguard/core-schema';

interface Entry {
  ledger: ContextLedger;
  lastSeen: number;
}

export interface LedgerStoreOptions {
  /** Sessions idle longer than this are dropped. */
  ttlMs?: number;
  /** Hard cap on tracked sessions; the oldest is evicted past it. */
  maxSessions?: number;
}

export class ContextLedgerStore {
  private readonly sessions = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(opts: LedgerStoreOptions = {}) {
    // An agent session that has been silent for an hour is over. The cap
    // bounds memory for a gateway facing many short-lived agents; at 256 KB
    // of text per ledger the ceiling is ~2.5 GB, so the real limit is the
    // cap and not the TTL.
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.maxSessions = opts.maxSessions ?? 10_000;
  }

  /** Scope key. Session ids come from callers, so they are namespaced by
   *  org — one tenant must not be able to read or poison another's
   *  ledger by guessing a session id. */
  private key(orgId: string, sessionId: string): string {
    return `${orgId}\u0000${sessionId}`;
  }

  record(orgId: string, sessionId: string, events: ContextEvent[]): void {
    const k = this.key(orgId, sessionId);
    let entry = this.sessions.get(k);
    if (!entry) {
      this.evictIfNeeded();
      entry = { ledger: new ContextLedger(), lastSeen: Date.now() };
      this.sessions.set(k, entry);
    }
    for (const e of events) entry.ledger.append(e);
    entry.lastSeen = Date.now();
  }

  /**
   * Provenance facts for a call, or undefined when this session has no
   * ledger at all.
   *
   * Returning undefined rather than a synthetic "unknown" block matters:
   * a rule written as `provenance.authorised_by == "unknown"` should match
   * a session that reported context but no user turn, and should not match
   * a deployment whose SDK never reports anything. Those are different
   * situations and a policy author may want to treat them differently.
   */
  assess(
    orgId: string,
    sessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): ProvenanceDslFacts | undefined {
    if (!sessionId) return undefined;
    const entry = this.sessions.get(this.key(orgId, sessionId));
    if (!entry) return undefined;
    if (Date.now() - entry.lastSeen > this.ttlMs) {
      this.sessions.delete(this.key(orgId, sessionId));
      return undefined;
    }
    entry.lastSeen = Date.now();
    return toDslFacts(assessAuthority(toolName, args ?? {}, entry.ledger));
  }

  /** Recent tool output for a session, for the alignment auditor. Same
   *  org scoping as assess(): a caller can only read its own tenant's
   *  ledger. Empty when the session is unknown or expired. */
  observations(orgId: string, sessionId: string | undefined, maxChars = 6000): string[] {
    if (!sessionId) return [];
    const entry = this.sessions.get(this.key(orgId, sessionId));
    if (!entry || Date.now() - entry.lastSeen > this.ttlMs) return [];
    return entry.ledger.recentUntrusted(maxChars);
  }

  /** What a first reviewer needs to judge a held call the way the
   *  evaluation's auditor did: the user's request (most recent user
   *  turns), the agent's recent reasoning, and the tool output it read.
   *  Undefined when the session has no user turn — then only a person
   *  can say what was asked. Org-scoped like assess(). */
  reviewInput(orgId: string, sessionId: string | undefined):
    { goal: string; thoughts: string[]; observations: string[] } | undefined {
    if (!sessionId) return undefined;
    const entry = this.sessions.get(this.key(orgId, sessionId));
    if (!entry || Date.now() - entry.lastSeen > this.ttlMs) return undefined;
    const goal = entry.ledger.recent('user', 4096).join('\n').trim();
    if (!goal) return undefined;
    return {
      goal,
      thoughts: entry.ledger.recent('model', 6000).slice(-3).map((t) => t.slice(0, 2048)),
      observations: entry.ledger.recentUntrusted(6000),
    };
  }

  /** Evidence for a held call (see ContextLedger.evidenceFor), or
   *  undefined when the session has no ledger. Org-scoped like assess(). */
  evidence(orgId: string, sessionId: string | undefined, args: Record<string, unknown> | undefined) {
    if (!sessionId) return undefined;
    const entry = this.sessions.get(this.key(orgId, sessionId));
    if (!entry || Date.now() - entry.lastSeen > this.ttlMs) return undefined;
    return entry.ledger.evidenceFor(args ?? {});
  }

  /** Called when a session ends, so a long-lived gateway does not hold
   *  text from finished conversations until the TTL. */
  forget(orgId: string, sessionId: string): void {
    this.sessions.delete(this.key(orgId, sessionId));
  }

  size(): number {
    return this.sessions.size;
  }

  /** Exposed for the /healthz surface and for tests. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [k, v] of this.sessions) {
      if (now - v.lastSeen > this.ttlMs) {
        this.sessions.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;
    this.sweep();
    if (this.sessions.size < this.maxSessions) return;
    // Still full of live sessions: drop the least recently seen. Losing
    // provenance for the coldest session degrades it to unassessed, which
    // is the same fail-soft direction as a restart.
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of this.sessions) {
      if (v.lastSeen < oldest) {
        oldest = v.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
}
