/**
 * The effect outbox and pre-state snapshots, wired to /check (both were
 * implemented and never called before 2026-10-26). An allowed call to a
 * tool the tenant routed through the outbox is queued, answered in a shape
 * no SDK will run, dispatched by the gateway with its arguments intact,
 * and cancellable before then; a held call that a person allows goes the
 * same way. A tool configured for snapshots has its pre-state stored,
 * keyed by check id, before the agent is told to proceed.
 */
import express from 'express'
import http from 'http'
import pino from 'pino'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initializeDatabase } from '../db/database'
import { initializeEnterpriseSchema } from '../db/enterprise-schema'
import { PolicyEngine } from '../policies/policy-engine'
import { CheckAPI } from '../api/check'
import { SigningService } from '../services/signing'
import { ReceiptService } from '../services/receipts'
import { AuditLogService } from '../services/audit-log'
import { TransparencyLogService } from '../services/transparency-log'
import { EffectOutboxService } from '../services/effect-outbox'
import { SnapshotCaptureService } from '../services/snapshot-capture'

const silent = pino({ level: 'silent' })

describe('outbox and snapshots on the allow path', () => {
  let app: Server, sink: Server, base = '', db: any, outbox: EffectOutboxService, snaps: SnapshotCaptureService
  const received: any[] = []
  beforeAll(async () => {
    sink = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push(JSON.parse(b)); res.end('{}') }) })
    await new Promise<void>((r) => sink.listen(0, () => r()))
    db = await initializeDatabase(':memory:'); initializeEnterpriseSchema(db)
    const signing = new SigningService(db, silent)
    outbox = new EffectOutboxService(db, silent, new AuditLogService(db, silent), new TransparencyLogService(db, signing, silent))
    outbox.setConfig('default', { tools: { publish_post: { delay_seconds: 0,
      dispatch_url: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/fire` },
      send_email: { delay_seconds: 300, dispatch_url: 'http://127.0.0.1:9/never' } } })
    snaps = new SnapshotCaptureService(db, silent)
    snaps.setConfig('default', { snapshots: { update_row: { kind: 'inline_args' } } } as any)
    const e = express(); e.use(express.json())
    e.use('/api/v1/check', new CheckAPI(db, new PolicyEngine(db, silent), silent, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, new ReceiptService(signing), undefined, snaps, outbox).router)
    app = await new Promise<Server>((r) => { const s = e.listen(0, () => r(s)) })
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/v1/check`
  })
  afterAll(async () => {
    await new Promise<void>((r) => app.close(() => r())); await new Promise<void>((r) => sink.close(() => r()))
  })
  const check = (body: any) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }).then((r) => r.json() as any)

  test('an outbox tool is queued, not run by the agent, and dispatched with its arguments', async () => {
    const args = { channel: 'blog', text: 'Q3 is up' }
    const r = await check({ agent_id: 'poster', tool_name: 'publish_post', arguments: args })
    expect(r.decision).toBe('block')                // no SDK runs it itself
    expect(r.category).toBe('queued-in-outbox')
    expect(r.reason).toMatch(/^Queued, not refused/)
    expect(r.queued.outbox_id).toBeGreaterThan(0)
    await outbox.dispatchOne(r.queued.outbox_id)
    expect(received.at(-1)).toMatchObject({ tool_name: 'publish_post', arguments: args, check_id: r.check_id })
  })

  test('a queued call can be cancelled before dispatch, with no side effect', async () => {
    const before = received.length
    const r = await check({ agent_id: 'poster', tool_name: 'publish_post', arguments: { text: 'oops' } })
    expect(outbox.cancel({ orgId: 'default', trace_id: r.check_id }).ok).toBe(true)
    const row = db.prepare('SELECT status FROM effect_outbox WHERE trace_id = ?').get(r.check_id)
    expect(row.status).toBe('cancelled')
    expect(outbox.due(new Date(Date.now() + 3600e3).toISOString()).some((x: any) => x.trace_id === r.check_id)).toBe(false)
    expect(received.length).toBe(before)
  })

  test('a held call a person allows is queued once, however often the agent polls', async () => {
    const r = await check({ agent_id: 'mailer', tool_name: 'send_email', arguments: { to: 'bob@acme.example' }, blocking: true })
    expect(r.decision).toBe('pending')
    await fetch(`${base}/${r.check_id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', decided_by: 'alice' }) })
    const a = await fetch(`${base}/${r.check_id}/decision`).then((x) => x.json() as any)
    const b = await fetch(`${base}/${r.check_id}/decision`).then((x) => x.json() as any)
    expect(a.category).toBe('queued-in-outbox'); expect(a.decided_by).toBe('alice')
    expect(b.queued.outbox_id).toBe(a.queued.outbox_id)
    expect(db.prepare('SELECT COUNT(*) n FROM effect_outbox WHERE trace_id = ?').get(r.check_id).n).toBe(1)
  })

  test('a snapshot tool has its pre-state stored under the check id before the allow', async () => {
    const args = { table: 'accounts', id: 7, balance: 0 }
    const r = await check({ agent_id: 'ops', tool_name: 'update_row', arguments: args })
    expect(r.decision).toBe('allow')
    expect(snaps.get(r.check_id)).toMatchObject({ kind: 'inline_args', snapshot_data: args })
  })

  test('an unconfigured tool is untouched', async () => {
    const r = await check({ agent_id: 'ops', tool_name: 'run_query', arguments: { q: 'SELECT 1' } })
    expect(r.decision).toBe('allow'); expect(r.queued).toBeUndefined(); expect(snaps.get(r.check_id)).toBeNull()
  })
})
