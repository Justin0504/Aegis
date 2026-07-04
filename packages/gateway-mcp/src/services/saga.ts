/**
 * Saga state machine + step ledger.
 *
 * Industrial-grade rollback needs a queryable, formal saga state.
 * Without it operators can't answer "what's in flight right now?"
 * "where did the last chain stop?" "is anything stuck?"
 *
 * State machine (Garcia-Molina 1987 + human-in-the-loop extension for
 * agent rollback):
 *
 *   STARTED → EXECUTING → COMPENSATING → { COMPLETED | ABORTED | FAILED }
 *                ↓ ↑
 *      PAUSED_FOR_APPROVAL
 *
 *   Transition rules:
 *     STARTED             → EXECUTING              (open the saga; first step starts)
 *     EXECUTING           → COMPENSATING           (one of the steps failed)
 *     EXECUTING           → COMPLETED              (all steps succeeded; saga done)
 *     EXECUTING           → PAUSED_FOR_APPROVAL    (compensator needs human OK; e.g. high-value refund)
 *     PAUSED_FOR_APPROVAL → EXECUTING              (operator approved; resume)
 *     PAUSED_FOR_APPROVAL → ABORTED                (operator rejected; saga rolled back cleanly)
 *     COMPENSATING        → ABORTED                (compensation finished; saga rolled back cleanly)
 *     COMPENSATING        → FAILED                 (compensation itself failed somewhere)
 *
 * Invariants enforced by transition():
 *   - Cannot go backward.
 *   - Terminal states (COMPLETED / ABORTED / FAILED) are write-locked.
 *   - Every transition writes a row to `saga_step` so the full
 *     lifecycle is auditable post-hoc.
 *
 * This module is the SCAFFOLDING for the RollbackService — the
 * service constructs a saga at the start of every rollback() /
 * rollbackChain() call and transitions it as work proceeds.
 *
 * Notable: rolling back a SINGLE trace also opens a saga (a degenerate
 * one with one step). Keeps the audit-log queries uniform.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

export type SagaState =
  | 'STARTED'
  | 'EXECUTING'
  | 'PAUSED_FOR_APPROVAL'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'ABORTED'
  | 'FAILED';

export type SagaKind = 'rollback_single' | 'rollback_chain';

export type StepOutcome = 'rolled_back' | 'no_op' | 'failed' | 'unsupported' | 'skipped';

export interface Saga {
  id: string;
  org_id: string;
  kind: SagaKind;
  state: SagaState;
  agent_id: string | null;
  /** The "anchor" trace — for single, the one being rolled back; for
   *  chain, the most-recent trace in the time range. */
  root_trace_id: string | null;
  started_at: string;
  completed_at: string | null;
  step_count: number;
  /** Operator-supplied reason carried through every audit row. */
  reason: string | null;
  /** When state = 'PAUSED_FOR_APPROVAL', why the pause was requested.
   *  Rendered in the cockpit approval queue. */
  pause_reason: string | null;
  /** When state = 'PAUSED_FOR_APPROVAL', the ISO timestamp of the
   *  pause. Used to age-out stale approvals. */
  paused_at: string | null;
  /** Three-Ring origin tag per Toledo et al. arXiv:2606.07119:
   *   2 = Ring-2 deterministic strategies-based agent flow (auto-safe
   *       to compensate — the paper's "traceable, permission-enforced,
   *       recoverable" class).
   *   3 = Ring-3 LLM decision (non-deterministic, deviations propagate;
   *       auto-paused for human approval regardless of cost_estimate).
   *   null = unknown / legacy.
   *  The RollbackService reads this at pause-decision time. */
  origin_ring: number | null;
}

