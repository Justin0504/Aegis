import { calculateTraceHash, generateTraceId } from './hash.js';
import { HttpTransport } from '../transport/http.js';
import type {
  AgentGuardConfig,
  GatewayTrace,
  CheckResponse,
  RiskLevel,
  Environment,
} from './types.js';
import { AgentGuardBlockedError } from './types.js';

const SDK_VERSION = '1.0.0';

export class AgentGuard {
  public readonly config: Required<AgentGuardConfig>;
  public readonly agentId: string;
  private readonly transport: HttpTransport;
  private sequenceCounter = 0;
  private previousHash: string | undefined;

  constructor(config: AgentGuardConfig) {
    this.config = {
      environment: 'DEVELOPMENT',
      batchSize: 10,
      flushIntervalMs: 2000,
      blockingMode: false,
      blockingTimeoutMs: 3000,
      failOpen: true,
      debug: false,
      ...config,
    };
    this.agentId = config.agentId;
    this.transport = new HttpTransport(this.config);
  }

  /**
   * Wrap a single async or sync tool function with tracing (and optional blocking).
   *
   * @example
   * const search = guard.wrap('web_search', async (query: string) => { ... })
   */
  wrap<TArgs extends unknown[], TReturn>(
    toolName: string,
    fn: (...args: TArgs) => Promise<TReturn> | TReturn,
    promptExtractor?: (...args: TArgs) => string
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      const argsObj = this.argsToRecord(args);
      const prompt = promptExtractor ? promptExtractor(...args) : this.extractPrompt(args);
      const startTime = Date.now();

      if (this.config.blockingMode) {
        await this.enforceBlock(toolName, argsObj);
      }

      let result: TReturn;
      let error: string | undefined;
      try {
        result = await fn(...args);
        return result;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.sendTrace({
          toolName,
          prompt,
          arguments: argsObj,
          startTime,
          result: error ? undefined : (result! as unknown),
          error,
        });
      }
    };
  }

  /**
   * Object wrapper — traces all methods on an object (or class instance).
   *
   * @example
   * const tools = guard.wrapAll({ webSearch, executeSQL })
   */
  wrapAll<T extends Record<string, (...args: unknown[]) => unknown>>(
    tools: T
  ): T {
    return Object.fromEntries(
      Object.entries(tools).map(([name, fn]) => [name, this.wrap(name, fn)])
    ) as T;
  }

  /**
   * Pre-execution check without full tracing.
   * Returns the CheckResponse or null if gateway is unreachable (fail-open).
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<CheckResponse | null> {
    try {
      return await this.transport.check(
        {
          agent_id: this.agentId,
          tool_name: toolName,
          arguments: args,
          environment: this.config.environment,
        },
        this.config.blockingTimeoutMs
      );
    } catch (err) {
      if (this.config.debug) console.warn('[AgentGuard] Check request failed:', err);
      return null;
    }
  }

  /** Flush any queued traces immediately. */
  async flush(): Promise<void> {
    await this.transport.flush();
  }

  /** Clean up timers (call on process exit if needed). */
  destroy(): void {
    this.transport.destroy();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async enforceBlock(toolName: string, args: Record<string, unknown>): Promise<void> {
    const check = await this.check(toolName, args);
    if (check === null) {
      // Gateway unreachable
      if (!this.config.failOpen) {
        throw new AgentGuardBlockedError(
          toolName,
          'Gateway unreachable and fail-open is disabled',
          'CRITICAL',
          'gateway-unreachable'
        );
      }
      return; // fail-open: allow
    }
    if (!check.allowed) {
      throw new AgentGuardBlockedError(
        toolName,
        check.reason ?? 'Policy violation',
        check.risk_level,
        check.check_id
      );
    }
  }

  sendTrace(input: {
    toolName: string;
    prompt: string;
    arguments: Record<string, unknown>;
    startTime: number;
    result?: unknown;
    error?: string;
  }): void {
    try {
      const traceId = generateTraceId();
      const now = new Date().toISOString();
      const durationMs = Math.max(Date.now() - input.startTime, 0.001);
      const seqNum = this.sequenceCounter++;

      const partial: Omit<GatewayTrace, 'integrity_hash'> = {
        trace_id: traceId,
        agent_id: this.agentId,
        sequence_number: seqNum,
        timestamp: now,
        input_context: { prompt: input.prompt },
        thought_chain: { raw_tokens: 'Auto-captured via JS SDK', parsed_steps: [] },
        tool_call: {
          tool_name: input.toolName,
          function: input.toolName,
          arguments: input.arguments,
          timestamp: now,
        },
        observation: {
          raw_output: input.result ?? null,
          error: input.error,
          duration_ms: durationMs,
        },
        previous_hash: this.previousHash,
        environment: this.config.environment,
        version: SDK_VERSION,
      };

      const integrity_hash = calculateTraceHash(partial);
      const trace: GatewayTrace = { ...partial, integrity_hash };

      this.previousHash = integrity_hash;
      this.transport.enqueue(trace);
    } catch (err) {
      if (this.config.debug) console.warn('[AgentGuard] Failed to build trace:', err);
    }
  }

  private argsToRecord(args: unknown[]): Record<string, unknown> {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      return args[0] as Record<string, unknown>;
    }
    return Object.fromEntries(args.map((v, i) => [`arg${i}`, v]));
  }

  private extractPrompt(args: unknown[]): string {
    for (const arg of args) {
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'object' && arg !== null) {
        for (const key of ['prompt', 'query', 'message', 'input', 'question', 'text']) {
          const val = (arg as Record<string, unknown>)[key];
          if (typeof val === 'string') return val;
        }
      }
    }
    return '';
  }
}
