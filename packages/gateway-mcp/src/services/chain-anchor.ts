/**
 * Trace chain heads, anchored in the transparency log.
 *
 * A hash chain detects an edit only to someone who did not also rewrite
 * the rest of the chain: with write access to the database, every record
 * after the edit can be re-hashed and the chain verifies again. Deleting
 * records from the head of a chain is not even an edit. Periodically
 * appending each agent's latest (sequence, hash) to the transparency log —
 * a Merkle log whose signed roots external witnesses countersign — fixes
 * a point the operator cannot quietly move: verification compares the
 * record now at that sequence with the hash the log committed to.
 *
 * The expected hash is read from the log entry, not from this service's
 * own index table: the table only says which log entry to read.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { hashLeaf } from './merkle';
import type { TransparencyLogService } from './transparency-log';

export interface AnchorBreak {
  reason: 'anchor_mismatch' | 'anchor_missing';
  sequence_number: number;
  log_index: number;
  expected: string;
  actual: string;
}

export class ChainAnchorService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private log: TransparencyLogService,
    private logger?: Logger,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_chain_anchors (
        agent_id        TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        log_index       INTEGER NOT NULL,
        anchored_at     TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, sequence_number)
      );
    `);
  }

  /** Anchor every agent whose head moved since its last anchor. */
  anchorAll(): { anchored: number } {
    const heads = this.db.prepare(
      `SELECT t.agent_id, t.sequence_number, t.integrity_hash, t.org_id,
              (SELECT COUNT(*) FROM traces c WHERE c.agent_id = t.agent_id) AS n
         FROM traces t
        WHERE t.sequence_number = (SELECT MAX(sequence_number) FROM traces m WHERE m.agent_id = t.agent_id)`,
    ).all() as Array<{ agent_id: string; sequence_number: number; integrity_hash: string; org_id: string | null; n: number }>;
    const seen = this.db.prepare(`SELECT 1 FROM trace_chain_anchors WHERE agent_id = ? AND sequence_number = ?`);
    const put = this.db.prepare(`INSERT INTO trace_chain_anchors (agent_id, sequence_number, log_index) VALUES (?, ?, ?)`);
    let anchored = 0;
    for (const h of heads) {
      if (seen.get(h.agent_id, h.sequence_number)) continue;
      const { index } = this.log.append({
        source: 'trace-chain',
        org_id: h.org_id ?? undefined,
        payload: { kind: 'trace_chain_head', agent_id: h.agent_id, sequence_number: h.sequence_number,
                   integrity_hash: h.integrity_hash, traces: h.n },
      });
      put.run(h.agent_id, h.sequence_number, index);
      anchored++;
    }
    if (anchored) this.logger?.info({ anchored }, 'trace chain heads anchored in the transparency log');
    return { anchored };
  }

  start(intervalMs: number): void {
    try { this.anchorAll(); } catch (err) { this.logger?.warn({ err: (err as Error).message }, 'chain anchoring failed'); }
    this.timer = setInterval(() => {
      try { this.anchorAll(); } catch (err) { this.logger?.warn({ err: (err as Error).message }, 'chain anchoring failed'); }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The first anchor of this agent that the stored chain contradicts. */
  check(agentId: string, hashBySequence: Map<number, string>): AnchorBreak | null {
    const anchors = this.db.prepare(
      `SELECT sequence_number, log_index FROM trace_chain_anchors WHERE agent_id = ? ORDER BY sequence_number`,
    ).all(agentId) as Array<{ sequence_number: number; log_index: number }>;
    // Retention purges the oldest records, and the chain stays verifiable
    // from the first one kept; an anchor below that point is history the
    // operator's retention policy removed, not a break.
    const firstKept = Math.min(...hashBySequence.keys());
    // The newest anchor is always checked: retention removes the oldest
    // records by age and never the head, so a chain that no longer
    // reaches its newest anchor was cut, or replaced, not purged.
    for (const [i, a] of anchors.entries()) {
      if (a.sequence_number < firstKept && i < anchors.length - 1) continue;
      const entry = this.log.getEntry(a.log_index);
      // The leaf must still hash to what the log recorded (the signed
      // roots, which witnesses hold, are over these leaf hashes).
      if (!entry || hashLeaf(Buffer.from(entry.payload, 'utf8')).toString('hex') !== entry.leaf_hash) {
        return { reason: 'anchor_mismatch', sequence_number: a.sequence_number, log_index: a.log_index,
                 expected: entry?.leaf_hash ?? '(log entry missing)', actual: '(log entry altered)' };
      }
      const expected = String(JSON.parse(entry.payload).integrity_hash ?? '');
      const actual = hashBySequence.get(a.sequence_number);
      if (actual === undefined) {
        return { reason: 'anchor_missing', sequence_number: a.sequence_number, log_index: a.log_index, expected, actual: '' };
      }
      if (actual !== expected) {
        return { reason: 'anchor_mismatch', sequence_number: a.sequence_number, log_index: a.log_index, expected, actual };
      }
    }
    return null;
  }
}
