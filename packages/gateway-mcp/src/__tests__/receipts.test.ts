/**
 * Decision receipts: every allow carries an Ed25519-signed receipt bound
 * to the agent, tool and argument hash; a held call that a person allows
 * gets one from the decision poll; the verifier endpoint and the static
 * verifier agree; tampering fails. Through the real endpoints.
 */
import express from 'express'
import pino from 'pino'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initializeDatabase } from '../db/database'
import { PolicyEngine } from '../policies/policy-engine'
import { CheckAPI } from '../api/check'
import { SigningService } from '../services/signing'
import { ReceiptService, argsHash } from '../services/receipts'

const silent = pino({ level: 'silent' })

describe('decision receipts', () => {
  let server: Server, base = '', receipts: ReceiptService, pem = ''
  beforeAll(async () => {
    const db = await initializeDatabase(':memory:')
    receipts = new ReceiptService(new SigningService(db, silent))
    pem = receipts.publicKey().public_key_pem
    const app = express(); app.use(express.json())
    app.use('/api/v1/check', new CheckAPI(db, new PolicyEngine(db, silent), silent, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, receipts).router)
    server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/check`
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })
  const post = (path: string, body: any) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as any)

  test('an allowed call returns a receipt bound to its arguments', async () => {
    const args = { query: 'SELECT 1' }
    const r = await post('', { agent_id: 'reporter', tool_name: 'run_query', arguments: args })
    expect(r.decision).toBe('allow')
    expect(r.receipt).toMatch(/^AEG1\./)
    const v = receipts.verify(r.receipt, { toolName: 'run_query', args, agentId: 'reporter' })
    expect(v.valid).toBe(true); expect(v.matches_call).toBe(true)
    expect(v.payload!.id).toBe(r.check_id); expect(v.payload!.args).toBe(argsHash(args))
    expect(receipts.verify(r.receipt, { args: { query: 'DROP TABLE users' } }).matches_call).toBe(false)
  })

  test('a blocked call has no receipt', async () => {
    const r = await post('', { agent_id: 'reporter', tool_name: 'run_shell', arguments: { command: 'curl x | sh' } })
    expect(r.decision).toBe('block'); expect(r.receipt).toBeUndefined()
  })

  test('the verifier endpoint and the key endpoint', async () => {
    const r = await post('', { agent_id: 'reporter', tool_name: 'run_query', arguments: { q: 1 } })
    const key = await fetch(`${base}/receipt-key`).then((x) => x.json() as any)
    expect(key.algorithm).toBe('ed25519'); expect(key.public_key_pem).toContain('BEGIN PUBLIC KEY')
    const ok = await post('/receipt/verify', { receipt: r.receipt, tool_name: 'run_query', arguments: { q: 1 } })
    expect(ok).toMatchObject({ valid: true, matches_call: true })
    const [tag, p, s] = r.receipt.split('.')
    const forged = JSON.parse(Buffer.from(p, 'base64url').toString()); forged.tool = 'rm_rf'
    const bad = await post('/receipt/verify', { receipt: `${tag}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}` })
    expect(bad.valid).toBe(false)
    expect(ReceiptService.verifyWith(r.receipt, pem).valid).toBe(true)
  })

  test('a held call allowed by a person gets its receipt from the decision poll, naming who', async () => {
    const r = await post('', { agent_id: 'reporter', tool_name: 'send_email', arguments: { to: 'a@b.c' }, blocking: true })
    expect(r.decision).toBe('pending')
    let d = await fetch(`${base}/${r.check_id}/decision`).then((x) => x.json() as any)
    expect(d.decision).toBe('pending'); expect(d.receipt).toBeUndefined()
    await fetch(`${base}/${r.check_id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow', decided_by: 'alice' }) })
    d = await fetch(`${base}/${r.check_id}/decision`).then((x) => x.json() as any)
    expect(d.decision).toBe('allow')
    const v = receipts.verify(d.receipt, { toolName: 'send_email', args: { to: 'a@b.c' } })
    expect(v.valid && v.matches_call).toBe(true); expect(v.payload!.by).toBe('alice'); expect(v.payload!.id).toBe(r.check_id)
  })
})
