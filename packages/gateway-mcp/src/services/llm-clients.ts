/**
 * NlLlmClient adapters for the NL policy compiler.
 *
 * Three concrete backends. All satisfy the same NlLlmClient interface
 * so the compiler stays vendor-neutral and unit-testable with a plain
 * function stub.
 *
 *   1. LocalOpenAICompatibleLlmClient — any OpenAI-compatible endpoint.
 *      Works out-of-the-box with Ollama (:11434), vLLM, LM Studio,
 *      LocalAI, llama-server. Load-bearing for **AEGIS_OFFLINE=1**
 *      deployments (BFSI / air-gapped / EU AI Act) where the gateway
 *      must NOT reach public LLM APIs from its own services.
 *
 *   2. AnthropicLlmClient — direct Anthropic Messages API. Enabled
 *      only when AEGIS_OFFLINE is unset AND an ANTHROPIC_API_KEY is
 *      configured. Explicit env gate so a misconfigured production
 *      pod can't accidentally exfil workflow graphs.
 *
 *   3. OpenAILlmClient — direct OpenAI Chat Completions. Same gate.
 *
 * `pickLlmClient(env, logger)` returns the highest-priority client
 * satisfying the env config, or `undefined` when the compiler must
 * fall back to the heuristic backend. Priority order (top wins):
 *
 *   1. Local (AEGIS_LOCAL_LLM_URL set)                — always allowed
 *   2. Anthropic  (ANTHROPIC_API_KEY set, !OFFLINE)   — cloud, cheap
 *   3. OpenAI     (OPENAI_API_KEY set, !OFFLINE)      — cloud, cheap
 *
 * Rationale: local wins even when a cloud key is also configured, so
 * an operator flipping AEGIS_OFFLINE=1 in production immediately
 * severs cloud calls without needing to also unset the API keys.
 */

import { Logger } from 'pino';
import type { NlLlmClient } from './nl-policy-compiler';

// ── Local OpenAI-compatible endpoint (Ollama / vLLM / LM Studio) ────

export interface LocalOpenAiCompatOpts {
  /** Base URL of the local endpoint. Ollama: http://127.0.0.1:11434/v1
   *  vLLM: http://127.0.0.1:8000/v1
   *  LM Studio: http://127.0.0.1:1234/v1
   *  Must end with /v1 (the OpenAI-compat prefix). */
  baseUrl: string;
  /** Model name as the local server registered it. Ollama typically
   *  "llama3.1", vLLM whatever --model was passed at boot. */
  model: string;
  /** Bearer token if the local server was launched with --api-key.
   *  Optional — many local deployments have no auth. */
  apiKey?: string;
  /** Ceiling for a single compile. Local models can be slow on CPU;
   *  16s default gives Ollama-CPU enough room while still cutting off
   *  a wedged inference. */
  defaultTimeoutMs?: number;
}

export class LocalOpenAICompatibleLlmClient implements NlLlmClient {
  constructor(private opts: LocalOpenAiCompatOpts, private logger: Logger) {
    if (!/^https?:\/\/.+\/v1\/?$/.test(opts.baseUrl)) {
      throw new Error(
        `LocalOpenAICompatibleLlmClient: baseUrl must be an OpenAI-compat /v1 URL, got: ${opts.baseUrl}`,
      );
    }
  }

