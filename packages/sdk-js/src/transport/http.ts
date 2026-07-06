/**
 * HTTP transport for the AEGIS JS SDK.
 *
 * Feature parity with the Python SDK — see
 * packages/sdk-python/agentguard/transport/service.py for the design
 * rationale. Summary:
 *
 *   1. Retries with exponential backoff + full jitter (AWS "full jitter"
 *      recipe). Retries only on retryable HTTP status + network errors,
 *      never on 4xx that means "your payload is bad".
 *   2. Circuit breaker (closed → open → half-open) to avoid hammering
 *      a downed gateway.
 *   3. Disk-backed replay when running under Node — traces that
 *      couldn't be delivered land in `~/.agentguard/traces/*.json` and
 *      are replayed oldest-first on next startup. In browsers we skip
 *      disk persistence (no `fs`) — the queue is best-effort in-memory
 *      only, matching what Sentry-browser and PostHog-browser do.
 *   4. Structured logging via a pluggable logger (config.logger). If
 *      unset we fall back to console.* with a "[AgentGuard]" prefix.
 *   5. Self-metrics exposed via metricsSnapshot() so operators can
 *      export to Prometheus / Datadog.
 *
 * Backwards-compatible: the public methods (enqueue, check, flush,
 * destroy) keep their prior signatures.
 */

import type { GatewayTrace, CheckRequest, CheckResponse, AgentGuardConfig } from '../core/types.js';

const SDK_VERSION = '1.0.0';

// ── Retry / retryable status ────────────────────────────────────────

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  capDelayMs:  number;
  jitter:      boolean;
}

function delayForAttempt(policy: RetryPolicy, attempt: number): number {
  const capped = Math.min(policy.capDelayMs, policy.baseDelayMs * (2 ** attempt));
  if (!policy.jitter) return capped;
  return Math.random() * capped;
}

// ── Circuit breaker ─────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half_open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFails = 0;
  private openedAt = 0;

  constructor(
    private failureThreshold: number,
    private openDurationMs:   number,
    private log:              LogFn,
  ) {}

  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.openDurationMs) {
        this.state = 'half_open';
        this.log('info', 'circuit half-open: probing gateway');
        return true;
      }
      return false;
    }
    // half_open — one probe at a time; further calls wait.
    return false;
  }

  recordSuccess(): void {
    if (this.state !== 'closed') this.log('info', 'circuit closed after successful probe');
    this.consecutiveFails = 0;
    this.state = 'closed';
  }

  recordFailure(): boolean {
    this.consecutiveFails++;
    const wasClosed = this.state === 'closed';
    if (this.state === 'half_open') {
      this.log('warn', 'circuit re-opened: probe failed');
      this.state = 'open';
      this.openedAt = Date.now();
    } else if (this.consecutiveFails >= this.failureThreshold && this.state === 'closed') {
      this.log('warn', `circuit opened after ${this.consecutiveFails} consecutive failures`);
      this.state = 'open';
      this.openedAt = Date.now();
    }
    return wasClosed && this.state === 'open';   // "trip" event
  }

  getState(): CircuitState { return this.state; }
}

// ── Logger ──────────────────────────────────────────────────────────

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;

function defaultLogger(debug: boolean): LogFn {
  return (level, msg, err) => {
    if (level === 'debug' && !debug) return;
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (err !== undefined) method(`[AgentGuard][${level}] ${msg}`, err);
    else method(`[AgentGuard][${level}] ${msg}`);
  };
}

// ── Node-only disk queue (browser-safe: features degrade to no-op) ──

interface DiskQueue {
  save(payload: unknown): Promise<void>;
  drainOnce(sendOne: (payload: unknown) => Promise<boolean>, ratePerSec: number,
            shouldStop: () => boolean): Promise<void>;
  backlog(): Promise<number>;
}

