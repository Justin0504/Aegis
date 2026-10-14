/**
 * alignment.check() helper — stubbed fetch.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentCheck,
  _alignConsume as consume,
  _alignReset as reset,
} from '../dist/index.mjs';

const originalFetch = globalThis.fetch;

function stubFetchOnce({ status = 200, body }) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };
  return calls;
}

describe('alignmentCheck()', () => {
  beforeEach(() => reset());
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('POSTs the expected body shape', async () => {
    const calls = stubFetchOnce({
      body: { score: 0.32, drifted: true, signals: ['scope-expansion'] },
    });
    const v = await alignmentCheck({
      agentId: 'agent-1',
      declaredGoal: 'summarise survey',
      thoughtChain: ['t1', 't2'],
      proposedAction: { tool_name: 'exec_sql', arguments: { q: 'SELECT 1' } },
      gatewayUrl: 'http://gw.test',
      apiKey: 'k',
    });
    assert.equal(v.score, 0.32);
    assert.equal(v.drifted, true);
    assert.equal(calls[0].url, 'http://gw.test/api/v1/alignment/check');
    assert.equal(calls[0].init.headers['X-API-Key'], 'k');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.agent_id, 'agent-1');
    assert.equal(body.declared_goal, 'summarise survey');
    assert.deepEqual(body.thought_chain, ['t1', 't2']);
    assert.equal(body.proposed_action.tool_name, 'exec_sql');
  });

  it('forwards the session id so the auditor sees the tool output', async () => {
    const calls = stubFetchOnce({ body: { score: 1, drifted: false } });
    await alignmentCheck({
      agentId: 'a', declaredGoal: 'g', proposedAction: { tool_name: 't' },
      gatewayUrl: 'http://gw.test', sessionId: 'sess-1',
    });
    assert.equal(JSON.parse(calls[0].init.body).session_id, 'sess-1');
  });

  it('buffers verdict for closed-loop by default', async () => {
    stubFetchOnce({ body: { score: 0.4, drifted: true } });
    await alignmentCheck({
      agentId: 'agent-b',
      declaredGoal: 'g',
      proposedAction: { tool_name: 't' },
      gatewayUrl: 'http://gw.test',
    });
    const out = consume('agent-b');
    assert.ok(out);
    assert.equal(out.drifted, true);
  });

  it('skips buffer when recordForCheck=false', async () => {
    stubFetchOnce({ body: { score: 0.95 } });
    await alignmentCheck({
      agentId: 'agent-c',
      declaredGoal: 'g',
      proposedAction: { tool_name: 't' },
      gatewayUrl: 'http://gw.test',
      recordForCheck: false,
    });
    assert.equal(consume('agent-c'), null);
  });

  it('validates required inputs', async () => {
    await assert.rejects(
      () => alignmentCheck({ agentId: '', declaredGoal: 'g', proposedAction: { tool_name: 't' } }),
      /agentId/,
    );
    await assert.rejects(
      () => alignmentCheck({ agentId: 'a', declaredGoal: '', proposedAction: { tool_name: 't' } }),
      /declaredGoal/,
    );
    await assert.rejects(
      // @ts-expect-error — intentional bad input
      () => alignmentCheck({ agentId: 'a', declaredGoal: 'g', proposedAction: {} }),
      /tool_name/,
    );
  });

  it('rejects unknown provider', async () => {
    await assert.rejects(
      () => alignmentCheck({
        agentId: 'a',
        declaredGoal: 'g',
        proposedAction: { tool_name: 't' },
        // @ts-expect-error
        provider: 'bananas',
      }),
      /provider/,
    );
  });

  it('throws on non-2xx', async () => {
    stubFetchOnce({ status: 502, body: { error: 'upstream timeout' } });
    await assert.rejects(
      () => alignmentCheck({
        agentId: 'a',
        declaredGoal: 'g',
        proposedAction: { tool_name: 't' },
        gatewayUrl: 'http://gw.test',
      }),
      /HTTP 502/,
    );
  });

  it('omits X-API-Key when no key configured', async () => {
    const prev = process.env.AEGIS_API_KEY;
    delete process.env.AEGIS_API_KEY;
    try {
      const calls = stubFetchOnce({ body: { score: 1 } });
      await alignmentCheck({
        agentId: 'a',
        declaredGoal: 'g',
        proposedAction: { tool_name: 't' },
        gatewayUrl: 'http://gw.test',
      });
      assert.equal(calls[0].init.headers['X-API-Key'], undefined);
    } finally {
      if (prev !== undefined) process.env.AEGIS_API_KEY = prev;
    }
  });
});