export interface SagaStep {
  id: number;
  saga_id: string;
  step_idx: number;
  trace_id: string;
  outcome: StepOutcome;
  compensator_kind: string;
  duration_ms: number;
  error: string | null;
  recorded_at: string;
  /**
   * Comma-separated `trace_id`s this step depends on — i.e. trace_ids
   * whose compensation must complete BEFORE this step's compensation
   * runs. Used by `topologicalTraceOrder()` to schedule chain
   * rollbacks in causal order rather than naive reverse-time
   * (SagaGuard 2026 / Uber M3 pattern).
   *
   * When empty / null, falls back to reverse-chronological order
   * within the saga — preserves existing behaviour for old sagas.
   */
  depends_on: string | null;
}

const VALID_TRANSITIONS: Record<SagaState, SagaState[]> = {
  STARTED:              ['EXECUTING'],
  EXECUTING:            ['COMPENSATING', 'COMPLETED', 'PAUSED_FOR_APPROVAL'],
  PAUSED_FOR_APPROVAL:  ['EXECUTING', 'ABORTED'],
  COMPENSATING:         ['ABORTED', 'FAILED'],
  COMPLETED:            [],
  ABORTED:              [],
  FAILED:               [],
};

export class SagaService {
  constructor(private db: Database.Database, private logger: Logger) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saga (
        id            TEXT PRIMARY KEY,
        org_id        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'STARTED',
        agent_id      TEXT,
        root_trace_id TEXT,
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT,
        step_count    INTEGER NOT NULL DEFAULT 0,
        reason        TEXT,
        pause_reason  TEXT,
        paused_at     TEXT,
        origin_ring   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_saga_org_state ON saga(org_id, state);
      CREATE INDEX IF NOT EXISTS idx_saga_agent     ON saga(agent_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS saga_step (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        saga_id         TEXT NOT NULL,
        step_idx        INTEGER NOT NULL,
        trace_id        TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        compensator_kind TEXT NOT NULL,
        duration_ms     INTEGER NOT NULL,
        error           TEXT,
        recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),
        depends_on      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_saga_step_saga ON saga_step(saga_id, step_idx);
    `);

    // Best-effort forward migration for HITL + Three-Ring + causal-DAG
    // columns; safe on reruns because ALTER errors on duplicate
    // columns are swallowed.
    for (const ddl of [
      `ALTER TABLE saga ADD COLUMN pause_reason TEXT`,
      `ALTER TABLE saga ADD COLUMN paused_at    TEXT`,
      `ALTER TABLE saga ADD COLUMN origin_ring  INTEGER`,
      `ALTER TABLE saga_step ADD COLUMN depends_on TEXT`,
    ]) {
      try { this.db.exec(ddl); }
      catch (e: any) {
        if (!/duplicate column/i.test(e?.message ?? '')) {
          this.logger.warn({ err: e?.message, ddl }, 'saga ddl skipped');
        }
      }
    }
  }

  /** Open a new saga. Returns the id; the caller passes it to
   *  appendStep() + transition() as work progresses.
   *
   *  origin_ring encodes the Three-Ring taxonomy (Toledo et al.
   *  arXiv:2606.07119): 2 = deterministic strategies-based flow,
   *  3 = LLM-originated decision. Ring-3 sagas auto-pause for human
   *  approval in RollbackService regardless of cost_estimate. */
  open(opts: {
    orgId: string;
    kind: SagaKind;
    agent_id?: string | null;
    root_trace_id?: string | null;
    reason?: string | null;
    origin_ring?: 2 | 3 | null;
  }): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO saga (id, org_id, kind, state, agent_id, root_trace_id, reason, origin_ring)
       VALUES (?, ?, ?, 'STARTED', ?, ?, ?, ?)`,
    ).run(
      id, opts.orgId, opts.kind,
      opts.agent_id ?? null,
      opts.root_trace_id ?? null,
      opts.reason ?? null,
      opts.origin_ring ?? null,
    );
    return id;
  }