async function makeDiskQueue(dir: string | undefined, log: LogFn): Promise<DiskQueue | null> {
  // Detect Node. Browsers don't have process.versions.node.
  const isNode = typeof process !== 'undefined' && !!(process as any).versions?.node;
  if (!isNode) return null;
  try {
    // Dynamic imports so bundlers targeting browser can tree-shake
    // this out — no static `require('fs')` in the module graph.
    const fs   = await import('node:fs/promises');
    const path = await import('node:path');
    const os   = await import('node:os');
    const resolved = dir ?? path.join(os.homedir(), '.agentguard', 'traces');
    await fs.mkdir(resolved, { recursive: true });

    return {
      async save(payload) {
        try {
          const ts = String(Date.now()).padStart(15, '0');
          const suffix = Math.random().toString(36).slice(2, 10);
          const file = path.join(resolved, `${ts}-${suffix}.json`);
          await fs.writeFile(file, JSON.stringify(payload));
        } catch (e) {
          log('error', 'disk queue write failed', e);
        }
      },
      async drainOnce(sendOne, ratePerSec, shouldStop) {
        const intervalMs = 1000 / Math.max(ratePerSec, 1);
        let files: string[] = [];
        try {
          files = (await fs.readdir(resolved))
            .filter(f => f.endsWith('.json'))
            .sort();
        } catch (e) {
          log('error', 'disk queue readdir failed', e);
          return;
        }
        if (!files.length) return;
        log('info', `replay: ${files.length} disk-backed traces queued`);
        let sent = 0;
        for (const name of files) {
          if (shouldStop()) return;
          const full = path.join(resolved, name);
          let payload: unknown;
          try {
            payload = JSON.parse(await fs.readFile(full, 'utf8'));
          } catch (e) {
            log('warn', `replay: skipping unreadable ${name}`, e);
            try { await fs.unlink(full); } catch { /* ignore */ }
            continue;
          }
          const ok = await sendOne(payload);
          if (ok) {
            try { await fs.unlink(full); sent++; } catch { /* ignore */ }
          } else {
            log('warn', `replay: stopping on failure, ${files.length - files.indexOf(name)} remaining`);
            return;
          }
          await new Promise(r => setTimeout(r, intervalMs));
        }
        log('info', `replay: complete (${sent} sent)`);
      },
      async backlog() {
        try {
          const files = (await fs.readdir(resolved)).filter(f => f.endsWith('.json'));
          return files.length;
        } catch {
          return -1;
        }
      },
    };
  } catch (e) {
    log('warn', 'disk queue unavailable', e);
    return null;
  }
}

// ── Config helpers ──────────────────────────────────────────────────

function buildHeaders(config: AgentGuardConfig): Record<string, string> {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-agentguard-sdk': `js/${SDK_VERSION}`,
    'x-aegis-agent-id': config.agentId,
  };
  const apiKey = config.apiKey || env.AEGIS_API_KEY || env.AGENTGUARD_API_KEY;
  if (apiKey) headers['x-api-key'] = apiKey;
  const agentSecret = config.agentSecret || env.AEGIS_AGENT_SECRET || env.AGENTGUARD_AGENT_SECRET;
  if (agentSecret) headers['x-aegis-agent-secret'] = agentSecret;
  const agentToken = config.agentToken || env.AEGIS_AGENT_TOKEN;
  if (agentToken) headers['x-aegis-agent-token'] = agentToken;
  const sessionId = config.sessionId || env.AEGIS_SESSION_ID;
  if (sessionId) headers['x-aegis-session-id'] = sessionId;
  return headers;
}

// ── Transport ───────────────────────────────────────────────────────

interface Metrics {
  traces_sent:      number;
  traces_failed:    number;
  traces_persisted: number;
  retries_total:    number;
  replayed_total:   number;
  circuit_trips:    number;
}

