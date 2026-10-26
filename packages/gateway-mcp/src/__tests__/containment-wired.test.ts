/**
 * Containment through the real entry points (found by the 2026-10-26
 * claims audit): /check used to allow — and sign a receipt for — an agent
 * an operator had suspended or the kill switch had revoked, and the kill
 * switch only revoked api_keys rows, which an SDK agent does not have.
 * Retention: a tenant's policy used to purge every tenant's rows for any
 * table but traces.
 */
import express from 'express'
import pino from 'pino'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initializeDatabase } from '../db/database'
import { initializeEnterpriseSchema } from '../db/enterprise-schema'
import { PolicyEngine } from '../policies/policy-engine'
import { CheckAPI } from '../api/check'
import { SigningService } from '../services/signing'
import { ReceiptService } from '../services/receipts'
import { AgentRegistryService } from '../services/agent-registry'
import { KillSwitchService } from '../services/kill-switch'
import { RetentionService } from '../services/retention'

const silent = pino({ level: 'silent' })

describe('suspended and revoked agents are refused by /check', () => {
  let server: Server, base = '', registry: AgentRegistryService, kill: KillSwitchService
  beforeAll(async () => {
    const db = await initializeDatabase(':memory:'); initializeEnterpriseSchema(db)
    registry = new AgentRegistryService(db, silent)
    kill = new KillSwitchService(db, silent)
    const app = express(); app.use(express.json())
    app.use('/api/v1/check', new CheckAPI(db, new PolicyEngine(db, silent), silent, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, registry, undefined, undefined, new ReceiptService(new SigningService(db, silent)), kill).router)
    server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/check`
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })
  const check = (agent: string) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: agent, tool_name: 'run_query', arguments: { q: 'SELECT 1' } }) }).then((r) => r.json() as any)

  test('an operator-suspended agent is blocked and gets no receipt', async () => {
    expect((await check('sus1')).decision).toBe('allow')
    registry.update({ orgId: 'default', agentId: 'sus1', req: { status: 'suspended' } as any })
    const r = await check('sus1')
    expect(r.decision).toBe('block'); expect(r.category).toBe('agent-suspended'); expect(r.receipt).toBeUndefined()
  })

  test('the kill switch suspends an SDK agent that has no api_keys row', async () => {
    expect((await check('ks1')).decision).toBe('allow')
    await kill.revokeAgentAccess('ks1', 'test')
    const r = await check('ks1')
    expect(r.decision).toBe('block'); expect(r.category).toBe('agent-suspended')
    expect((await check('other')).decision).toBe('allow')
  })
})

describe('retention is per tenant', () => {
  test("a tenant's policy purges that tenant's violations and no one else's", async () => {
    const db = await initializeDatabase(':memory:'); initializeEnterpriseSchema(db)
    for (const o of ['org-a', 'org-b']) db.prepare(`INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)`).run(o, o, o)
    const registry = new AgentRegistryService(db, silent)
    registry.touch({ orgId: 'org-a', agentId: 'agent-a' })
    registry.touch({ orgId: 'org-b', agentId: 'agent-b' })
    const ins = db.prepare(`INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details, created_at)
                            VALUES (?, 'p', 't', 'x', '{}', datetime('now', '-90 days'))`)
    ins.run('agent-a'); ins.run('agent-b')
    const svc = new RetentionService(db, silent)
    svc.createPolicy('org-a', 'violations', 30)
    svc.runPurge()
    const left = db.prepare('SELECT agent_id FROM violations ORDER BY agent_id').all() as any[]
    expect(left.map((r) => r.agent_id)).toEqual(['agent-b'])
  })
})
