/**
 * AgentRegistryService — owns the `agents` table.
 *
 * Three writer-side responsibilities:
 *   1. register()          operator-initiated registration; optionally
 *                          mints a secret returned exactly once
 *   2. touch()             called from the auth/decision hot path on
 *                          every sighting; updates last_seen_at and
 *                          auto-creates 'unregistered' rows
 *   3. update / rotate /    operator lifecycle: change scope, rotate
 *      setStatus            secret, suspend, deprecate
 *
 * Read side: get(), list(), authorize() — the last is the call the auth
 * middleware uses to decide whether an incoming agent_id is allowed.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';
import {
  AgentRegistrationInput,
  AgentRegistrationResponse,
  AgentStatus,
  AgentUpdateRequest,
  RegisteredAgent,
} from '@agentguard/core-schema';
import { agentLimitForTier, config } from '../config';

export interface AgentFirstSightingEvent {
  orgId: string;
  agentId: string;
  /** ISO 8601 timestamp captured at insert time. */
  timestamp: string;
  /** Provenance backfilled from SDK headers, if any. */
  provenance?: { build_artifact?: string; source_commit?: string };
}

const SECRET_PREFIX = 'aegis_a_';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function mintSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function safeParseJson<T = unknown>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

function rowToAgent(row: any): RegisteredAgent {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    owner_email: row.owner_email ?? undefined,
    workflow_hash: row.workflow_hash ?? undefined,
    declared_tools: row.declared_tools ? JSON.parse(row.declared_tools) : undefined,
    max_cost_daily_usd: row.max_cost_daily_usd ?? undefined,
    environments: row.environments ? JSON.parse(row.environments) : undefined,
    status: row.status as AgentStatus,
    has_secret: !!row.secret_hash,
    has_public_key: !!row.public_key_pem,
    capabilities: safeParseJson<any>(row.capabilities),
    provenance: safeParseJson<any>(row.provenance),
    audit_only: !!row.audit_only,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at ?? undefined,
  };
}

export interface AuthorizeResult {
  agent: RegisteredAgent;
  /** Convenience: whether the gate should block this call. */
  blocked: boolean;
  blockReason?: string;
  /** Used by audit-row attribution. */
  attributionStrength: 'strong' | 'weak';
}

/**
 * Result of a capability check — the gate's per-call decision about
 * whether the agent is attested to call this tool.
 */
export interface CapabilityCheck {
  allowed: boolean;
  reason: string;
}