  async complete(opts: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 16_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const url = this.opts.baseUrl.replace(/\/?$/, '/') + 'chat/completions';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: ac.signal,
        body: JSON.stringify({
          model: this.opts.model,
          // Zero temperature so the compiler emits stable rule JSON
          // across retries; important for the cockpit re-preview flow.
          temperature: 0,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user',   content: opts.user },
          ],
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`local LLM ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const j = await res.json() as any;
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(`local LLM returned no choices[0].message.content (got: ${JSON.stringify(j).slice(0, 200)})`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Anthropic (cloud) ────────────────────────────────────────────────

export class AnthropicLlmClient implements NlLlmClient {
  constructor(private apiKey: string, private model = 'claude-sonnet-4-6', private logger?: Logger) {}

  async complete(opts: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          temperature: 0,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`anthropic ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const j = await res.json() as any;
      const text = j?.content?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error(`anthropic returned no content[0].text (got: ${JSON.stringify(j).slice(0, 200)})`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── OpenAI (cloud) ───────────────────────────────────────────────────

export class OpenAILlmClient implements NlLlmClient {
  constructor(private apiKey: string, private model = 'gpt-4o', private logger?: Logger) {}

  async complete(opts: { system: string; user: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.apiKey}`,
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user',   content: opts.user },
          ],
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`openai ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const j = await res.json() as any;
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(`openai returned no choices[0].message.content (got: ${JSON.stringify(j).slice(0, 200)})`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Selector ─────────────────────────────────────────────────────────

/**
 * Env-driven picker used by server bootstrap. Returns:
 *   · a local client when AEGIS_LOCAL_LLM_URL is set (always allowed)
 *   · a cloud client when its key is set AND AEGIS_OFFLINE is unset
 *   · undefined otherwise → the compiler falls back to `heuristic`
 *
 * Env vars honored:
 *   AEGIS_OFFLINE            "1" | "true"  — refuses cloud clients even
 *                                            when their keys are present
 *   AEGIS_LOCAL_LLM_URL      OpenAI-compat /v1 base URL
 *   AEGIS_LOCAL_LLM_MODEL    Model id at the local endpoint
 *   AEGIS_LOCAL_LLM_KEY      Optional bearer for auth-protected servers
 *   AEGIS_LOCAL_LLM_TIMEOUT_MS  Optional per-compile ceiling
 *   ANTHROPIC_API_KEY        Cloud fallback (only when NOT offline)
 *   OPENAI_API_KEY           Cloud fallback (only when NOT offline)
 *
 * The chosen backend is logged at boot so operators can confirm
 * "yes, we ARE offline" from the startup log without inspecting env.
 */
export function pickLlmClient(env: NodeJS.ProcessEnv, logger: Logger): NlLlmClient | undefined {
  const offline = env.AEGIS_OFFLINE === '1' || env.AEGIS_OFFLINE === 'true';

  const localUrl   = env.AEGIS_LOCAL_LLM_URL?.trim();
  const localModel = env.AEGIS_LOCAL_LLM_MODEL?.trim();
  if (localUrl && localModel) {
    logger.info({ backend: 'local', url: localUrl, model: localModel, offline },
      'nl-policy-compiler LLM adapter selected');
    return new LocalOpenAICompatibleLlmClient({
      baseUrl:          localUrl,
      model:            localModel,
      apiKey:           env.AEGIS_LOCAL_LLM_KEY?.trim() || undefined,
      defaultTimeoutMs: env.AEGIS_LOCAL_LLM_TIMEOUT_MS ? Number(env.AEGIS_LOCAL_LLM_TIMEOUT_MS) : undefined,
    }, logger);
  }

  if (offline) {
    logger.warn(
      'AEGIS_OFFLINE is set but no AEGIS_LOCAL_LLM_URL configured — NL policy compiler will run heuristic-only',
    );
    return undefined;
  }

  if (env.ANTHROPIC_API_KEY) {
    logger.info({ backend: 'anthropic', model: env.AEGIS_NL_MODEL ?? 'claude-sonnet-4-6' },
      'nl-policy-compiler LLM adapter selected');
    return new AnthropicLlmClient(
      env.ANTHROPIC_API_KEY,
      env.AEGIS_NL_MODEL ?? 'claude-sonnet-4-6',
      logger,
    );
  }
  if (env.OPENAI_API_KEY) {
    logger.info({ backend: 'openai', model: env.AEGIS_NL_MODEL ?? 'gpt-4o' },
      'nl-policy-compiler LLM adapter selected');
    return new OpenAILlmClient(
      env.OPENAI_API_KEY,
      env.AEGIS_NL_MODEL ?? 'gpt-4o',
      logger,
    );
  }

  logger.info('no LLM adapter configured — NL policy compiler will run heuristic-only');
  return undefined;
}
