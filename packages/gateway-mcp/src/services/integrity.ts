/**
 * Audit-chain integrity verification.
 *
 * The README and the comparison table prominently advertise
 * "tamper-evident audit trail (hash chain + Ed25519)." Until this
 * service shipped there was no callable surface to prove that
 * claim — the integrity_hash and previous_hash columns existed
 * on every trace row but nothing on the gateway walked them.
 *
 * `verifyAgentChain` walks all traces for one agent in
 * sequence_number order and returns a precise verdict:
 *
 *   - { ok: true,  total: N, latest_trace_id, ... }    — chain intact
 *   - { ok: false, total: N, broken_at: { ... }, ... } — first break
 *
 * Scope (v0.3): **linkage verification only**.
 *   - link_broken — a row's previous_hash doesn't equal the prior
 *                   row's integrity_hash. This catches insertions,
 *                   deletions, and reorderings.
 *
 * Why not recompute the per-row hash? The gateway does PII
 * redaction on input_context / thought_chain / tool_call /
 * observation **before** inserting, but the integrity_hash was
 * computed by the SDK on the pre-redaction content. Recomputing
 * from the stored (redacted) row would always disagree with the
 * stored hash — that's not tampering, it's the PII contract.
 *
 * Per-row content-tamper detection (a separate canonical
 * pre-redaction hash field) is on the roadmap for v0.4. Linkage
 * already catches every attack vector that doesn't require full
 * DB write access (insertion / deletion / reorder); a full-write
 * attacker can cascade hash updates and defeat any chain — the
 * Ed25519 signature path (optional, off by default) is the
 * defense for that threat model.
 */

import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { computeContentHash } from './content-hash';

export type IntegrityBreakReason = 'link_broken' | 'content_tamper' | 'anchor_mismatch' | 'anchor_missing';

export interface IntegrityBreak {
  reason: IntegrityBreakReason;
  sequence_number: number;
  trace_id: string;
  expected: string;
  actual: string;
}

export interface IntegrityReport {
  ok: boolean;
  agent_id: string;
  total: number;
  /** id (trace_id) of the latest trace in the chain — useful for
   *  printing "as of trace X" in audit reports. */
  latest_trace_id: string | null;
  /** First detected break, or undefined if the chain is intact.
   *  We stop at the first break — once linkage is gone the
   *  remaining checks would all be on suspect data. */
  broken_at?: IntegrityBreak;
  /** Wall-clock ms the verification took. */
  latency_ms: number;
}

export interface BulkIntegrityReport {
  /** Number of distinct agents inspected. */
  total_agents: number;
  /** Count of agents whose chain is intact. */
  ok_agents: number;
  /** Count of agents with a detected break (subset of total). */
  broken_agents: number;
  /** Per-agent verdict, sorted broken-first then by total DESC. */
  agents: Array<{
    agent_id: string;
    ok: boolean;
    total: number;
    /** Set only when ok=false. */
    broken_at?: IntegrityBreak;
  }>;
  /** Wall-clock ms for the entire sweep. */
  latency_ms: number;
}

export class IntegrityService {
  constructor(
    private db: Database.Database,
    private logger?: Logger,
    /** Chain heads committed to the transparency log (chain-anchor.ts). */
    private anchors?: import('./chain-anchor').ChainAnchorService,
  ) {}

