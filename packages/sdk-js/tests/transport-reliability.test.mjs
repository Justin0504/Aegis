/**
 * Chaos tests for HttpTransport reliability guarantees.
 *
 * Covers the retry loop, circuit breaker, disk persistence + replay,
 * and metrics counters added in the "industry-parity" pass. Same
 * coverage matrix as the Python test_transport_reliability.py.
 *
 * Uses a monkey-patched global.fetch to script gateway responses —
 * no real HTTP touches the network.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _HttpTransport as HttpTransport } from '../dist/index.mjs';

// ── Fetch mock ──────────────────────────────────────────────────────

let originalFetch;
let scriptQueue = [];   // FIFO of {status, body}
let calls = [];         // captured request bodies

function pushResponse(status, body = {}) {
  scriptQueue.push({ status, body });
}

function pushResponses(...pairs) {
  for (const [status, body] of pairs) scriptQueue.push({ status, body: body ?? {} });
}

function mockFetch(_url, init) {
  const bodyStr = typeof init?.body === 'string' ? init.body : '';
  try { calls.push(JSON.parse(bodyStr)); }
  catch { calls.push({ __raw: bodyStr }); }
  const next = scriptQueue.shift();
  if (!next) {
    // Nothing scripted — simulate a network error rather than surprise 200
    return Promise.reject(new Error('mockFetch: no scripted response'));
  }
  const { status, body } = next;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
}

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir;

beforeEach(async () => {
  scriptQueue = [];
  calls = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-transport-'));
});

afterEach(async () => {
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeTransport(overrides = {}) {
  return new HttpTransport({
    agentId: 'test-agent',
    gatewayUrl: 'http://mock',
    batchSize: 100,
    flushIntervalMs: 60_000,   // effectively disabled for these tests
    debug: false,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 0,      // no real sleeping in tests
    retryCapDelayMs: 0,
    circuitFailureThreshold: 3,
    circuitOpenDurationMs: 20,
    localStoragePath: tmpDir,
    enableReplayOnStartup: false,
    replayStartupDelayMs: 0,
    replayRatePerSec: 1000,
    ...overrides,
  });
}

// Internal method for direct testing — mirrors what the Python test
// does with send_trace_dict.
function sendOne(transport, trace) {
  // The public enqueue()/flush() path buffers in memory; for
  // deterministic tests we go through the private sendWithRetry via
  // enqueue + flush.
  transport.enqueue(trace);
  return transport.flush();
}

function trace(traceId = 't-1') {
  return { trace_id: traceId, agent_id: 'test-agent', tool_name: 'noop' };
}

async function pollFor(pred, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

// ── Retry on 5xx ───────────────────────────────────────────────────

describe('HttpTransport reliability', () => {
  it('retries on 500 then succeeds', async () => {
    pushResponses([500], [503], [200]);
    const t = makeTransport();
    await sendOne(t, trace());
    assert.equal(calls.length, 3);
    const snap = await t.metricsSnapshot();
    assert.equal(snap.retries_total, 2);
    assert.equal(snap.traces_sent, 1);
    t.destroy();
  });

  it('does NOT retry on 400', async () => {
    pushResponses([400]);
    const t = makeTransport();
    await sendOne(t, trace());
    assert.equal(calls.length, 1);
    const snap = await t.metricsSnapshot();
    assert.equal(snap.retries_total, 0);
    assert.equal(snap.traces_failed, 1);
    // 4xx = server said "your payload is bad" — breaker should NOT trip
    assert.equal(snap.circuit_state, 'closed');
    t.destroy();
  });

  it('retries on 429 (throttling)', async () => {
    pushResponses([429], [200]);
    const t = makeTransport();
    await sendOne(t, trace());
    assert.equal(calls.length, 2);
    t.destroy();
  });

  // ── Circuit breaker ─────────────────────────────────────────────

  it('circuit trips after repeated failures', async () => {
    for (let i = 0; i < 20; i++) pushResponses([500]);
    const t = makeTransport({ retryMaxAttempts: 1, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i++) await sendOne(t, trace(`t-${i}`));
    const snap = await t.metricsSnapshot();
    assert.equal(snap.circuit_state, 'open');
    assert.equal(snap.circuit_trips, 1);

    // Subsequent calls short-circuit — no new HTTP call
    const callsBefore = calls.length;
    await sendOne(t, trace('short-circuited'));
    assert.equal(calls.length, callsBefore);
    // Payload persisted to disk instead
    const backlogNow = (await t.metricsSnapshot()).disk_backlog;
    assert.ok(backlogNow >= 1);
    t.destroy();
  });

  it('circuit recovers after open_duration on successful probe', async () => {
    pushResponses([500], [500], [200], [200]);
    const t = makeTransport({
      retryMaxAttempts: 1,
      circuitFailureThreshold: 2,
      circuitOpenDurationMs: 20,
    });
    await sendOne(t, trace());
    await sendOne(t, trace());
    assert.equal((await t.metricsSnapshot()).circuit_state, 'open');
    await new Promise(r => setTimeout(r, 30));
    // Probe call — 200 closes the breaker
    await sendOne(t, trace('probe'));
    assert.equal((await t.metricsSnapshot()).circuit_state, 'closed');
    t.destroy();
  });

  // ── Disk persistence ─────────────────────────────────────────────

  it('persists to disk on terminal failure', async () => {
    pushResponses([500], [500], [500]);
    const t = makeTransport({ retryMaxAttempts: 3 });
    await sendOne(t, trace('persist-me'));
    // Wait for the async disk-write to land
    const ok = await pollFor(async () =>
      (await fs.readdir(tmpDir)).filter(f => f.endsWith('.json')).length >= 1);
    assert.ok(ok, 'expected trace to be persisted to disk');
    const files = (await fs.readdir(tmpDir)).filter(f => f.endsWith('.json'));
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, files[0]), 'utf8'));
    assert.equal(saved.trace_id, 'persist-me');
    t.destroy();
  });

  it('startup replay drains disk queue oldest-first', async () => {
    // Pre-seed two files from a prior process
    await fs.writeFile(path.join(tmpDir, '0001-a.json'), JSON.stringify(trace('old-1')));
    await fs.writeFile(path.join(tmpDir, '0002-b.json'), JSON.stringify(trace('old-2')));

    pushResponses([200], [200]);
    const t = makeTransport({
      retryMaxAttempts: 1,
      enableReplayOnStartup: true,
      replayStartupDelayMs: 0,
    });

    const drained = await pollFor(async () =>
      (await fs.readdir(tmpDir)).filter(f => f.endsWith('.json')).length === 0,
      1500);
    assert.ok(drained, 'expected disk queue drained by replay');

    const traceIds = calls.map(c => c.trace_id);
    assert.deepEqual(traceIds, ['old-1', 'old-2']);
    const snap = await t.metricsSnapshot();
    assert.equal(snap.replayed_total, 2);
    t.destroy();
  });

  it('replay stops on first failure (no duplicate persist)', async () => {
    for (const tid of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(tmpDir, `0000${tid === 'a' ? 1 : tid === 'b' ? 2 : 3}-x.json`),
        JSON.stringify(trace(tid)));
    }
    pushResponses([200], [500]);   // 2nd file fails
    const t = makeTransport({
      retryMaxAttempts: 1,
      enableReplayOnStartup: true,
      replayStartupDelayMs: 0,
    });

    // Wait for replay to run
    await new Promise(r => setTimeout(r, 200));
    const remaining = (await fs.readdir(tmpDir)).filter(f => f.endsWith('.json'));
    // Expected: file `a` was drained; `b` and `c` remain — NO new
    // duplicate file for `b` (which would leak backlog).
    assert.equal(remaining.length, 2, `expected 2 files, got ${remaining.length}: ${remaining.join(', ')}`);
    t.destroy();
  });

  // ── Metrics ─────────────────────────────────────────────────────

  it('metricsSnapshot exposes all expected keys', async () => {
    pushResponses([200]);
    const t = makeTransport();
    await sendOne(t, trace());
    const snap = await t.metricsSnapshot();
    for (const key of [
      'traces_sent', 'traces_failed', 'traces_persisted',
      'retries_total', 'replayed_total', 'circuit_trips',
      'circuit_state', 'queue_depth', 'disk_backlog',
    ]) {
      assert.ok(key in snap, `missing key: ${key}`);
    }
    assert.equal(snap.traces_sent, 1);
    assert.equal(snap.circuit_state, 'closed');
    t.destroy();
  });
});
