import type { GatewayTrace, CheckRequest, CheckResponse, AgentGuardConfig } from '../core/types.js';

const SDK_VERSION = '1.0.0';

export class HttpTransport {
  private queue: GatewayTrace[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: Required<Pick<AgentGuardConfig,
    'gatewayUrl' | 'batchSize' | 'flushIntervalMs' | 'debug'>>;

  constructor(config: AgentGuardConfig) {
    this.config = {
      gatewayUrl: config.gatewayUrl.replace(/\/$/, ''),
      batchSize: config.batchSize ?? 10,
      flushIntervalMs: config.flushIntervalMs ?? 2000,
      debug: config.debug ?? false,
    };
    this.startFlushTimer();
  }

  enqueue(trace: GatewayTrace): void {
    this.queue.push(trace);
    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async check(req: CheckRequest, timeoutMs: number): Promise<CheckResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.gatewayUrl}/api/v1/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agentguard-sdk': `js/${SDK_VERSION}` },
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
    const batch = this.queue.splice(0, this.config.batchSize);
    try {
      await Promise.all(
        batch.map((trace) =>
          fetch(`${this.config.gatewayUrl}/api/v1/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-agentguard-sdk': `js/${SDK_VERSION}` },
            body: JSON.stringify(trace),
          }).catch((err) => {
            if (this.config.debug) console.warn('[AgentGuard] Failed to send trace:', err);
          })
        )
      );
    } catch (err) {
      if (this.config.debug) console.warn('[AgentGuard] Flush error:', err);
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    // Don't block Node.js process exit
    if (this.timer.unref) this.timer.unref();
  }
}