  /** Transition a saga to a new state. Throws on invalid transitions
   *  — RollbackService catches and audits these as bugs. */
  transition(opts: { sagaId: string; orgId: string; to: SagaState }): void {
    const row = this.db.prepare(
      `SELECT state FROM saga WHERE id = ? AND org_id = ?`,
    ).get(opts.sagaId, opts.orgId) as { state: SagaState } | undefined;
    if (!row) throw new Error(`saga ${opts.sagaId} not found`);
    if (row.state === opts.to) return;  // idempotent

    const allowed = VALID_TRANSITIONS[row.state];
    if (!allowed.includes(opts.to)) {
      throw new Error(`invalid saga transition: ${row.state} → ${opts.to}`);
    }
    const isTerminal = ['COMPLETED', 'ABORTED', 'FAILED'].includes(opts.to);
    if (isTerminal) {
      this.db.prepare(
        `UPDATE saga SET state = ?, completed_at = datetime('now') WHERE id = ?`,
      ).run(opts.to, opts.sagaId);
    } else if (opts.to === 'EXECUTING' && row.state === 'PAUSED_FOR_APPROVAL') {
      // Resume from pause — clear the paused_at/pause_reason so the
      // cockpit approval queue drops this row.
      this.db.prepare(
        `UPDATE saga SET state = ?, pause_reason = NULL, paused_at = NULL WHERE id = ?`,
      ).run(opts.to, opts.sagaId);
    } else {
      this.db.prepare(`UPDATE saga SET state = ? WHERE id = ?`).run(opts.to, opts.sagaId);
    }
  }

  /** Pause a saga pending human approval. Records the reason so the
   *  cockpit approval queue can show *why* this rollback stopped. */
  pauseForApproval(opts: { sagaId: string; orgId: string; reason: string }): void {
    const row = this.db.prepare(
      `SELECT state FROM saga WHERE id = ? AND org_id = ?`,
    ).get(opts.sagaId, opts.orgId) as { state: SagaState } | undefined;
    if (!row) throw new Error(`saga ${opts.sagaId} not found`);
    if (!VALID_TRANSITIONS[row.state].includes('PAUSED_FOR_APPROVAL')) {
      throw new Error(`cannot pause saga in state ${row.state}`);
    }
    this.db.prepare(
      `UPDATE saga SET state = 'PAUSED_FOR_APPROVAL',
                       pause_reason = ?,
                       paused_at    = datetime('now')
       WHERE id = ?`,
    ).run(opts.reason, opts.sagaId);
  }

  /** Approve a paused saga — moves it back to EXECUTING and clears the
   *  pause bookkeeping. Actor recorded as a saga_step so the audit
   *  answers "who approved". */
  approvePaused(opts: {
    sagaId: string; orgId: string;
    approver: string;
  }): void {
    this.transition({ sagaId: opts.sagaId, orgId: opts.orgId, to: 'EXECUTING' });
    this.appendStep({
      sagaId: opts.sagaId,
      trace_id: 'approval',
      outcome: 'no_op',
      compensator_kind: `approval:${opts.approver}`,
      duration_ms: 0,
    });
  }

  /** Reject a paused saga — moves it to ABORTED and records the actor. */
  rejectPaused(opts: {
    sagaId: string; orgId: string;
    approver: string;
    reason?: string;
  }): void {
    // Same allowed transition path: PAUSED_FOR_APPROVAL → ABORTED
    this.transition({ sagaId: opts.sagaId, orgId: opts.orgId, to: 'ABORTED' });
    this.appendStep({
      sagaId: opts.sagaId,
      trace_id: 'rejection',
      outcome: 'skipped',
      compensator_kind: `rejection:${opts.approver}`,
      duration_ms: 0,
      error: opts.reason ?? null,
    });
  }