export class HttpTransport {
  private queue: GatewayTrace[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: AgentGuardConfig;
  private readonly settings: Required<Pick<AgentGuardConfig,
    'gatewayUrl' | 'batchSize' | 'flushIntervalMs' | 'debug'>>;
  private readonly retry: RetryPolicy;
  private readonly breaker: CircuitBreaker;
  private readonly log: LogFn;
  private disk: DiskQueue | null = null;
  private diskReady: Promise<void>;
  private destroyed = false;
  private metrics: Metrics = {
    traces_sent: 0, traces_failed: 0, traces_persisted: 0,
    retries_total: 0, replayed_total: 0, circuit_trips: 0,
  };

  constructor(config: AgentGuardConfig) {
    this.config = { ...config, gatewayUrl: config.gatewayUrl.replace(/\/$/, '') };
    this.settings = {
      gatewayUrl: this.config.gatewayUrl,
      batchSize: config.batchSize ?? 10,
      flushIntervalMs: config.flushIntervalMs ?? 2000,
      debug: config.debug ?? false,
    };
    this.log = (config as any).logger ?? defaultLogger(this.settings.debug);
    this.retry = {
      maxAttempts: (config as any).retryMaxAttempts ?? 5,
      baseDelayMs: (config as any).retryBaseDelayMs ?? 500,
      capDelayMs:  (config as any).retryCapDelayMs  ?? 30_000,
      jitter:      true,
    };
    this.breaker = new CircuitBreaker(
      (config as any).circuitFailureThreshold ?? 5,
      (config as any).circuitOpenDurationMs   ?? 30_000,
      this.log,
    );
    // Kick off disk-queue init + immediate replay on startup. Both
    // are best-effort; awaiting them would block enqueue(). Capture
    // `log` in a local so the async closure doesn't confuse TS's flow
    // analysis about class-property initialisation order.
    const log = this.log;
    this.diskReady = (async () => {
      this.disk = await makeDiskQueue((config as any).localStoragePath, log);
      if (this.disk && ((config as any).enableReplayOnStartup ?? true)) {
        // Small delay so caller's constructor returns before we hit the
        // gateway with a backlog.
        await new Promise(r => setTimeout(r, (config as any).replayStartupDelayMs ?? 2000));
        const rate = (config as any).replayRatePerSec ?? 20;
        await this.disk.drainOnce(
          async (payload) => {
            // persistOnFailure: false — the payload is already on disk;
            // re-persisting would duplicate the file and grow backlog.
            const ok = await this.sendWithRetry('/api/v1/traces', payload as GatewayTrace, false, { persistOnFailure: false });
            if (ok) this.metrics.replayed_total++;
            return ok;
          },
          rate,
          () => this.destroyed,
        );
      }
    })().catch(e => log('error', 'disk queue init failed', e));

    this.startFlushTimer();
  }

  // ── Public API ────────────────────────────────────────────────────

  enqueue(trace: GatewayTrace): void {
    this.queue.push(trace);
    if (this.queue.length >= this.settings.batchSize) {
      void this.flush();
    }
  }

  async check(req: CheckRequest, timeoutMs: number): Promise<CheckResponse> {
    // Note: /check is intentionally NOT wrapped in the retry loop.
    // It's a synchronous gate — the agent is BLOCKED waiting on this
    // response. Adding retries here doubles the perceived latency of
    // a policy decision; better to fail fast and let the caller decide
    // fallback behaviour (block-by-default when gateway is down is
    // the safer choice for a security product).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.settings.gatewayUrl}/api/v1/check`, {
        method: 'POST',
        headers: buildHeaders(this.config),
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Gateway check failed: ${res.status}`);
      return (await res.json()) as CheckResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.settings.batchSize);
    // Send each trace independently — 4xx on one shouldn't kill the
    // whole batch, and retry granularity works per-trace this way.
    await Promise.all(batch.map(trace => this.sendWithRetry('/api/v1/traces', trace, false)));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }

  async metricsSnapshot(): Promise<Record<string, unknown>> {
    const backlog = this.disk ? await this.disk.backlog() : 0;
    return {
      ...this.metrics,
      circuit_state:  this.breaker.getState(),
      queue_depth:    this.queue.length,
      disk_backlog:   backlog,
    };
  }

  // ── Retry loop ────────────────────────────────────────────────────

  private async sendWithRetry(
    path: string,
    payload: GatewayTrace | unknown,
    isBatch: boolean,
    opts: { persistOnFailure?: boolean } = {},
  ): Promise<boolean> {
    const persistOnFailure = opts.persistOnFailure ?? true;
    if (!this.breaker.allow()) {
      this.log('debug', 'circuit open — persisting to disk');
      if (persistOnFailure) await this.persist(payload);
      return false;
    }

    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        const res = await fetch(`${this.settings.gatewayUrl}${path}`, {
          method:  'POST',
          headers: buildHeaders(this.config),
          body:    JSON.stringify(payload),
        });
        if (res.ok) {
          this.breaker.recordSuccess();
          this.metrics.traces_sent++;
          return true;
        }
        // Non-retryable 4xx → drop with logged error, no persist.
        // Gateway said "your payload is bad"; retrying won't fix it.
        if (res.status >= 400 && !RETRYABLE_STATUS.has(res.status)) {
          this.log('error', `gateway returned non-retryable ${res.status} — dropping trace`);
          this.breaker.recordSuccess();
          this.metrics.traces_failed++;
          return false;
        }
        // Retryable server error — fall through to backoff.
        if (attempt + 1 < this.retry.maxAttempts) {
          const delay = delayForAttempt(this.retry, attempt);
          this.log('warn',
            `send failed (attempt ${attempt + 1}/${this.retry.maxAttempts}): HTTP ${res.status} — retrying in ${delay.toFixed(0)}ms`);
          this.metrics.retries_total++;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      } catch (e) {
        // Network error / abort — retryable.
        if (attempt + 1 < this.retry.maxAttempts) {
          const delay = delayForAttempt(this.retry, attempt);
          this.log('warn',
            `send failed (attempt ${attempt + 1}/${this.retry.maxAttempts}): ${(e as Error).message} — retrying in ${delay.toFixed(0)}ms`);
          this.metrics.retries_total++;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        this.log('error', 'send exhausted retries', e);
      }
    }

    // Retries exhausted.
    const tripped = this.breaker.recordFailure();
    if (tripped) this.metrics.circuit_trips++;
    this.metrics.traces_failed++;
    if (persistOnFailure) await this.persist(payload);
    return false;
  }

  private async persist(payload: unknown): Promise<void> {
    await this.diskReady;   // ensure disk queue is initialised
    if (!this.disk) return;  // browser environment — best-effort in-memory only
    await this.disk.save(payload);
    this.metrics.traces_persisted++;
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.settings.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }
}