  /**
   * Run verifyAgentChain for every distinct agent_id in the traces
   * table. Returns a summary with per-agent breakdown sorted
   * broken-first — the operator's "what's wrong, exactly" answer.
   *
   * For a 50-agent deployment this typically completes in single-
   * digit ms total (linkage is O(N) over each agent's history; the
   * content hash recompute is the dominant cost and is itself
   * O(content size)). No batching needed at v0.4 scale; revisit
   * when individual agents have ≫ 100k traces.
   */
  verifyAllAgents(): BulkIntegrityReport {
    const started = Date.now();
    const agentIds = (this.db
      .prepare(`SELECT DISTINCT agent_id FROM traces ORDER BY agent_id ASC`)
      .all() as Array<{ agent_id: string }>).map((r) => r.agent_id);

    const agents = agentIds.map((id) => {
      const r = this.verifyAgentChain(id);
      return {
        agent_id: id,
        ok: r.ok,
        total: r.total,
        broken_at: r.broken_at,
      };
    });

    // Sort: broken first, then by trace count desc — the surface
    // an operator would scan top-to-bottom.
    agents.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? 1 : -1;
      return b.total - a.total;
    });

    const broken = agents.filter((a) => !a.ok).length;
    return {
      total_agents: agents.length,
      ok_agents: agents.length - broken,
      broken_agents: broken,
      agents,
      latency_ms: Date.now() - started,
    };
  }

  verifyAgentChain(agent_id: string): IntegrityReport {
    const started = Date.now();

    // Pull linkage + content_hash columns. linkage check uses
    // integrity_hash + previous_hash; the v0.4 content-tamper check
    // recomputes SHA-256 over the four stored payloads and compares
    // to the stored content_hash. Rows pre-v0.4 have content_hash =
    // NULL — those skip the content check (verified true, with a
    // note in the row).
    const rows = this.db
      .prepare(
        `SELECT trace_id, sequence_number, integrity_hash, previous_hash,
                content_hash, input_context, thought_chain, tool_call, observation
         FROM traces
         WHERE agent_id = ?
         ORDER BY sequence_number ASC`,
      )
      .all(agent_id) as Array<{
        trace_id: string;
        sequence_number: number;
        integrity_hash: string;
        previous_hash: string | null;
        content_hash: string | null;
        input_context: string;
        thought_chain: string;
        tool_call: string;
        observation: string;
      }>;

    if (rows.length === 0) {
      return {
        ok: true,
        agent_id,
        total: 0,
        latest_trace_id: null,
        latency_ms: Date.now() - started,
      };
    }

    let prevHash: string | null = null;
    for (const row of rows) {
      // v0.4 content-tamper check — runs first because it bounds
      // the row in question more tightly than linkage (which would
      // also flag this row's content change as a "next row link
      // break"; the content_tamper reason is more informative).
      if (row.content_hash) {
        const recomputed = computeContentHash(
          JSON.parse(row.input_context),
          JSON.parse(row.thought_chain),
          JSON.parse(row.tool_call),
          JSON.parse(row.observation),
        );
        if (recomputed !== row.content_hash) {
          this.logger?.warn(
            { agent_id, sequence_number: row.sequence_number },
            'integrity: content_tamper detected',
          );
          return {
            ok: false,
            agent_id,
            total: rows.length,
            latest_trace_id: row.trace_id,
            broken_at: {
              reason: 'content_tamper',
              sequence_number: row.sequence_number,
              trace_id: row.trace_id,
              expected: row.content_hash,
              actual: recomputed,
            },
            latency_ms: Date.now() - started,
          };
        }
      }

      // Linkage: previous_hash must equal prior row's integrity_hash.
      // First row may have previous_hash = null, "", or any genesis
      // value — we accept anything for sequence 0; only enforce for
      // subsequent rows. An attacker who inserts a row in the middle
      // breaks the next row's link; an attacker who deletes a row
      // leaves a gap that the *following* row's previous_hash no
      // longer matches.
      if (prevHash !== null && (row.previous_hash ?? '') !== prevHash) {
        this.logger?.warn(
          { agent_id, sequence_number: row.sequence_number },
          'integrity: link_broken detected',
        );
        return {
          ok: false,
          agent_id,
          total: rows.length,
          latest_trace_id: row.trace_id,
          broken_at: {
            reason: 'link_broken',
            sequence_number: row.sequence_number,
            trace_id: row.trace_id,
            expected: prevHash,
            actual: row.previous_hash ?? '',
          },
          latency_ms: Date.now() - started,
        };
      }

      prevHash = row.integrity_hash;
    }

    // A chain that verifies on its own can still have been rewritten
    // wholesale, or cut short at the head: compare it with the heads the
    // transparency log committed to.
    if (this.anchors) {
      const brk = this.anchors.check(agent_id, new Map(rows.map((r) => [r.sequence_number, r.integrity_hash])));
      if (brk) {
        this.logger?.warn({ agent_id, sequence_number: brk.sequence_number }, `integrity: ${brk.reason} detected`);
        return {
          ok: false, agent_id, total: rows.length, latest_trace_id: rows[rows.length - 1].trace_id,
          broken_at: { reason: brk.reason, sequence_number: brk.sequence_number,
                       trace_id: rows.find((r) => r.sequence_number === brk.sequence_number)?.trace_id ?? '',
                       expected: brk.expected, actual: brk.actual },
          latency_ms: Date.now() - started,
        };
      }
    }

    return {
      ok: true,
      agent_id,
      total: rows.length,
      latest_trace_id: rows[rows.length - 1].trace_id,
      latency_ms: Date.now() - started,
    };
  }
}
