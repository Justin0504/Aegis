/**
 * RollbackService — saga-style compensating action executor with
 * cryptographically signed audit receipts.
 *
 * Closes the post-execution-rollback gap that NeMo / Lakera / Cisco
 * / Claude Code all leave open. Inspired by SagaLLM (PVLDB 2025) and
 * Atomix (arXiv 2602.14849), grounded against ACRFence's (arXiv
 * 2603.20625) replay-or-fork warning.
 *
 * Two entry points:
 *
 *   rollback(trace_id, options)
 *     Single-trace rollback. Loads the trace, classifies its
 *     reversibility, looks up the registered compensator, executes,
 *     and writes a signed receipt in the Merkle audit log.
 *
 *   rollbackChain({ agent_id, since, dry_run })
 *     Saga semantics. Walks the agent's compensable traces in
 *     REVERSE chronological order since the cutoff and fires each
 *     compensator. Aborts on first failure (subsequent traces stay
 *     un-rolled-back; the audit row carries the abort cursor so the
 *     operator can resume after fixing the failed compensator).
 *
 * Each rollback emits TWO records:
 *   1. An audit_log row with action='rollback.compensate' linking
 *      original_trace_id → compensator_action_id.
 *   2. A transparency-log leaf signed by the gateway key, with
 *      `compensates_leaf` pointing at the original action's hash.
 *      This is the cryptographic differentiator vs seclaw — they
 *      have no signed-receipt chain.
 *
 * The service refuses to roll back:
 *   - already-rolled-back traces (idempotent — second call is a no-op)
 *   - irreversible classes without `force_correction: true`
 *   - compensable classes lacking a registered compensator
 *
 * "Replay-or-fork": this service never re-executes the original
 * action. It only runs the registered inverse. Restore-style replay
 * is intentionally out of scope; that path is what ACRFence warned
 * about and we don't want to ship it without snapshots.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

import { AuditLogService } from './audit-log';
import { TransparencyLogService } from './transparency-log';
import { CompensationRegistry, CompensatorDecl, CostEstimate, HIGH_COST_MAGNITUDES } from './compensation-registry';
import { topologicalRollbackOrder, parseDepends, TraceForRollback } from './causal-rollback';
import { ReversibilityClassifier, ReversibilityClass } from './reversibility';
import { SnapshotCaptureService, SnapshotRow } from './snapshot-capture';
import { SagaService } from './saga';
import { RollbackMetricsService, RollbackOutcome } from './rollback-metrics';
import { DlqService } from './dlq';

export type RollbackStatus =
  | 'rolled_back'
  | 'no_op'
  | 'failed'
  | 'unsupported'
  | 'pending_approval';

export interface RollbackOptions {
  /** Operator-facing reason. Carried into the audit row. */
  reason?: string;
  /** When true, allow rolling back 'irreversible' classes by emitting a
   *  correction-only audit row (no actual undo executes). Disabled by
   *  default — fail-safe. */
  force_correction?: boolean;
  /** When true, plan but don't execute. Useful for "show me what would
   *  happen" UI. */
  dry_run?: boolean;
  /** When true, skip the high-cost approval pause even for a compensator
   *  whose `cost_estimate.magnitude` is 'high' / 'catastrophic'.
   *  Set by RollbackAPI after an operator explicitly approves a paused
   *  saga; do NOT set from normal callers. */
  pre_approved?: boolean;
  /** Three-Ring origin tag (Toledo et al. arXiv:2606.07119):
   *   2 = deterministic strategies-based flow — auto-compensate is safe.
   *   3 = LLM-originated decision — auto-pause for human approval
   *       regardless of cost_estimate, because a non-deterministic
   *       actor's deviations propagate without retrospective
   *       traceability.
   *  Defaults to 2 (Ring-2 fail-safe) if omitted. */
  origin_ring?: 2 | 3;
  /** Operator id for attribution in the audit row. */
  actor?: { user_id?: string; user_email?: string; ip_address?: string };
}

export interface RollbackResult {
  status: RollbackStatus;
  trace_id: string;
  reversibility_class: ReversibilityClass;
  compensator_kind: 'webhook' | 'inline' | 'none' | 'absent';
  audit_id?: number;
  transparency_seq?: number;
  /** Saga this rollback was part of. Always set when SagaService is
   *  wired in; the cockpit uses it to navigate to the saga view. */
  saga_id?: string;
  /** When status='failed', the executor's error message. */
  error?: string;
  /** When dry_run, the rendered compensator action that *would* fire. */
  planned_action?: unknown;
  /** Duration of the compensator execution (ms). Surfaced for the
   *  metrics layer. */
  duration_ms?: number;
  /** Operator-declared cost hint for this compensator. Present when
   *  the compensator registry has `cost_estimate` set; carries through
   *  to the preview API and the approval queue UI. */
  cost_estimate?: CostEstimate;
}

