/**
 * Trace chain heads anchored in the transparency log. A chain that is
 * rewritten wholesale still links; one cut short at the head has nothing
 * left to break. Both verified clean before anchoring and both are caught
 * after it.
 */
import pino from 'pino'
import { createHash } from 'crypto'
import { initializeDatabase } from '../db/database'
import { initializeEnterpriseSchema } from '../db/enterprise-schema'
import { SigningService } from '../services/signing'
import { TransparencyLogService } from '../services/transparency-log'
import { ChainAnchorService } from '../services/chain-anchor'
import { IntegrityService } from '../services/integrity'

const silent = pino({ level: 'silent' })
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function setup() {
  const db = await initializeDatabase(':memory:'); initializeEnterpriseSchema(db)
  const log = new TransparencyLogService(db, new SigningService(db, silent), silent)
  const anchors = new ChainAnchorService(db, log, silent)
  return { db, log, anchors, integrity: new IntegrityService(db, silent, anchors) }
}

/** Writes a linked chain for `agent`; `salt` changes every hash, as a rewrite would. */
function writeChain(db: any, agent: string, n: number, salt = '') {
  db.prepare('DELETE FROM traces WHERE agent_id = ?').run(agent)
  let prev: string | null = null
  for (let i = 0; i < n; i++) {
    const h = sha(`${agent}:${i}:${salt}`)
    db.prepare(`INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain,
                tool_call, observation, integrity_hash, previous_hash, environment, version)
                VALUES (?, ?, datetime('now'), ?, '{}', '{}', '{}', '{}', ?, ?, 'TEST', '1')`)
      .run(`${agent}-${i}-${salt}`, agent, i, h, prev)
    prev = h
  }
}

describe('chain anchors', () => {
  test('anchoring is idempotent and follows the head', async () => {
    const { db, anchors } = await setup()
    writeChain(db, 'a1', 3)
    expect(anchors.anchorAll().anchored).toBe(1)
    expect(anchors.anchorAll().anchored).toBe(0)
    db.prepare(`INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain,
                tool_call, observation, integrity_hash, previous_hash, environment, version)
                VALUES ('a1-3', 'a1', datetime('now'), 3, '{}', '{}', '{}', '{}', ?, ?, 'TEST', '1')`)
      .run(sha('a1:3:'), sha('a1:2:'))
    expect(anchors.anchorAll().anchored).toBe(1)
  })

  test('a wholesale rewrite links, and the anchor catches it', async () => {
    const { db, anchors, integrity } = await setup()
    writeChain(db, 'a2', 4)
    expect(integrity.verifyAgentChain('a2').ok).toBe(true)
    anchors.anchorAll()
    writeChain(db, 'a2', 4, 'rewritten')        // every hash recomputed, links intact
    const r = integrity.verifyAgentChain('a2')
    expect(r.ok).toBe(false); expect(r.broken_at?.reason).toBe('anchor_mismatch'); expect(r.broken_at?.sequence_number).toBe(3)
  })

  test('cutting records off the head is caught', async () => {
    const { db, anchors, integrity } = await setup()
    writeChain(db, 'a3', 5)
    anchors.anchorAll()
    db.prepare('DELETE FROM traces WHERE agent_id = ? AND sequence_number >= 3').run('a3')
    const r = integrity.verifyAgentChain('a3')
    expect(r.ok).toBe(false); expect(r.broken_at?.reason).toBe('anchor_missing')
  })

  test('editing the log entry itself is caught', async () => {
    const { db, anchors, integrity } = await setup()
    writeChain(db, 'a4', 2)
    anchors.anchorAll()
    db.prepare(`UPDATE transparency_log SET payload = REPLACE(payload, ?, ?)`).run(sha('a4:1:'), sha('forged'))
    expect(integrity.verifyAgentChain('a4').broken_at?.reason).toBe('anchor_mismatch')
  })

  test('records purged from the old end by retention are not a break', async () => {
    const { db, anchors, integrity } = await setup()
    writeChain(db, 'a5', 3)
    anchors.anchorAll()                                // anchors sequence 2
    db.prepare(`INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain,
                tool_call, observation, integrity_hash, previous_hash, environment, version)
                VALUES ('a5-3', 'a5', datetime('now'), 3, '{}', '{}', '{}', '{}', ?, ?, 'TEST', '1')`)
      .run(sha('a5:3:'), sha('a5:2:'))
    anchors.anchorAll()                                // anchors sequence 3
    db.prepare('DELETE FROM traces WHERE agent_id = ? AND sequence_number <= 2').run('a5')
    expect(integrity.verifyAgentChain('a5').ok).toBe(true)
  })

  test('replacing the anchored history with a new chain further on is caught', async () => {
    const { db, anchors, integrity } = await setup()
    writeChain(db, 'a6', 3)
    anchors.anchorAll()
    db.prepare('DELETE FROM traces WHERE agent_id = ?').run('a6')
    for (let i = 10; i < 12; i++) {
      db.prepare(`INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain,
                  tool_call, observation, integrity_hash, previous_hash, environment, version)
                  VALUES (?, 'a6', datetime('now'), ?, '{}', '{}', '{}', '{}', ?, ?, 'TEST', '1')`)
        .run(`a6-${i}`, i, sha(`x${i}`), i === 10 ? null : sha(`x${i - 1}`))
    }
    expect(integrity.verifyAgentChain('a6').broken_at?.reason).toBe('anchor_missing')
  })
})
