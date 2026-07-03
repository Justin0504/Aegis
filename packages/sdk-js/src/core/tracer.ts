import { calculateTraceHash, generateTraceId } from './hash.js';
import { HttpTransport } from '../transport/http.js';
import type {
  AgentGuardConfig,
  GatewayTrace,
  CheckRequest,
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
  /**
   * Stack of active delegation ids (Toledo et al. arXiv:2606.09692).
   * `guard.delegation(id, () => {...})` pushes an id; every trace
   * opened while the stack is non-empty inherits the top id, with
   * the previous top becoming `parent_delegation_id`.
   */
  private delegationStack: string[] = [];

  constructor(config: AgentGuardConfig) {
    this.config = {
      environment: 'DEVELOPMENT',
      batchSize: 10,
      flushIntervalMs: 2000,
      blockingMode: false,
      blockingTimeoutMs: 3000,
      failOpen: true,
      debug: false,
      // Identity headers default to empty strings; HttpTransport's
      // env-fallback logic in buildHeaders() picks them up from
      // AEGIS_API_KEY / AEGIS_AGENT_SECRET / AEGIS_SESSION_ID when
      // the caller didn't supply them explicitly.
      apiKey: '',
      agentSecret: '',
      agentToken: '',
      sessionId: '',
      buildArtifact: '',
      sourceCommit: '',
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
      const req: CheckRequest = {
        agent_id: this.agentId,
        tool_name: toolName,
        arguments: args,
        environment: this.config.environment,
      };

      // Splice in any buffered CodeShield verdict so DSL rules like
      // `{ code_shield.worst: CRITICAL }` can fire on the same hop.
      // Lazy require so this stays optional and tree-shakeable; the
      // state module has no side effects until something writes to it.
      try {
        const cs = await import('../integrations/code-shield-state.js');
        const buffered = cs.consume(this.agentId);
        if (buffered) {
          const payload = cs.toCheckPayload(buffered);
          if (payload) req.code_shield = payload;
        }
      } catch {
        // Module not bundled — fine, just skip the splice.
      }

      // Same closed-loop pattern for the alignment helper.
      try {
        const al = await import('../integrations/alignment-state.js');
        const buffered = al.consume(this.agentId);
        if (buffered) {
          const payload = al.toCheckPayload(buffered);
          if (payload) req.alignment = payload;
        }
      } catch {
        // Module not bundled — skip.
      }

      return await this.transport.check(req, this.config.blockingTimeoutMs);
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
    if (check.decision !== 'allow') {
      throw new AgentGuardBlockedError(
        toolName,
        check.reason ?? 'Policy violation',
        (check.risk_level ?? 'MEDIUM') as import('./types').RiskLevel,
        check.check_id ?? ''
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

      // Delegation propagation: read the current top of the stack for
       // this trace's delegation, the element below (if any) for the
       // parent. Frozen at trace-open time so async fan-out inside the
       // wrapped tool call inherits this trace's binding, not whatever
       // the stack looks like at flush time.
      const delegation = this.delegationStack[this.delegationStack.length - 1];
      const parentDelegation = this.delegationStack.length > 1
        ? this.delegationStack[this.delegationStack.length - 2]
        : undefined;

      const partial: Omit<GatewayTrace, 'integrity_hash'> = {
        trace_id: traceId,
        agent_id: this.agentId,
        sequence_number: seqNum,
        timestamp: now,
        ...(delegation        ? { delegation_id:        delegation        } : {}),
        ...(parentDelegation  ? { parent_delegation_id: parentDelegation  } : {}),
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

  /**
   * Bind a delegation id to every trace opened inside the callback.
   *
   * @example
   *   await guard.delegation('user-request-42', async () => {
   *     await agent.run(task)   // every tool call → delegation_id="user-request-42"
   *   })
   *
   * Nested calls create sub-delegations — the outer id becomes
   * `parent_delegation_id` on the inner block's traces.
   */
  async delegation<T>(
    delegationId: string,
    body: () => Promise<T> | T,
  ): Promise<T> {
    this.delegationStack.push(delegationId);
    try {
      return await body();
    } finally {
      // Guard against reentrancy sending the wrong id — pop by identity,
      // not by index.
      const idx = this.delegationStack.lastIndexOf(delegationId);
      if (idx >= 0) this.delegationStack.splice(idx, 1);
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