export interface ChainOptions extends RollbackOptions {
  agent_id: string;
  /** ISO timestamp; only roll back traces strictly newer than this. */
  since: string;
  /** Cap on traces processed. Default 200. */
  max?: number;
}

export interface ChainResult {
  agent_id: string;
  scanned: number;
  results: RollbackResult[];
  aborted_at?: string;
  saga_id?: string;
}

/**
 * Delegation-scoped rollback options. Rolls back every trace whose
 * `delegation_id` equals the requested id — semantically "undo all
 * actions performed under this delegation" as defined by Toledo et al.
 * arXiv:2606.09692. Traces are compensated in reverse time order,
 * same as rollbackChain, so a saga is opened for the whole batch.
 */
export interface DelegationRollbackOptions extends RollbackOptions {
  delegation_id: string;
  /** Cap on traces processed. Default 500 (delegations can be larger
   *  than time-scoped chains). */
  max?: number;
}

export interface DelegationRollbackResult {
  delegation_id: string;
  scanned: number;
  results: RollbackResult[];
  aborted_at?: string;
  saga_id?: string;
}

// Lightweight trace row (subset of columns we need)
interface TraceRow {
  trace_id: string;
  agent_id: string;
  timestamp: string;
  tool_call: string;        // JSON
  observation: string;      // JSON
  integrity_hash: string;
  rolled_back_at: string | null;
  reversibility_class: ReversibilityClass | null;
  // Phase 3 · workflow anchors, populated by SDKs on Phase 1.3+.
  // Nullable — legacy rows keep working via the tool-name fallback.
  workflow_node_id: string | null;
  workflow_binding_id: string | null;
}