export class AgentRegistryService {
  /** In-process event bus for lifecycle events. Subscribers (e.g. the
   *  onboarding SSE endpoint) listen for `first_sighting`. Single process
   *  only; multi-replica deployments should fan out via the audit-log
   *  pipeline instead. */
  readonly events = new EventEmitter();

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.events.setMaxListeners(64);
  }

  onFirstSighting(listener: (e: AgentFirstSightingEvent) => void): () => void {
    this.events.on('first_sighting', listener);
    return () => this.events.off('first_sighting', listener);
  }

  /** Operator-initiated registration. If `id` is supplied and an
   *  unregistered row exists, it's promoted to active in place; otherwise
   *  a new row is created. Returns the plaintext secret iff requested. */
  register(opts: { orgId: string; req: AgentRegistrationInput }): AgentRegistrationResponse {
    const id = opts.req.id ?? randomUUID();
    const existing = this.getRow(id);

    let secret: string | undefined;
    let secretHash: string | null = null;
    if (opts.req.issue_secret) {
      secret = mintSecret();
      secretHash = sha256(secret);
    } else if (existing?.secret_hash) {
      secretHash = existing.secret_hash;   // preserve on re-register without rotate
    }

    const declared = opts.req.declared_tools ? JSON.stringify(opts.req.declared_tools) : null;
    const envs = opts.req.environments ? JSON.stringify(opts.req.environments) : null;
    const capabilities = opts.req.capabilities ? JSON.stringify(opts.req.capabilities) : null;
    const provenance   = opts.req.provenance   ? JSON.stringify(opts.req.provenance)   : null;

    // Workflow-hash binding: opt-in. If the caller provides one, it
    // becomes the attested workflow for this agent — future authorize()
    // calls will reject sightings whose workflow hash doesn't match.
    // On re-register without a hash, we preserve the existing binding
    // (silent clear would open a downgrade attack path).
    const workflowHash = opts.req.workflow_hash ?? existing?.workflow_hash ?? null;

    if (existing) {
      this.db.prepare(
        `UPDATE agents SET
           org_id = ?, name = ?, description = ?, owner_email = ?,
           declared_tools = ?, max_cost_daily_usd = ?, environments = ?,
           status = 'active',
           secret_hash = COALESCE(?, secret_hash),
           public_key_pem = ?,
           capabilities = ?,
           provenance = ?,
           workflow_hash = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        opts.orgId,
        opts.req.name ?? existing.name ?? null,
        opts.req.description ?? existing.description ?? null,
        opts.req.owner_email ?? existing.owner_email ?? null,
        declared ?? existing.declared_tools,
        opts.req.max_cost_daily_usd ?? existing.max_cost_daily_usd,
        envs ?? existing.environments,
        secretHash,
        opts.req.public_key_pem ?? existing.public_key_pem ?? null,
        capabilities ?? existing.capabilities ?? null,
        provenance   ?? existing.provenance   ?? null,
        workflowHash,
        id,
      );
    } else {
      this.db.prepare(
        `INSERT INTO agents
           (id, org_id, name, description, owner_email,
            declared_tools, max_cost_daily_usd, environments,
            status, secret_hash, public_key_pem,
            capabilities, provenance, workflow_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(
        id, opts.orgId,
        opts.req.name ?? null,
        opts.req.description ?? null,
        opts.req.owner_email ?? null,
        declared, opts.req.max_cost_daily_usd ?? null, envs,
        secretHash, opts.req.public_key_pem ?? null,
        capabilities, provenance, workflowHash,
      );
    }

    // Tier-limit overflow: if this org is now over the license cap for
    // enforced agents, flag THIS agent as audit_only. Earlier agents
    // keep enforcement — the new one traces but never blocks. Skip for
    // re-registrations of already-audit-only rows (idempotent).
    this.applyTierOverflow(opts.orgId, id);

    return { agent: this.get(id)!, secret };
  }

  /**
   * Auto-flag the given agent `audit_only=1` when its org is over the
   * license-tier cap on enforced (non-audit-only) agents. Called after
   * every register() / first-sighting touch(). Idempotent: never
   * *clears* audit_only (upgrades or manual toggles do that).
   *
   * The overflow check is inclusive of the current row: if the row is
   * already audit_only, we leave it. If the count of enforced agents
   * (including this one) is over the cap, flip it to audit_only.
   */
  private applyTierOverflow(orgId: string, agentId: string): void {
    const limit = agentLimitForTier(config.license.tier);
    if (!isFinite(limit)) return;  // enterprise / unlimited — no overflow possible
    try {
      const enforcedCount = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM agents
          WHERE org_id = ?
            AND status IN ('active', 'unregistered')
            AND audit_only = 0`,
      ).get(orgId) as { n: number }).n;
      if (enforcedCount > limit) {
        const row = this.getRow(agentId);
        if (row && !row.audit_only) {
          this.db.prepare(
            `UPDATE agents SET audit_only = 1, updated_at = datetime('now') WHERE id = ?`,
          ).run(agentId);
          this.logger.warn(
            { orgId, agentId, enforcedCount, limit, tier: config.license.tier },
            'agent auto-flagged audit_only — tier cap reached',
          );
        }
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, orgId, agentId }, 'applyTierOverflow failed');
    }
  }

  /**
   * License-tier limit snapshot for an org. Powers the Cockpit banner
   * ("45 / 50 agents · 2 in audit-only · Upgrade to Team →") and the
   * ops CLI. Returns finite Infinity as `null` in the wire format.
   */
  getLimits(orgId: string): {
    tier: 'community' | 'pro' | 'enterprise';
    limit: number | null;
    enforced_count: number;
    audit_only_count: number;
    total_count: number;
    over_limit: boolean;
  } {
    const tier = config.license.tier;
    const limit = agentLimitForTier(tier);
    const enforced_count = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM agents
        WHERE org_id = ?
          AND status IN ('active', 'unregistered')
          AND audit_only = 0`,
    ).get(orgId) as { n: number }).n;
    const audit_only_count = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM agents
        WHERE org_id = ?
          AND status IN ('active', 'unregistered')
          AND audit_only = 1`,
    ).get(orgId) as { n: number }).n;
    return {
      tier,
      limit: isFinite(limit) ? limit : null,
      enforced_count,
      audit_only_count,
      total_count: enforced_count + audit_only_count,
      over_limit: isFinite(limit) && enforced_count + audit_only_count > limit,
    };
  }

  /** Manual toggle. Owner-initiated: e.g. after upgrading a tier, flip
   *  overflow agents back to enforced, or downgrade a specific agent
   *  to audit-only without deregistering it. */
  setAuditOnly(opts: { orgId: string; agentId: string; auditOnly: boolean }): RegisteredAgent | null {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return null;
    this.db.prepare(
      `UPDATE agents SET audit_only = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(opts.auditOnly ? 1 : 0, opts.agentId);
    return this.get(opts.agentId);
  }

  /** Called from the hot path on every agent sighting. Idempotent.
   *  Optionally backfills provenance fields when the SDK reported them
   *  via X-AEGIS-Build-Artifact / X-AEGIS-Source-Commit and the row's
   *  provenance is still empty. */
  touch(opts: { orgId: string; agentId: string; provenance?: { build_artifact?: string; source_commit?: string } }): void {
    try {
      const row = this.getRow(opts.agentId);
      if (row) {
        this.db.prepare(
          `UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?`,
        ).run(opts.agentId);
        // Backfill provenance fields if SDK reported them and we don't
        // have them yet. Operator-set provenance is never overwritten.
        if (opts.provenance && !row.provenance) {
          const next: any = {};
          if (opts.provenance.build_artifact) next.build_artifact = opts.provenance.build_artifact;
          if (opts.provenance.source_commit)  next.source_commit  = opts.provenance.source_commit;
          if (Object.keys(next).length > 0) {
            this.db.prepare(
              `UPDATE agents SET provenance = ?, updated_at = datetime('now') WHERE id = ?`,
            ).run(JSON.stringify(next), opts.agentId);
          }
        }
        return;
      }
      // First sighting → auto-record as unregistered, with provenance if
      // the SDK reported any.
      const prov = opts.provenance && (opts.provenance.build_artifact || opts.provenance.source_commit)
        ? JSON.stringify({
            build_artifact: opts.provenance.build_artifact,
            source_commit: opts.provenance.source_commit,
          })
        : null;
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO agents (id, org_id, status, last_seen_at, provenance)
         VALUES (?, ?, 'unregistered', datetime('now'), ?)`,
      ).run(opts.agentId, opts.orgId, prov);
      if (result.changes > 0) {
        this.applyTierOverflow(opts.orgId, opts.agentId);
        // Emit first-sighting event on the in-process bus. Wrapped in a
        // setImmediate so a slow subscriber can never starve the hot
        // path. Errors inside listeners are swallowed.
        const evt: AgentFirstSightingEvent = {
          orgId: opts.orgId,
          agentId: opts.agentId,
          timestamp: new Date().toISOString(),
          provenance: opts.provenance && (opts.provenance.build_artifact || opts.provenance.source_commit)
            ? {
                build_artifact: opts.provenance.build_artifact,
                source_commit:  opts.provenance.source_commit,
              }
            : undefined,
        };
        setImmediate(() => {
          try {
            this.events.emit('first_sighting', evt);
          } catch (err) {
            this.logger.warn({ err: (err as Error).message, agentId: opts.agentId }, 'first_sighting listener error');
          }
        });
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, agentId: opts.agentId }, 'agent touch failed');
    }
  }

  /** Auth-time identity check. Returns block decision + attribution
   *  strength for the audit layer.
   *
   *  Identity material precedence:
   *    1. `presentedJwt`  — signed AEGIS Agent ID card (strong)
   *    2. `presentedSecret` — legacy shared secret (still strong, but
   *       no offline-verifiable claim payload)
   *    3. neither — falls through to the agent's `has_secret` gate:
   *       agents with a secret REQUIRE one to pass. */
  authorize(opts: {
    orgId: string;
    agentId: string;
    presentedSecret?: string;
    /** Already-verified JWT claim payload (the caller invokes
     *  AgentIdCardService.verify() first; this just plumbs through
     *  the result so authorize() can decide on attribution). */
    presentedJwtValid?: boolean;
    /** SDK-reported build provenance — backfilled into the row on first
     *  sighting / when the row had no provenance yet. */
    provenance?: { build_artifact?: string; source_commit?: string };
    /** Workflow-hash the SDK / proxy asserts this call originated from
     *  (Phase 1.2). When the agent has a workflow_hash bound at
     *  registration AND the sighting asserts a hash, they must match
     *  or the call is blocked with `workflow_mismatch`. Missing header
     *  is tolerated on legacy-agent rows (no binding = no enforcement)
     *  so upgrade paths don't break in place. */
    presentedWorkflowHash?: string;
  }): AuthorizeResult | null {
    this.touch({ orgId: opts.orgId, agentId: opts.agentId, provenance: opts.provenance });
    const agent = this.get(opts.agentId);
    if (!agent) return null;   // touch should have created it; defensive

    // Hard block states.
    if (agent.status === 'suspended') {
      return { agent, blocked: true, blockReason: 'agent suspended', attributionStrength: 'weak' };
    }
    if (agent.status === 'deprecated') {
      return { agent, blocked: true, blockReason: 'agent deprecated', attributionStrength: 'weak' };
    }

    // Tier-overflow: agents beyond the license cap always allow. The
    // trace still lands (this branch runs AFTER touch()), but the gate
    // never blocks. Downstream policy/anomaly checks should honour
    // agent.audit_only similarly — done in policy-engine.ts.
    if (agent.audit_only) {
      return {
        agent, blocked: false, attributionStrength: 'weak',
        blockReason: undefined,
      };
    }

    // Workflow-attestation check — only enforced when the row has a
    // bound workflow_hash AND the sighting asserts one. This gives
    // operators a clean staged rollout: register with hash → SDK
    // starts sending header → enforcement kicks in for THAT agent
    // only, without impacting any other agent in the fleet.
    if (agent.workflow_hash && opts.presentedWorkflowHash
        && agent.workflow_hash !== opts.presentedWorkflowHash) {
      return {
        agent, blocked: true,
        blockReason: `workflow_mismatch (bound ${agent.workflow_hash.slice(0, 12)}…, presented ${opts.presentedWorkflowHash.slice(0, 12)}…)`,
        attributionStrength: 'weak',
      };
    }

    // A valid JWT is a strictly stronger proof of identity than the
    // shared secret (the JWT carries claims signed by the gateway and
    // verifies offline). If a JWT verified, treat the call as
    // authenticated regardless of whether a secret was also configured.
    if (opts.presentedJwtValid) {
      return { agent, blocked: false, attributionStrength: 'strong' };
    }

    // If a secret is required on the row but the caller didn't present
    // one (or presented the wrong one), block.
    if (agent.has_secret) {
      if (!opts.presentedSecret) {
        return { agent, blocked: true, blockReason: 'agent secret required', attributionStrength: 'weak' };
      }
      const row = this.getRow(opts.agentId);
      // Constant-time compare on the sha256 hex strings. Both sides are
      // 64-char hex so the length-check fast path never fires on a real
      // mismatch; this defeats per-byte timing attacks on the secret.
      const presented = sha256(opts.presentedSecret);
      const stored    = row!.secret_hash;
      if (presented.length !== stored.length
          || !timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(stored, 'utf8'))) {
        return { agent, blocked: true, blockReason: 'agent secret mismatch', attributionStrength: 'weak' };
      }
    }

    return {
      agent,
      blocked: false,
      attributionStrength: agent.status === 'active' ? 'strong' : 'weak',
    };
  }

  /**
   * Capability attestation — enforce that the agent only calls tools it
   * declared at registration time.
   *
   * Behaviour:
   *  - If the agent has no `declared_tools` set → allowed (backwards
   *    compatible: unattested agents are unrestricted; ops can tighten
   *    per-agent by populating the field).
   *  - If the tool name matches a declared entry exactly, or matches a
   *    wildcard prefix (`stripe.*` matches `stripe.refund`), it's
   *    allowed.
   *  - Otherwise blocked with a specific reason.
   *
   * Wildcards use the shell-style `*` at the tail only —
   * `foo.*` matches `foo.anything`; interior stars are treated as
   * literals so nothing can shadow a specific rule by accident.
   */
  checkCapability(opts: { agentId: string; toolName: string }): CapabilityCheck {
    const agent = this.get(opts.agentId);
    if (!agent) return { allowed: true, reason: 'agent not registered — no declared_tools to enforce' };

    const declared = agent.declared_tools;
    if (!declared || declared.length === 0) {
      return { allowed: true, reason: 'no declared_tools set — capability check skipped' };
    }
    for (const entry of declared) {
      if (entry === opts.toolName) return { allowed: true, reason: `matched declared_tool "${entry}"` };
      if (entry.endsWith('.*')) {
        const prefix = entry.slice(0, -2);  // "stripe.*" → "stripe."
        if (opts.toolName.startsWith(prefix + '.')) {
          return { allowed: true, reason: `matched declared_tool wildcard "${entry}"` };
        }
      }
    }
    return {
      allowed: false,
      reason: `tool "${opts.toolName}" is not in the agent's declared_tools attestation (${declared.length} entries).`,
    };
  }

  update(opts: { orgId: string; agentId: string; req: AgentUpdateRequest }): RegisteredAgent | null {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return null;

    const declared = opts.req.declared_tools !== undefined
      ? JSON.stringify(opts.req.declared_tools)
      : existing.declared_tools;
    const envs = opts.req.environments !== undefined
      ? JSON.stringify(opts.req.environments)
      : existing.environments;
    const capabilities = opts.req.capabilities !== undefined
      ? (opts.req.capabilities === null ? null : JSON.stringify(opts.req.capabilities))
      : existing.capabilities;
    const provenance = opts.req.provenance !== undefined
      ? (opts.req.provenance === null ? null : JSON.stringify(opts.req.provenance))
      : existing.provenance;

    this.db.prepare(
      `UPDATE agents SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         owner_email = COALESCE(?, owner_email),
         declared_tools = ?,
         max_cost_daily_usd = CASE WHEN ? THEN ? ELSE max_cost_daily_usd END,
         environments = ?,
         status = COALESCE(?, status),
         public_key_pem = CASE WHEN ? THEN ? ELSE public_key_pem END,
         capabilities = ?,
         provenance = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      opts.req.name ?? null,
      opts.req.description ?? null,
      opts.req.owner_email ?? null,
      declared,
      opts.req.max_cost_daily_usd !== undefined ? 1 : 0,
      opts.req.max_cost_daily_usd ?? null,
      envs,
      opts.req.status ?? null,
      opts.req.public_key_pem !== undefined ? 1 : 0,
      opts.req.public_key_pem ?? null,
      capabilities,
      provenance,
      opts.agentId,
    );
    return this.get(opts.agentId);
  }

  /** Generates a fresh secret and stores its hash. Returns the plaintext
   *  once; caller is responsible for transporting it to the agent. */
  rotateSecret(opts: { orgId: string; agentId: string }): { secret: string } | null {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return null;
    const secret = mintSecret();
    this.db.prepare(
      `UPDATE agents SET secret_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(sha256(secret), opts.agentId);
    return { secret };
  }

  deregister(opts: { orgId: string; agentId: string }): boolean {
    const existing = this.getRow(opts.agentId);
    if (!existing || existing.org_id !== opts.orgId) return false;
    this.db.prepare(
      `UPDATE agents SET status = 'deprecated', updated_at = datetime('now') WHERE id = ?`,
    ).run(opts.agentId);
    return true;
  }

  get(agentId: string): RegisteredAgent | null {
    const row = this.getRow(agentId);
    return row ? rowToAgent(row) : null;
  }

  list(opts: { orgId: string; status?: AgentStatus; includeDeprecated?: boolean }): RegisteredAgent[] {
    const filters = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.status) {
      filters.push('status = ?');
      params.push(opts.status);
    } else if (!opts.includeDeprecated) {
      filters.push("status != 'deprecated'");
    }
    const rows = this.db.prepare(
      `SELECT * FROM agents WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC`,
    ).all(...params) as any[];
    return rows.map(rowToAgent);
  }

  private getRow(agentId: string): any {
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
  }
}
