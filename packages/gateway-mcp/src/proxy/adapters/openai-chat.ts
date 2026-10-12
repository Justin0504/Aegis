/**
 * Adapter for OpenAI `/v1/chat/completions` (and api-compatible mirrors
 * like Azure OpenAI, Together, Fireworks, vLLM, OpenRouter, …).
 *
 * Wire shape:
 *
 *   request.messages[] : array of { role, content, tool_calls? }
 *     - tool_calls[] = { id, type:'function', function:{ name, arguments:string-of-json } }
 *
 *   response.choices[0].message : { role, content?, tool_calls? }
 *     - tool_calls[] = same shape
 *
 *   response.usage : { prompt_tokens, completion_tokens, total_tokens }
 *
 * Blocking shape:
 *   For each tool_call we want to block, replace it with a refusal message
 *   inlined into `choices[0].message.content` and remove that tool_call
 *   from `tool_calls[]`. If ALL tool_calls were blocked, drop the array
 *   entirely and set finish_reason='stop'. The model sees "the assistant
 *   answered with text" and proceeds; the host runtime never executes the
 *   blocked tool.
 */

import { createHash } from 'crypto';
import {
  BlockingDirective,
  NeutralToolCall,
  NeutralUsage,
  ProxyAdapter,
} from '../adapter';

// Override for self-hosted OpenAI-compatible upstreams (vLLM, Ollama, LiteLLM).
const UPSTREAM_BASE = (process.env.AEGIS_PROXY_OPENAI_UPSTREAM ?? 'https://api.openai.com').replace(/\/$/, '');
const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-connection',
  'expect',
]);
const AEGIS_HEADERS = ['x-aegis-key', 'x-aegis-agent-id', 'x-aegis-agent-secret', 'x-aegis-agent-token', 'x-aegis-session-id', 'x-aegis-build-artifact', 'x-aegis-source-commit'];

function parseJsonArgs(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as any) ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

export class OpenAIChatAdapter implements ProxyAdapter {
  readonly name = 'openai-chat' as const;
  readonly provider = 'openai' as const;

  upstreamUrl(pathAfterProvider: string, search: string): string {
    // proxy path  /api/v1/proxy/openai/<pathAfterProvider>
    // → upstream  https://api.openai.com/<pathAfterProvider>
    const clean = pathAfterProvider.startsWith('/') ? pathAfterProvider : '/' + pathAfterProvider;
    return `${UPSTREAM_BASE}${clean}${search}`;
  }

  upstreamHeaders(incoming: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (AEGIS_HEADERS.includes(lk)) continue;
      out[lk] = v;
    }
    return out;
  }

  preflightReject(requestBody: any): string | null {
    if (requestBody?.stream === true) {
      return 'AEGIS proxy v1 does not inspect SSE streaming responses; set stream=false or use the SDK auto-instrumentation for streaming workloads.';
    }
    return null;
  }

  extractHistoricToolCalls(requestBody: any): NeutralToolCall[] {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const out: NeutralToolCall[] = [];
    for (const m of messages) {
      if (Array.isArray(m?.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.function?.name) {
            out.push({
              id: String(tc.id ?? ''),
              name: String(tc.function.name),
              arguments: parseJsonArgs(tc.function.arguments),
              location: 'request',
            });
          }
        }
      }
    }
    return out;
  }

  extractToolResultContent(requestBody: any): string[] {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const out: string[] = [];
    for (const m of messages) {
      // OpenAI chat: role:'tool' messages carry function output as content.
      if (m?.role === 'tool' && typeof m.content === 'string') {
        out.push(m.content);
      }
      // Newer OpenAI shapes carry content as an array of typed parts.
      if (m?.role === 'tool' && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part?.text === 'string') out.push(part.text);
        }
      }
    }
    return out;
  }

  extractPendingToolCalls(responseBody: any): NeutralToolCall[] {
    const choice = responseBody?.choices?.[0]?.message;
    if (!choice || !Array.isArray(choice.tool_calls)) return [];
    const out: NeutralToolCall[] = [];
    for (const tc of choice.tool_calls) {
      if (tc?.function?.name) {
        out.push({
          id: String(tc.id ?? ''),
          name: String(tc.function.name),
          arguments: parseJsonArgs(tc.function.arguments),
          location: 'response',
        });
      }
    }
    return out;
  }

  extractUsage(responseBody: any): NeutralUsage | null {
    const u = responseBody?.usage;
    if (!u) return null;
    return {
      promptTokens: Number(u.prompt_tokens ?? 0),
      completionTokens: Number(u.completion_tokens ?? 0),
      totalTokens: Number(u.total_tokens ?? 0),
      model: String(responseBody?.model ?? ''),
    };
  }

  applyBlockingDirective(responseBody: any, directive: BlockingDirective): any {
    if (directive.blockedToolCallIds.length === 0) return responseBody;
    const blocked = new Set(directive.blockedToolCallIds);
    const choice = responseBody?.choices?.[0];
    const msg = choice?.message;
    if (!msg || !Array.isArray(msg.tool_calls)) return responseBody;

    const kept = msg.tool_calls.filter((tc: any) => !blocked.has(String(tc.id)));
    const dropped = msg.tool_calls.filter((tc: any) => blocked.has(String(tc.id)));
    const refusal = `AEGIS blocked ${dropped.length} tool call(s): ${dropped.map((tc: any) => tc?.function?.name).filter(Boolean).join(', ')}. Reason: ${directive.reason}`;

    msg.content = msg.content ? `${msg.content}\n\n${refusal}` : refusal;
    if (kept.length === 0) {
      delete msg.tool_calls;
      if (choice) choice.finish_reason = 'stop';
    } else {
      msg.tool_calls = kept;
    }
    return responseBody;
  }

  extractAegisContext(headers: Record<string, string>, requestBody: any) {
    const agentId =
      headers['x-aegis-agent-id'] ??
      synthAgentId(headers['authorization'] ?? headers['x-api-key'] ?? '');
    const sessionId = headers['x-aegis-session-id'];
    return {
      agentId,
      sessionId,
      model: String(requestBody?.model ?? ''),
    };
  }
}

/** Deterministic 36-char synthetic agent id when the client doesn't tag
 *  the call. Same auth → same synth id → still groups history. */
function synthAgentId(authMaterial: string): string {
  const h = createHash('sha256').update(authMaterial).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