export class RollbackService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
    private audit: AuditLogService,
    private transparency: TransparencyLogService,
    private registry: CompensationRegistry,
    private classifier: ReversibilityClassifier,
    /** Optional: when present, RollbackService reads the captured
     *  pre-state for each trace and includes it in the compensator
     *  webhook body under `pre_state`. */
    private snapshots?: SnapshotCaptureService,
    /** Optional: when present, every rollback opens a saga and
     *  transitions it through STARTED → EXECUTING → COMPENSATING →
     *  COMPLETED/ABORTED/FAILED. */
    private sagas?: SagaService,
    /** Optional: per-compensator metrics surface for the /metrics
     *  Prometheus endpoint + cockpit observability tab. */
    private metrics?: RollbackMetricsService,
    /** Optional: dead-letter queue for failed compensations. When
     *  webhook retries exhaust, the entry is enqueued here for
     *  operator review. */
    private dlq?: DlqService,
  ) {
    this.ensureColumns();
  }

  /** Best-effort migration — adds rollback bookkeeping columns to
   *  `traces` if they aren't already present. Safe to call repeatedly
   *  (each ALTER is wrapped in a `try/catch` per column).
   *
   *  delegation_id / parent_delegation_id per Toledo et al.
   *  arXiv:2606.09692 — agent-aware observability substrate binding
   *  delegation context at execution time so downstream queries
   *  ("what happened under delegation X") don't rely on heuristic
   *  time-window correlation. */
  private ensureColumns(): void {
    for (const ddl of [
      `ALTER TABLE traces ADD COLUMN reversibility_class TEXT`,
      `ALTER TABLE traces ADD COLUMN rolled_back_at TEXT`,
      `ALTER TABLE traces ADD COLUMN rollback_audit_id INTEGER`,
      `ALTER TABLE traces ADD COLUMN delegation_id TEXT`,
      `ALTER TABLE traces ADD COLUMN parent_delegation_id TEXT`,
    ]) {
      try { this.db.exec(ddl); }
      catch (err: any) {
        if (!/duplicate column/i.test(err?.message ?? '')) {
          this.logger.warn({ err: err?.message, ddl }, 'rollback ddl skipped');
        }
      }
    }
    // Concurrency lock table — see rollback() for rationale. INSERT
    // OR IGNORE against a UNIQUE trace_id gives us an atomic "claim"
    // primitive that prevents two concurrent rollback() calls on the
    // same trace from both firing the compensator. Without this, a
    // Stripe refund would run K times for K concurrent callers.
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rollback_locks (
          trace_id    TEXT PRIMARY KEY,
          acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    } catch (err: any) {
      this.logger.warn({ err: err?.message }, 'rollback_locks table skipped');
    }
    // Index on delegation_id — required for rollbackDelegation() to
    // stay sub-linear on large trace tables.
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_delegation ON traces (delegation_id)`);
    } catch (err: any) {
      this.logger.warn({ err: err?.message }, 'delegation index skipped');
    }
  }

  async rollback(opts: { orgId: string; trace_id: string } & RollbackOptions & { _sagaId?: string }): Promise<RollbackResult> {
    // Single rollback opens its own saga unless one was passed in
    // (rollbackChain reuses one saga across multiple rollback() calls).
    let sagaId = opts._sagaId;
    if (this.sagas && !sagaId) {
      sagaId = this.sagas.open({
        orgId: opts.orgId,
        kind: 'rollback_single',
        root_trace_id: opts.trace_id,
        reason: opts.reason ?? null,
        origin_ring: opts.origin_ring ?? 2,
      });
      this.safeTransition(opts.orgId, sagaId, 'EXECUTING');
    }
    const trace = this.getTrace(opts.trace_id);
    if (!trace) {
      // Close saga as FAILED — never even left STARTED's allowed
      // transitions, so go via EXECUTING → COMPENSATING → FAILED.
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'FAILED', sagaId);
      return { status: 'failed', trace_id: opts.trace_id, reversibility_class: 'irreversible',
        compensator_kind: 'absent', error: 'trace not found', saga_id: sagaId };
    }
    if (trace.agent_id == null) {
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'FAILED', sagaId);
      return { status: 'failed', trace_id: opts.trace_id, reversibility_class: 'irreversible',
        compensator_kind: 'absent', error: 'trace missing agent_id', saga_id: sagaId };
    }
    if (trace.rolled_back_at) {
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'COMPLETED', sagaId);
      return { status: 'no_op', trace_id: opts.trace_id,
        reversibility_class: (trace.reversibility_class ?? 'irreversible') as ReversibilityClass,
        compensator_kind: 'absent', saga_id: sagaId };
    }

    // ── Concurrency claim ────────────────────────────────────────────
    //
    // The check above (`trace.rolled_back_at`) is TOCTOU-unsafe: two
    // concurrent rollback() calls both read NULL, both await the
    // webhook, both fire the compensator. `INSERT OR IGNORE` against
    // a UNIQUE trace_id column gives us an atomic claim primitive —
    // whichever caller's INSERT changes 1 row won the race; the rest
    // see 0 changes and return no_op immediately without touching the
    // webhook.
    //
    // The lock is released in a try/finally at the end of the sync
    // portion of this method so DLQ retry can re-acquire on the next
    // attempt. If the process crashes between claim + release, the
    // row stays until manual cleanup — acceptable because ingress
    // rollback UI already has an "abandoned lock" recovery flow via
    // saga state (a saga in EXECUTING with no active worker is the
    // signal). If that flow proves painful, add a TTL sweep here.
    let lockAcquired = false;
    if (!opts.dry_run) {
      const claim = this.db.prepare(
        `INSERT OR IGNORE INTO rollback_locks (trace_id) VALUES (?)`,
      ).run(opts.trace_id);
      if (claim.changes === 0) {
        this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'COMPLETED', sagaId);
        return {
          status: 'no_op', trace_id: opts.trace_id,
          reversibility_class: (trace.reversibility_class ?? 'compensable') as ReversibilityClass,
          compensator_kind: 'absent', saga_id: sagaId,
          error: 'concurrent rollback in progress',
        };
      }
      lockAcquired = true;
    }

    try {
      return await this._rollbackAfterClaim(opts, trace, sagaId);
    } finally {
      if (lockAcquired) {
        try {
          this.db.prepare(`DELETE FROM rollback_locks WHERE trace_id = ?`).run(opts.trace_id);
        } catch (err: any) {
          this.logger.warn({ err: err?.message, trace_id: opts.trace_id }, 'lock release failed');
        }
      }
    }
  }

  /**
   * Post-claim rollback body. Extracted so `rollback()` can wrap it
   * in a try/finally that guarantees lock release across all early-
   * exit paths. Do not call directly — the concurrency claim in
   * rollback() is required for correctness.
   */
  private async _rollbackAfterClaim(
    opts: { orgId: string; trace_id: string } & RollbackOptions & { _sagaId?: string },
    trace: NonNullable<ReturnType<RollbackService['getTrace']>>,
    sagaId: string | undefined,
  ): Promise<RollbackResult> {
    const toolCall = safeJson<{ tool_name?: string; arguments?: Record<string, unknown> }>(trace.tool_call) ?? {};
    const toolName = toolCall.tool_name ?? 'unknown';
    const args     = toolCall.arguments ?? {};
    const cls      = trace.reversibility_class
      ? { class: trace.reversibility_class as ReversibilityClass, reason: '(persisted)' }
      : this.classifier.classify(toolName, args);

    // Replay-or-fork guard: irreversible without explicit force_correction
    if (cls.class === 'irreversible' && !opts.force_correction) {
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'FAILED', sagaId);
      return {
        status: 'unsupported', trace_id: opts.trace_id,
        reversibility_class: 'irreversible',
        compensator_kind: 'absent',
        error: `tool '${toolName}' is irreversible (${cls.reason}); pass force_correction:true to emit a correction-only receipt`,
        saga_id: sagaId,
      };
    }

    // Phase 3 · node/binding-scoped compensators. If the trace was
    // captured with workflow anchors (Phase 1.3+ SDKs), pass them to
    // the registry so a binding_uuid or node_uuid override can win
    // over the tool_name fallback. `matchedBy` on the lookup result
    // records which axis fired so we can surface it in the audit row
    // and cockpit — helps operators reason about "why did THIS
    // compensator run, not the other one?"
    const lookup = this.registry.lookup(opts.orgId, toolName, {
      node_uuid:    trace.workflow_node_id    ?? undefined,
      binding_uuid: trace.workflow_binding_id ?? undefined,
    });
    const compensator = lookup.compensator;
    if (cls.class === 'compensable' && !compensator) {
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'FAILED', sagaId);
      return {
        status: 'unsupported', trace_id: opts.trace_id,
        reversibility_class: 'compensable',
        compensator_kind: 'absent',
        error: `tool '${toolName}' is compensable but no compensator is registered in tenant_config.rollback.compensators`,
        saga_id: sagaId,
      };
    }

    // For idempotent ops there's nothing to execute — record the
    // rollback as a no-op (operator says "this didn't happen"; we mark
    // it as such but no inverse is needed).
    const plannedAction = compensator
      ? this.renderPlan(compensator, trace, toolCall)
      : { kind: 'no-op', reason: cls.class === 'idempotent' ? 'idempotent: nothing to undo' : 'no compensator declared' };

    const costEstimate: CostEstimate | undefined = compensator?.cost_estimate;

    if (opts.dry_run) {
      this.closeSagaAfterEarlyExit(opts._sagaId, opts.orgId, 'COMPLETED', sagaId);
      return {
        status: 'no_op', trace_id: opts.trace_id, reversibility_class: cls.class,
        compensator_kind: compensator?.kind ?? 'absent',
        planned_action: plannedAction,
        cost_estimate: costEstimate,
        saga_id: sagaId,
      };
    }

    // Approval hold: pause the saga before firing when EITHER
    //   (a) the compensator is high-cost (magnitude ∈ {high, catastrophic}), OR
    //   (b) the saga's origin is Ring-3 (LLM decision) per Toledo et al.
    //       arXiv:2606.07119 — "non-deterministic actor's deviations
    //       propagate without retrospective traceability", so every
    //       Ring-3 rollback needs human eyes even for trivial cost.
    const isRing3     = (opts.origin_ring ?? 2) === 3;
    const isHighCost  = costEstimate && HIGH_COST_MAGNITUDES.includes(costEstimate.magnitude);
    const needsApproval = !opts.pre_approved && (isHighCost || isRing3);
    if (compensator && this.sagas && sagaId && needsApproval) {
      // Format: second token is the compensated tool name (e.g.
      // `stripe_refund`, `postgres_row`). The cockpit parses this out
      // via CARD_BRAND_HINT_RE to render the target service's brand
      // icon on the approval card. Do not reshape without updating
      // that regex.
      const pauseReason = isHighCost
        ? `high-cost ${toolName}: ${costEstimate!.magnitude}` +
          (costEstimate!.note ? ` — ${costEstimate!.note}` : '')
        : `Ring-3 ${toolName}: LLM decision — human approval required`;
      try {
        this.sagas.pauseForApproval({
          orgId: opts.orgId,
          sagaId,
          reason: pauseReason,
        });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, sagaId },
          'pauseForApproval failed; proceeding to execute',
        );
      }
      return {
        status: 'pending_approval',
        trace_id: opts.trace_id,
        reversibility_class: cls.class,
        compensator_kind: compensator.kind,
        planned_action: plannedAction,
        cost_estimate: costEstimate,
        saga_id: sagaId,
      };
    }

    // Execute the compensator (with duration measurement)
    let execError: string | undefined;
    const execStart = Date.now();
    if (compensator && compensator.kind !== 'none') {
      try {
        await this.executeCompensator(compensator, plannedAction);
      } catch (err: any) {
        execError = String(err?.message ?? err);
      }
    }
    const durationMs = Date.now() - execStart;

    // Audit row — written BEFORE we mark the trace, so even on crash
    // the receipt exists. The audit-log service returns void; we
    // recover the rowid via last_insert_rowid() right after.
    this.audit.log({
      org_id: opts.orgId,
      action: 'rollback.compensate',
      resource_type: 'trace',
      resource_id: opts.trace_id,
      user_id:    opts.actor?.user_id,
      user_email: opts.actor?.user_email,
      ip_address: opts.actor?.ip_address,
      details: {
        agent_id: trace.agent_id,
        tool_name: toolName,
        reversibility_class: cls.class,
        reason: opts.reason ?? null,
        compensator_kind: compensator?.kind ?? 'absent',
        original_integrity_hash: trace.integrity_hash,
        planned_action: plannedAction,
        executor_error: execError ?? null,
        force_correction: !!opts.force_correction,
      },
    });
    const lastIdRow = this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number } | undefined;
    const auditId = lastIdRow?.id;

    // Signed Merkle receipt — leaf-linked to the original trace's hash.
    // This is the differentiator vs seclaw: cryptographic proof a
    // rollback happened, against a key the customer trusts.
    let txSeq: number | undefined;
    try {
      const append = this.transparency.append({
        payload: {
          action: 'rollback.compensate',
          original_trace_id: opts.trace_id,
          compensates_leaf:  trace.integrity_hash,
          agent_id:          trace.agent_id,
          tool_name:         toolName,
          reversibility_class: cls.class,
          compensator_kind:  compensator?.kind ?? 'absent',
          executor_error:    execError ?? null,
          reason:            opts.reason ?? null,
          timestamp:         new Date().toISOString(),
        },
        source: 'rollback' as any,
        org_id: opts.orgId,
      });
      if (append && typeof append === 'object' && 'sequence' in append) {
        txSeq = (append as { sequence?: number }).sequence;
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, trace_id: opts.trace_id }, 'transparency append failed');
    }

    if (!execError) {
      this.db.prepare(
        `UPDATE traces SET rolled_back_at = datetime('now'), rollback_audit_id = ?,
                           reversibility_class = COALESCE(reversibility_class, ?)
         WHERE trace_id = ?`,
      ).run(auditId ?? null, cls.class, opts.trace_id);
    }

    const status: RollbackStatus = execError ? 'failed' : 'rolled_back';
    const compKind = compensator?.kind ?? 'absent';

    // Enqueue to DLQ on terminal compensator failure so the operator
    // can review / retry / dismiss instead of the error disappearing
    // into the audit log.
    if (execError && compensator && this.dlq) {
      try {
        this.dlq.enqueue({
          orgId: opts.orgId,
          saga_id: sagaId ?? null,
          trace_id: opts.trace_id,
          tool_name: toolName,
          compensator_kind: compensator.kind,
          last_error: execError,
          attempts_made: (compensator.kind === 'webhook' ? ((compensator.retries ?? 2) + 1) : 1),
          planned_action: plannedAction,
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, trace_id: opts.trace_id }, 'DLQ enqueue failed');
      }
    }

    // Record metric + saga step before returning
    if (this.metrics) {
      this.metrics.record({
        tool_name: toolName,
        compensator_kind: compKind,
        outcome: status as RollbackOutcome,
        duration_ms: durationMs,
      });
    }
    if (this.sagas && sagaId) {
      this.sagas.appendStep({
        sagaId,
        trace_id: opts.trace_id,
        outcome: status === 'rolled_back' ? 'rolled_back' : status === 'failed' ? 'failed' : 'no_op',
        compensator_kind: compKind,
        duration_ms: durationMs,
        error: execError ?? null,
      });
      // Transition only if this rollback opened its own saga (single
      // mode) — chain mode owns the transitions.
      if (!opts._sagaId) {
        if (status === 'failed') {
          this.safeTransition(opts.orgId, sagaId, 'COMPENSATING');
          this.safeTransition(opts.orgId, sagaId, 'FAILED');
        } else {
          this.safeTransition(opts.orgId, sagaId, 'COMPLETED');
        }
      }
    }

    return {
      status,
      trace_id: opts.trace_id,
      reversibility_class: cls.class,
      compensator_kind: compKind,
      audit_id: auditId,
      transparency_seq: txSeq,
      saga_id: sagaId,
      error: execError,
      planned_action: plannedAction,
      cost_estimate: costEstimate,
      duration_ms: durationMs,
    };
  }

  /** Saga transitions can fail when terminal state is already set
   *  (e.g. a chain that already aborted). We log + swallow rather
   *  than crash the rollback. */
  private safeTransition(orgId: string, sagaId: string, to: any): void {
    if (!this.sagas) return;
    try { this.sagas.transition({ orgId, sagaId, to }); }
    catch (err) {
      this.logger.warn({ err: (err as Error).message, sagaId, to }, 'saga transition skipped');
    }
  }

  /** When rollback() returns early (trace missing / already rolled
   *  back / etc.), close the saga we opened. parentSagaId !== undefined
   *  means we were called from a chain — chain owns the close. */
  private closeSagaAfterEarlyExit(
    parentSagaId: string | undefined,
    orgId: string,
    finalState: 'COMPLETED' | 'ABORTED' | 'FAILED',
    sagaId: string | undefined,
  ): void {
    if (!this.sagas || !sagaId || parentSagaId) return;
    if (finalState === 'FAILED') {
      this.safeTransition(orgId, sagaId, 'COMPENSATING');
      this.safeTransition(orgId, sagaId, 'FAILED');
    } else {
      this.safeTransition(orgId, sagaId, finalState);
    }
  }

  /**
   * Delegation-scoped rollback. Given a delegation_id, roll back every
   * un-rolled-back trace tagged with that delegation, in reverse
   * chronological order.
   *
   * Per Toledo et al. arXiv:2606.09692, delegation-scoped attribution
   * is structurally underdetermined from parent_trace_id alone —
   * two incompatible delegation trees can produce identical parent
   * chains. This method uses the bound delegation_id (populated at
   * trace-ingest time by the SDK) to reconstruct the delegation
   * subtree deterministically, without heuristic time-window
   * correlation.
   */
  async rollbackDelegation(
    opts: { orgId: string } & DelegationRollbackOptions,
  ): Promise<DelegationRollbackResult> {
    const limit = opts.max ?? 500;
    // Pull the full causal signal — parent_trace_id + timestamp — so
    // we can order compensations topologically instead of by naive
    // reverse-time (see services/causal-rollback.ts).
    const rows = this.db.prepare(
      `SELECT trace_id, parent_trace_id, timestamp FROM traces
        WHERE delegation_id = ?
          AND rolled_back_at IS NULL
        ORDER BY timestamp DESC LIMIT ?`,
    ).all(opts.delegation_id, limit) as TraceForRollback[];

    const orderedTraceIds = topologicalRollbackOrder(
      rows,
      this.collectExtraDeps(rows.map(r => r.trace_id)),
      (w) => this.logger.warn({ ...w }, 'causal-rollback: ordering degraded'),
    );

    let sagaId: string | undefined;
    if (this.sagas) {
      sagaId = this.sagas.open({
        orgId: opts.orgId,
        kind: 'rollback_chain',    // reuse chain kind; the audit row carries delegation_id
        agent_id: null,
        root_trace_id: orderedTraceIds[0] ?? null,
        reason: opts.reason ?? `delegation:${opts.delegation_id}`,
        origin_ring: opts.origin_ring ?? 2,
      });
      this.safeTransition(opts.orgId, sagaId, 'EXECUTING');
    }

    const results: RollbackResult[] = [];
    let aborted_at: string | undefined;
    for (const traceId of orderedTraceIds) {
      const res = await this.rollback({
        orgId: opts.orgId,
        trace_id: traceId,
        reason: opts.reason,
        dry_run: opts.dry_run,
        force_correction: opts.force_correction,
        pre_approved: opts.pre_approved,
        origin_ring: opts.origin_ring,
        actor: opts.actor,
        _sagaId: sagaId,
      });
      results.push(res);
      if (res.status === 'failed') { aborted_at = traceId; break; }
    }

    if (this.sagas && sagaId) {
      if (aborted_at) {
        this.safeTransition(opts.orgId, sagaId, 'COMPENSATING');
        this.safeTransition(opts.orgId, sagaId, 'FAILED');
      } else {
        this.safeTransition(opts.orgId, sagaId, 'COMPLETED');
      }
    }

    this.audit.log({
      org_id: opts.orgId,
      action: 'rollback.delegation',
      resource_type: 'delegation',
      resource_id: opts.delegation_id,
      user_id:    opts.actor?.user_id,
      user_email: opts.actor?.user_email,
      ip_address: opts.actor?.ip_address,
      details: {
        delegation_id: opts.delegation_id,
        scanned: rows.length,
        rolled_back: results.filter(r => r.status === 'rolled_back').length,
        unsupported: results.filter(r => r.status === 'unsupported').length,
        failed:      results.filter(r => r.status === 'failed').length,
        pending_approval: results.filter(r => r.status === 'pending_approval').length,
        aborted_at,
        dry_run: !!opts.dry_run,
      },
    });

    return {
      delegation_id: opts.delegation_id,
      scanned: rows.length,
      results,
      aborted_at,
      saga_id: sagaId,
    };
  }

  /**
   * Saga-style chain. Walks the agent's traces in reverse chronological
   * order from `since` (exclusive, ISO timestamp) and fires each
   * compensator. Aborts on first failure — subsequent traces stay
   * un-rolled-back; the audit summary carries the abort cursor.
   */
  async rollbackChain(opts: { orgId: string } & ChainOptions): Promise<ChainResult> {
    const limit = opts.max ?? 200;
    const rows = this.db.prepare(
      `SELECT trace_id, parent_trace_id, timestamp FROM traces
        WHERE agent_id = ? AND timestamp > ? AND rolled_back_at IS NULL
        ORDER BY timestamp DESC LIMIT ?`,
    ).all(opts.agent_id, opts.since, limit) as TraceForRollback[];

    // Causal-DAG ordering (SagaGuard 2026 pattern) — children roll
    // back before parents, siblings by newest-first. Falls back to
    // reverse-time when there's no dependency signal.
    const orderedTraceIds = topologicalRollbackOrder(
      rows,
      this.collectExtraDeps(rows.map(r => r.trace_id)),
      (w) => this.logger.warn({ ...w }, 'causal-rollback: ordering degraded'),
    );

    // Open one saga that all rollback() calls in this chain belong to.
    let sagaId: string | undefined;
    if (this.sagas) {
      sagaId = this.sagas.open({
        orgId: opts.orgId,
        kind: 'rollback_chain',
        agent_id: opts.agent_id,
        root_trace_id: orderedTraceIds[0] ?? null,
        reason: opts.reason ?? null,
        origin_ring: opts.origin_ring ?? 2,
      });
      this.safeTransition(opts.orgId, sagaId, 'EXECUTING');
    }

    const results: RollbackResult[] = [];
    let aborted_at: string | undefined;
    for (const traceId of orderedTraceIds) {
      const res = await this.rollback({
        orgId: opts.orgId,
        trace_id: traceId,
        reason: opts.reason,
        dry_run: opts.dry_run,
        force_correction: opts.force_correction,
        actor: opts.actor,
        _sagaId: sagaId,
      });
      results.push(res);
      if (res.status === 'failed') { aborted_at = traceId; break; }
    }

    // Close the saga at the right terminal state.
    if (this.sagas && sagaId) {
      if (aborted_at) {
        this.safeTransition(opts.orgId, sagaId, 'COMPENSATING');
        this.safeTransition(opts.orgId, sagaId, 'FAILED');
      } else {
        this.safeTransition(opts.orgId, sagaId, 'COMPLETED');
      }
    }

    this.audit.log({
      org_id: opts.orgId,
      action: 'rollback.chain',
      resource_type: 'agent',
      resource_id: opts.agent_id,
      user_id:    opts.actor?.user_id,
      user_email: opts.actor?.user_email,
      ip_address: opts.actor?.ip_address,
      details: {
        since: opts.since,
        scanned: rows.length,
        rolled_back: results.filter(r => r.status === 'rolled_back').length,
        unsupported: results.filter(r => r.status === 'unsupported').length,
        failed: results.filter(r => r.status === 'failed').length,
        aborted_at,
        dry_run: !!opts.dry_run,
      },
    });

    return { agent_id: opts.agent_id, scanned: rows.length, results, aborted_at, saga_id: sagaId };
  }

  // ── helpers ───────────────────────────────────────────────────────

  /**
   * Look up any explicit `depends_on` edges already stored on
   * saga_step for these trace_ids. Only saga_steps whose depends_on
   * is populated are relevant — most trace batches will return an
   * empty map, and rollback then falls back to parent_trace_id
   * (implicit causality) plus timestamp tiebreak.
   */
  private collectExtraDeps(traceIds: string[]): Map<string, string[]> {
    if (traceIds.length === 0) return new Map();
    // Bound the IN clause defensively — SQLite has a limit on
    // parameter counts (~999 by default). We chunk if needed.
    const CHUNK = 500;
    const rows: Array<{ trace_id: string; depends_on: string | null }> = [];
    for (let i = 0; i < traceIds.length; i += CHUNK) {
      const slice = traceIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      try {
        const got = this.db.prepare(
          `SELECT trace_id, depends_on FROM saga_step
            WHERE depends_on IS NOT NULL
              AND trace_id IN (${placeholders})`,
        ).all(...slice) as Array<{ trace_id: string; depends_on: string | null }>;
        rows.push(...got);
      } catch (err: any) {
        // Older DBs may not have the depends_on column yet — safe fallback.
        if (!/no such column|no such table/i.test(err?.message ?? '')) {
          this.logger.warn({ err: err?.message }, 'depends_on lookup failed');
        }
      }
    }
    return parseDepends(rows);
  }

  private getTrace(traceId: string): TraceRow | null {
    return this.db.prepare(
      `SELECT trace_id, agent_id, timestamp, tool_call, observation,
              integrity_hash, rolled_back_at, reversibility_class,
              workflow_node_id, workflow_binding_id
         FROM traces WHERE trace_id = ?`,
    ).get(traceId) as TraceRow | null;
  }

  private renderPlan(
    compensator: CompensatorDecl,
    trace: TraceRow,
    toolCall: { tool_name?: string; arguments?: Record<string, unknown> },
  ): unknown {
    // Look up pre-state snapshot if SnapshotCapture is wired in.
    // The snapshot was captured BEFORE the tool executed and stores
    // whatever the operator's bridge said the affected state was
    // (DB row, file bytes, external object). Feeding it into the
    // compensator gives the operator the "before" picture to restore.
    const snapshot: SnapshotRow | null = this.snapshots?.get(trace.trace_id) ?? null;

    switch (compensator.kind) {
      case 'webhook':
        return {
          kind: 'webhook',
          url: compensator.url,
          payload: {
            trace_id: trace.trace_id,
            agent_id: trace.agent_id,
            tool_name: toolCall.tool_name,
            arguments: toolCall.arguments,
            observation: safeJson(trace.observation),
            timestamp: trace.timestamp,
            // pre_state is the captured snapshot's payload; hash +
            // capture_kind let the compensator verify it hasn't been
            // tampered with (re-hash and compare).
            pre_state:    snapshot?.snapshot_data ?? null,
            pre_state_hash:  snapshot?.hash ?? null,
            capture_kind: snapshot?.kind ?? null,
          },
        };
      case 'inline': {
        const rendered = CompensationRegistry.renderTemplate(compensator.template, {
          trace: { ...trace, tool_call: toolCall, pre_state: snapshot?.snapshot_data },
        });
        return { kind: 'inline', target: compensator.target, command: rendered };
      }
      case 'none':
        return { kind: 'correction-only', note: compensator.note };
    }
  }

  private async executeCompensator(compensator: CompensatorDecl, plan: any): Promise<void> {
    switch (compensator.kind) {
      case 'webhook':
        // Idempotency key = trace_id ensures the operator's webhook
        // can dedup across all attempts (including the post-DLQ retry).
        return this.runWebhook(compensator, plan.payload, plan.payload?.trace_id ?? 'unknown');
      case 'inline':
        // V1: we deliberately don't ship an in-gateway shell/SQL
        // executor — that would create new attack surface (the
        // gateway with privileged DB creds running model-influenced
        // statements). Operators who need inline-style behaviour
        // bridge through their own webhook. The declaration still
        // makes it into the audit/Merkle receipt.
        this.logger.warn({ template: compensator.template }, 'inline compensator declared but not executed (v1: webhook only)');
        throw new Error('inline compensator execution not yet supported; use kind:webhook');
      case 'none':
        return;
    }
  }

  /**
   * Exponential-backoff webhook with jitter, idempotency key, and
   * per-attempt header. Each attempt sends:
   *   - `Idempotency-Key: <trace_id>` (constant — dedup at the
   *      operator's side across attempts)
   *   - `X-AEGIS-Attempt: <n>` (1..max)
   *
   * Backoff schedule (default base 250ms, factor 2, jitter ±20%):
   *   attempt 1: fire immediately
   *   attempt 2: 250ms ± 50ms
   *   attempt 3: 500ms ± 100ms
   *   attempt 4: 1000ms ± 200ms
   *   ...
   *
   * Throws after `max` attempts; the caller decides whether to DLQ.
   */
  private async runWebhook(
    c: { url: string; authorization?: string; timeout_ms?: number; retries?: number },
    body: unknown,
    idempotencyKey: string,
  ): Promise<void> {
    const max = (c.retries ?? 2) + 1;
    const baseMs = 250;
    let lastErr: any;
    for (let attempt = 1; attempt <= max; attempt++) {
      if (attempt > 1) {
        const back = baseMs * Math.pow(2, attempt - 2);
        const jitter = (Math.random() * 0.4 - 0.2) * back;   // ±20%
        await new Promise(r => setTimeout(r, Math.max(0, back + jitter)));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), c.timeout_ms ?? 5000);
      try {
        const r = await fetch(c.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'X-AEGIS-Attempt': String(attempt),
            ...(c.authorization ? { 'Authorization': c.authorization } : {}),
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`webhook returned ${r.status}: ${text.slice(0, 200)}`);
        }
        return;   // success
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt === max) break;
      }
    }
    throw lastErr ?? new Error('webhook failed with unknown error');
  }
}

function safeJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
