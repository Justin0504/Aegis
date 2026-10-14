// Gateway load test: throughput and tail latency of POST /api/v1/check
// under concurrency, with and without the instruction-provenance pack.
//
//   node loadtest.mjs                 # → results/loadtest.json + console table
//
// What it measures. One fresh gateway per configuration (shipping build,
// enterprise tier, rate limit lifted, logs at warn). 1,000 sessions are
// pre-seeded through /api/v1/context with a user turn and a tool return
// taken from the instantiated corpus, so the provenance layer has a real
// ledger to assess on every call. Then, for each concurrency level, N
// workers issue /check back-to-back for a fixed duration, each call drawn
// from the corpus (attack and benign mixed) with its own session id.
// Reported: requests/s, p50/p95/p99/max latency as the client sees it,
// error count, and the gateway's resident memory after the level.
//
// What it does not measure: the network between an agent and a remote
// gateway (this is loopback), and the SDK's own overhead in the agent
// process (Appendix A measures that per row).
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const GW = path.join(REPO, 'packages', 'gateway-mcp')
const OUT = path.join(HERE, 'results')
fs.mkdirSync(OUT, { recursive: true })
const LEVELS = (process.env.LEVELS ?? '1,8,32,128').split(',').map(Number)
const DURATION_S = Number(process.env.DURATION_S ?? 20)
const SESSIONS = 1000

// ── corpus: calls + their context ─────────────────────────────────────────
const bench = fs.readFileSync(path.join(REPO, 'research/benchmark/data/aegis-bench-instantiated.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse)
const items = bench.map(r => {
  const user = (r.conversation ?? []).filter(m => m.role === 'user').map(m => m.content).join(' ')
  const obs = (r.conversation ?? []).filter(m => m.role === 'tool_observation' || m.role === 'tool').map(m => m.content).join(' ')
  return { tool: r.tool_call.tool_name, args: r.tool_call.arguments ?? {}, user, obs }
})

async function startGateway(tag, port, pack) {
  const db = `/tmp/aegis-load-${tag}-${Date.now()}.db`
  const log = fs.openSync(path.join(OUT, `gateway-${tag}.log`), 'w')
  const proc = spawn('node', ['dist/server.js'], {
    cwd: GW, stdio: ['ignore', log, log],
    env: { ...process.env, PORT: String(port), DB_PATH: db, AEGIS_LICENSE_TIER: 'enterprise',
           AEGIS_OFFLINE: '1', RATE_LIMIT_MAX: '100000000', LOG_LEVEL: 'warn' },
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  const key = (await (await fetch(`${base}/api/v1/auth/key`)).json()).api_key
  const h = { 'content-type': 'application/json', 'x-api-key': key }
  if (pack) await fetch(`${base}/api/v1/dsl/packs/security-instruction-provenance/apply`, { method: 'POST', headers: h, body: '{}' })
  return { proc, base, h, db }
}

function rssMB(pid) {
  try { return Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024) } catch { return null }
}

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null }

async function runLevel(gw, conc) {
  const lat = []
  let firstError = null
  let errors = 0, decisions = { allow: 0, block: 0, pending: 0 }
  const stopAt = performance.now() + DURATION_S * 1000
  let n = 0
  async function worker(w) {
    while (performance.now() < stopAt) {
      const i = (n++) % items.length
      const it = items[i]
      const sid = `load-${i % SESSIONS}`
      const t0 = performance.now()
      try {
        const r = await fetch(`${gw.base}/api/v1/check`, { method: 'POST', headers: gw.h,
          body: JSON.stringify({ agent_id: `load-${w % 16}`, session_id: sid, tool_name: it.tool, arguments: it.args,
                                 environment: 'PRODUCTION', blocking: true }) })
        const d = await r.json()
        if (!r.ok) { errors++; if (!firstError) firstError = `${r.status} ${JSON.stringify(d).slice(0, 200)}` }
        else decisions[d.decision] = (decisions[d.decision] ?? 0) + 1
      } catch (e) { errors++; if (!firstError) firstError = String(e).slice(0, 200) }
      lat.push(performance.now() - t0)
    }
  }
  const t0 = performance.now()
  await Promise.all(Array.from({ length: conc }, (_, w) => worker(w)))
  const secs = (performance.now() - t0) / 1000
  lat.sort((a, b) => a - b)
  const r2 = x => x == null ? null : Math.round(x * 100) / 100
  return { concurrency: conc, requests: lat.length, rps: Math.round(lat.length / secs), p50_ms: r2(pct(lat, 0.5)),
           p95_ms: r2(pct(lat, 0.95)), p99_ms: r2(pct(lat, 0.99)), max_ms: r2(lat[lat.length - 1]), errors, first_error: firstError,
           decisions, rss_mb: rssMB(gw.proc.pid) }
}

const results = {}
for (const [tag, port, pack] of [['rules', 18120, false], ['pack', 18121, true]]) {
  const gw = await startGateway(tag, port, pack)
  // seed ledgers: one user turn + one tool return per session
  for (let s = 0; s < SESSIONS; s++) {
    const it = items[s % items.length]
    const events = [{ channel: 'user', text: it.user || 'help me' }]
    if (it.obs) events.push({ channel: 'untrusted', text: it.obs.slice(0, 32000) })
    await fetch(`${gw.base}/api/v1/context`, { method: 'POST', headers: gw.h, body: JSON.stringify({ session_id: `load-${s}`, events }) })
  }
  const idle = rssMB(gw.proc.pid)
  await runLevel(gw, 4)  // warm-up, discarded
  results[tag] = { idle_rss_mb: idle, levels: [] }
  for (const c of LEVELS) {
    const r = await runLevel(gw, c)
    results[tag].levels.push(r)
    console.log(`${tag.padEnd(6)} c=${String(c).padStart(4)}  ${String(r.rps).padStart(6)} req/s  p50 ${r.p50_ms} ms  p95 ${r.p95_ms}  p99 ${r.p99_ms}  max ${r.max_ms}  err ${r.errors} ${r.first_error ?? ''}  rss ${r.rss_mb} MB`)
  }
  gw.proc.kill('SIGTERM')
  try { fs.rmSync(gw.db, { force: true }); fs.rmSync(gw.db + '-wal', { force: true }); fs.rmSync(gw.db + '-shm', { force: true }) } catch {}
}
results.meta = { duration_s: DURATION_S, sessions: SESSIONS, corpus_calls: items.length, node: process.version,
                 cpu: execSync('sysctl -n machdep.cpu.brand_string').toString().trim(), date: new Date().toISOString() }
fs.writeFileSync(path.join(OUT, 'loadtest.json'), JSON.stringify(results, null, 1))
console.log('wrote', path.join(OUT, 'loadtest.json'))