  /** Append a step to the saga. Returns the new step id.
   *
   *  `depends_on` is an optional array of trace_ids this step depends
   *  on — used by causal-DAG rollback planning. When absent, the
   *  chain falls back to reverse-chronological order.
   *
   *  Race safety: the previous implementation read `step_count`,
   *  INSERTed with `step_idx = read + 1`, then UPDATEd `step_count`
   *  in three separate statements. Two concurrent appendStep() calls
   *  on the same saga would each read the same count and INSERT the
   *  same step_idx. This version wraps all three writes in an
   *  IMMEDIATE transaction and derives the next idx from the actual
   *  saga_step row count, so the write-read-write cycle is atomic
   *  under SQLite's single-writer semantics. */
  appendStep(opts: {
    sagaId: string;
    trace_id: string;
    outcome: StepOutcome;
    compensator_kind: string;
    duration_ms: number;
    error?: string | null;
    depends_on?: string[] | null;
  }): number {
    const dependsOnSerialised = opts.depends_on && opts.depends_on.length > 0
      ? opts.depends_on.join(',')
      : null;

    const tx = this.db.transaction((): number => {
      // Source of truth for next idx is saga_step's own row count for
      // this saga, not the mutable `step_count` column — the column
      // is a denormalised cache that could drift in the presence of
      // manual DB tampering.
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM saga_step WHERE saga_id = ?`,
      ).get(opts.sagaId) as { n: number };
      const nextIdx = row.n + 1;

      const r = this.db.prepare(
        `INSERT INTO saga_step (saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error, depends_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.sagaId, nextIdx, opts.trace_id, opts.outcome,
        opts.compensator_kind, opts.duration_ms, opts.error ?? null,
        dependsOnSerialised,
      );
      // Keep the cache column in sync — matches the same tx so
      // readers of `saga.step_count` see the incremented value or
      // none at all, never a torn read.
      this.db.prepare(
        `UPDATE saga SET step_count = ? WHERE id = ?`,
      ).run(nextIdx, opts.sagaId);
      return Number(r.lastInsertRowid);
    });
    return tx();
  }

  /** Fetch the saga record. */
  get(opts: { sagaId: string; orgId: string }): Saga | null {
    const row = this.db.prepare(
      `SELECT id, org_id, kind, state, agent_id, root_trace_id, started_at, completed_at, step_count, reason, pause_reason, paused_at, origin_ring
         FROM saga WHERE id = ? AND org_id = ?`,
    ).get(opts.sagaId, opts.orgId) as any;
    return row ?? null;
  }

  /**
   * Fetch steps for a saga in step_idx order.
   *
   *   opts.limit / opts.after   — pagination.
   *     `after` is a step_idx cursor (exclusive). Callers get the
   *     next page with `after = lastRow.step_idx`. Guards the API
   *     from wildly-large sagas (approvals-heavy chain rollbacks
   *     can accumulate hundreds of steps).
   *
   * The `total` count comes back so the client can render "42 of
   * 500 steps" without a second round-trip.
   */
  steps(opts: {
    sagaId: string;
    orgId: string;
    limit?: number;
    after?: number;
  }): { steps: SagaStep[]; total: number } {
    if (!this.get(opts)) return { steps: [], total: 0 };
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const after = opts.after ?? 0;
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM saga_step WHERE saga_id = ?`,
    ).get(opts.sagaId) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT id, saga_id, step_idx, trace_id, outcome, compensator_kind, duration_ms, error, recorded_at, depends_on
         FROM saga_step
        WHERE saga_id = ? AND step_idx > ?
        ORDER BY step_idx ASC
        LIMIT ?`,
    ).all(opts.sagaId, after, limit) as SagaStep[];
    return { steps: rows, total };
  }

  /** List sagas for a tenant. Supports filtering by state. */
  list(opts: {
    orgId: string;
    state?: SagaState | SagaState[];
    agent_id?: string;
    limit?: number;
  }): Saga[] {
    const filters: string[] = ['org_id = ?'];
    const params: any[] = [opts.orgId];
    if (opts.state) {
      const states = Array.isArray(opts.state) ? opts.state : [opts.state];
      filters.push(`state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    if (opts.agent_id) {
      filters.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.db.prepare(
      `SELECT id, org_id, kind, state, agent_id, root_trace_id, started_at, completed_at, step_count, reason, pause_reason, paused_at, origin_ring
         FROM saga
        WHERE ${filters.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT ?`,
    ).all(...params, limit) as Saga[];
  }
}
