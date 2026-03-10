import express from 'express'
import pino from 'pino'
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { calculateTraceHash } from '@agentguard/core-schema'
import { initializeDatabase } from '../db/database'
import { PolicyEngine } from '../policies/policy-engine'
import { CheckAPI } from '../api/check'
import { TraceAPI } from '../api/traces'

const logger = pino({ level: 'silent' })

type Harness = {
  baseUrl: string
  server: Server
  db: Awaited<ReturnType<typeof initializeDatabase>>
}

async function createHarness(): Promise<Harness> {
  const db = await initializeDatabase(':memory:')
  const policyEngine = new PolicyEngine(db, logger)

  const app = express()
  app.use(express.json())

  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get()
      res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected' })
    } catch (err: any) {
      res.status(503).json({ status: 'unhealthy', error: err.message, db: 'disconnected' })
    }
  })

  app.use('/api/v1/check', new CheckAPI(db, policyEngine, logger).router)
  app.use('/api/v1/traces', new TraceAPI(db, logger).router)

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })

  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    db,
  }
}

async function closeHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err ? reject(err) : resolve()))
  })
  harness.db.close()
}

async function jsonRequest(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body: any = await response.json()
  return { response, body }
}

function makeTrace(agentId = randomUUID()) {
  const timestamp = new Date().toISOString()
  const partial = {
    trace_id: randomUUID(),
    agent_id: agentId,
    timestamp,
    sequence_number: 0,
    input_context: {
      prompt: 'Search for the latest AI safety papers',
    },
    thought_chain: {
      raw_tokens: 'Tool selected: web_search',
    },
    tool_call: {
      tool_name: 'web_search',
      function: 'web_search',
      arguments: { query: 'AI safety papers' },
      timestamp,
    },
    observation: {
      raw_output: { results: ['paper-1', 'paper-2'] },
      duration_ms: 125,
    },
    environment: 'DEVELOPMENT' as const,
    version: '1.0.0',
  }

  return {
    ...partial,
    integrity_hash: calculateTraceHash(partial),
  }
}

describe('gateway API smoke tests', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(async () => {
    await closeHarness(harness)
  })

  test('health endpoint reports an initialized gateway', async () => {
    const { response, body } = await jsonRequest(harness.baseUrl, '/health')

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.db).toBe('connected')
    expect(typeof body.timestamp).toBe('string')
  })

  test('check endpoint allows a benign tool call', async () => {
    const { response, body } = await jsonRequest(harness.baseUrl, '/api/v1/check', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: randomUUID(),
        tool_name: 'web_search',
        arguments: { query: 'latest AI safety research' },
      }),
    })

    expect(response.status).toBe(200)
    expect(body.decision).toBe('allow')
    expect(body.category).toBe('network')
    expect(body.risk_level).toBe('LOW')
  })

  test('check endpoint returns pending for a high-risk blocking request', async () => {
    const { response, body } = await jsonRequest(harness.baseUrl, '/api/v1/check', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: randomUUID(),
        tool_name: 'execute_sql',
        arguments: { sql: 'DROP TABLE users' },
        blocking: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(body.decision).toBe('pending')
    expect(body.category).toBe('database')
    expect(body.risk_level).toBe('HIGH')
    expect(typeof body.check_id).toBe('string')
  })

  test('traces endpoint stores and returns a submitted trace', async () => {
    const trace = makeTrace()

    const create = await jsonRequest(harness.baseUrl, '/api/v1/traces', {
      method: 'POST',
      body: JSON.stringify(trace),
    })

    expect(create.response.status).toBe(201)
    expect(create.body.trace_id).toBe(trace.trace_id)

    const query = await jsonRequest(
      harness.baseUrl,
      `/api/v1/traces?agent_id=${trace.agent_id}&limit=10`
    )

    expect(query.response.status).toBe(200)
    expect(query.body.total).toBe(1)
    expect(query.body.traces).toHaveLength(1)
    expect(query.body.traces[0].trace_id).toBe(trace.trace_id)
    expect(query.body.traces[0].tool_call.tool_name).toBe('web_search')
  })
})
