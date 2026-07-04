/**
 * Compensator: postgres.insert / postgres.update / postgres.delete
 *
 * Restores the `pre_state` snapshot captured by AEGIS SnapshotCapture
 * before the original write executed. Runs in a single transaction so
 * either the entire restore succeeds or nothing changes.
 *
 * Requires: SnapshotCaptureService must have been enabled + configured
 * to capture pre-state for the target table (tenant_config.rollback.snapshots).
 *
 * Cost-estimate hint:
 *   magnitude: low        — pure row-level restore, no side effects
 */

import type { Pool } from 'pg';   // npm i pg
import type { IncomingMessage, ServerResponse } from 'http';

interface RollbackWebhookBody {
  trace_id: string;
  agent_id: string;
  tool_name: string;
  arguments: {
    table?: string;
    sql?: string;
    row_id?: string | number;
    /** Whatever the agent originally wrote — used to identify the row. */
    values?: Record<string, unknown>;
  };
  pre_state: {
    /** The pre-write row, keyed by column. When null, the row did not
     *  exist before — compensation is a DELETE. */
    row: Record<string, unknown> | null;
    /** Table + primary key so the handler knows what to touch. */
    table: string;
    pk_column: string;
    pk_value:  string | number;
  } | null;
  pre_state_hash?: string;
  timestamp: string;
}

/**
 * @param body Rollback webhook payload from the gateway.
 * @param idempotencyKey  Stable across retries — used to dedupe against
 *                        a local `compensation_log` table.
 * @param pool            A pg.Pool for the target database.
 */
export async function handlePostgresRollback(
  body: RollbackWebhookBody,
  idempotencyKey: string,
  pool: Pool,
): Promise<{ status: 'ok' | 'no_op'; action: 'restore' | 'delete' | 'no_snapshot' | 'already_done' }> {
  if (!body.pre_state) {
    return { status: 'no_op', action: 'no_snapshot' };
  }
  const { table, pk_column, pk_value, row } = body.pre_state;

  // Idempotency guard — one compensation per (trace_id).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS compensation_log (
         idempotency_key TEXT PRIMARY KEY,
         trace_id        TEXT NOT NULL,
         action          TEXT NOT NULL,
         acted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const existing = await client.query(
      `SELECT action FROM compensation_log WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('COMMIT');
      return { status: 'ok', action: 'already_done' };
    }

    if (row === null) {
      // No pre-state row — the original write was an INSERT. Undo = DELETE.
      await client.query(
        `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pk_column)} = $1`,
        [pk_value],
      );
      await client.query(
        `INSERT INTO compensation_log (idempotency_key, trace_id, action) VALUES ($1, $2, $3)`,
        [idempotencyKey, body.trace_id, 'delete'],
      );
      await client.query('COMMIT');
      return { status: 'ok', action: 'delete' };
    }

    // Restore the pre-write row via UPSERT (INSERT … ON CONFLICT DO UPDATE).
    const cols = Object.keys(row);
    const vals = cols.map(c => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const setClause = cols
      .filter(c => c !== pk_column)
      .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(', ');
    await client.query(
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')})
         VALUES (${placeholders})
         ON CONFLICT (${quoteIdent(pk_column)})
         DO UPDATE SET ${setClause}`,
      vals,
    );
    await client.query(
      `INSERT INTO compensation_log (idempotency_key, trace_id, action) VALUES ($1, $2, $3)`,
      [idempotencyKey, body.trace_id, 'restore'],
    );
    await client.query('COMMIT');
    return { status: 'ok', action: 'restore' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Naive but safe identifier quoter. Rejects anything that isn't a
// [A-Za-z0-9_] identifier so the caller can't smuggle SQL fragments
// via table / column names originally sourced from an LLM.
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

// ── Example Express handler ──────────────────────────────────────────

export function createExpressHandler(pool: Pool) {
  return async (req: IncomingMessage & { body: RollbackWebhookBody }, res: ServerResponse) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string
                          ?? (req.body?.trace_id ?? 'no-key');
      const result = await handlePostgresRollback(req.body, idempotencyKey, pool);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err?.message ?? 'postgres rollback failed' }));
    }
  };
}
