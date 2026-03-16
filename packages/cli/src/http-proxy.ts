#!/usr/bin/env node
/**
 * AEGIS HTTP Forward Proxy — intercepts LLM API calls
 *
 * Acts as a reverse proxy for Anthropic / OpenAI APIs.
 * Clients point their SDK base URL at this proxy:
 *
 *   ANTHROPIC_BASE_URL=http://localhost:8081  →  api.anthropic.com
 *   OPENAI_BASE_URL=http://localhost:8081     →  api.openai.com
 *
 * The proxy:
 *  1. Extracts tool_use from request/response for policy checking
 *  2. Calls AEGIS gateway /api/v1/check before forwarding (if blocking)
 *  3. Forwards the request to the real upstream API
 *  4. Parses the response for token usage + tool calls
 *  5. Logs traces to AEGIS gateway (fire-and-forget)
 *  6. Supports SSE streaming responses
 *
 * Zero external dependencies beyond Node.js stdlib.
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

// ── Config ─────────────────────────────────────────────────────────────────

export interface HttpProxyConfig {
  listenPort: number;
  gatewayUrl: string;
  agentId: string;
  blocking: boolean;
  upstream: 'anthropic' | 'openai' | 'auto';
  /** Override upstream base URL (e.g. https://api.anthropic.com) */
  upstreamUrl?: string;
  verbose: boolean;
}

interface UpstreamTarget {
  host: string;
  basePath: string;
  name: string;
}

const UPSTREAM_TARGETS: Record<string, UpstreamTarget> = {
  anthropic: { host: 'api.anthropic.com', basePath: '', name: 'Anthropic' },
  openai:    { host: 'api.openai.com',    basePath: '', name: 'OpenAI' },
};

// ── Logging ────────────────────────────────────────────────────────────────

function createLogger(verbose: boolean) {
  return {
    info: (msg: string) => process.stderr.write(`[AEGIS-HTTP] ${msg}\n`),
    debug: (msg: string) => { if (verbose) process.stderr.write(`[AEGIS-HTTP] ${msg}\n`); },
    error: (msg: string) => process.stderr.write(`[AEGIS-HTTP] ERROR: ${msg}\n`),
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function gatewayPost(gatewayUrl: string, path: string, body: object, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve) => {
    const url = new URL(path, gatewayUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => raw += c.toString());
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ decision: 'allow', reason: 'unparseable response' }); }
      });
    });
    req.on('error', () => resolve({ decision: 'allow', reason: 'gateway unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ decision: 'allow', reason: 'gateway timeout' }); });
    req.write(data);
    req.end();
  });
}

function gatewayPostFireAndForget(gatewayUrl: string, path: string, body: object): void {
  try {
    const url = new URL(path, gatewayUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch {}
}

// ── Request body parsing ───────────────────────────────────────────────────

interface ParsedRequest {
  model: string;
  tools: string[];
  promptSnippet: string;
  isStreaming: boolean;
  provider: 'anthropic' | 'openai';
}

function parseAnthropicRequest(body: any): ParsedRequest {
  const model = body.model ?? 'unknown';
  const tools = (body.tools ?? []).map((t: any) => t.name ?? t.function?.name ?? 'unknown');
  const messages = body.messages ?? [];
  const lastMsg = messages[messages.length - 1];
  let promptSnippet = '';
  if (typeof lastMsg?.content === 'string') {
    promptSnippet = lastMsg.content.slice(0, 500);
  } else if (Array.isArray(lastMsg?.content)) {
    promptSnippet = lastMsg.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(' ')
      .slice(0, 500);
  }
  return { model, tools, promptSnippet, isStreaming: body.stream === true, provider: 'anthropic' };
}

function parseOpenAIRequest(body: any): ParsedRequest {
  const model = body.model ?? 'unknown';
  const tools = (body.tools ?? []).map((t: any) => t.function?.name ?? 'unknown');
  const messages = body.messages ?? [];
  const lastMsg = messages[messages.length - 1];
  const promptSnippet = typeof lastMsg?.content === 'string' ? lastMsg.content.slice(0, 500) : '';
  return { model, tools, promptSnippet, isStreaming: body.stream === true, provider: 'openai' };
}

// ── Response parsing ───────────────────────────────────────────────────────

interface ParsedResponse {
  toolCalls: Array<{ name: string; arguments: Record<string, any> }>;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string;
}

function parseAnthropicResponse(body: any): ParsedResponse {
  const toolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];

  // Extract tool_use blocks from content
  for (const block of (body.content ?? [])) {
    if (block.type === 'tool_use') {
      toolCalls.push({ name: block.name, arguments: block.input ?? {} });
    }
  }

  return {
    toolCalls,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    model: body.model ?? 'unknown',
    stopReason: body.stop_reason ?? '',
  };
}

function parseOpenAIResponse(body: any): ParsedResponse {
  const toolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];
  const choice = body.choices?.[0];

  for (const tc of (choice?.message?.tool_calls ?? [])) {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch {}
    toolCalls.push({ name: tc.function?.name ?? 'unknown', arguments: args });
  }

  return {
    toolCalls,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    model: body.model ?? 'unknown',
    stopReason: choice?.finish_reason ?? '',
  };
}

// ── SSE stream parsing ─────────────────────────────────────────────────────

interface StreamAccumulator {
  toolCalls: Map<number, { name: string; argChunks: string[] }>;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string;
}

function createStreamAccumulator(): StreamAccumulator {
  return {
    toolCalls: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    model: '',
    stopReason: '',
  };
}

function processAnthropicSSEEvent(acc: StreamAccumulator, event: any): void {
  switch (event.type) {
    case 'message_start':
      acc.model = event.message?.model ?? acc.model;
      acc.inputTokens = event.message?.usage?.input_tokens ?? acc.inputTokens;
      break;
    case 'content_block_start':
      if (event.content_block?.type === 'tool_use') {
        acc.toolCalls.set(event.index, { name: event.content_block.name, argChunks: [] });
      }
      break;
    case 'content_block_delta':
      if (event.delta?.type === 'input_json_delta' && acc.toolCalls.has(event.index)) {
        acc.toolCalls.get(event.index)!.argChunks.push(event.delta.partial_json);
      }
      break;
    case 'message_delta':
      acc.stopReason = event.delta?.stop_reason ?? acc.stopReason;
      acc.outputTokens = event.usage?.output_tokens ?? acc.outputTokens;
      break;
  }
}

function processOpenAISSEEvent(acc: StreamAccumulator, event: any): void {
  if (!event.choices?.[0]) return;
  const delta = event.choices[0].delta;
  const finishReason = event.choices[0].finish_reason;

  if (event.model) acc.model = event.model;
  if (finishReason) acc.stopReason = finishReason;
  if (event.usage) {
    acc.inputTokens = event.usage.prompt_tokens ?? acc.inputTokens;
    acc.outputTokens = event.usage.completion_tokens ?? acc.outputTokens;
  }

  for (const tc of (delta?.tool_calls ?? [])) {
    const idx = tc.index ?? 0;
    if (!acc.toolCalls.has(idx)) {
      acc.toolCalls.set(idx, { name: tc.function?.name ?? '', argChunks: [] });
    }
    const entry = acc.toolCalls.get(idx)!;
    if (tc.function?.name) entry.name = tc.function.name;
    if (tc.function?.arguments) entry.argChunks.push(tc.function.arguments);
  }
}

function finalizeStreamAccumulator(acc: StreamAccumulator): ParsedResponse {
  const toolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];
  for (const [, tc] of acc.toolCalls) {
    let args = {};
    try { args = JSON.parse(tc.argChunks.join('')); } catch {}
    toolCalls.push({ name: tc.name, arguments: args });
  }
  return {
    toolCalls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    model: acc.model,
    stopReason: acc.stopReason,
  };
}

// ── Detect provider from request path ──────────────────────────────────────

function detectProvider(urlPath: string, configUpstream: string): 'anthropic' | 'openai' {
  if (configUpstream !== 'auto') return configUpstream as 'anthropic' | 'openai';
  // Anthropic uses /v1/messages, OpenAI uses /v1/chat/completions
  if (urlPath.includes('/messages')) return 'anthropic';
  if (urlPath.includes('/chat/completions')) return 'openai';
  // Check for other Anthropic-specific paths
  if (urlPath.includes('/complete')) return 'anthropic';
  // Default to anthropic
  return 'anthropic';
}

// ── Trace logging ──────────────────────────────────────────────────────────

function sendTrace(
  gatewayUrl: string,
  agentId: string,
  parsed: ParsedRequest,
  response: ParsedResponse,
  durationMs: number,
  blocked: boolean,
  checkResult?: any,
) {
  // Send one trace per tool call, or one for the overall request
  const traceBase = {
    agent_id: agentId,
    timestamp: new Date().toISOString(),
    sequence_number: 0,
    input_context: { prompt: `[${parsed.provider}] ${parsed.model}: ${parsed.promptSnippet.slice(0, 200)}` },
    thought_chain: { raw_tokens: '' },
    integrity_hash: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
    environment: 'PRODUCTION',
    version: '1.0.0',
  };

  if (response.toolCalls.length > 0) {
    // Log each tool call as a separate trace
    for (const tc of response.toolCalls) {
      gatewayPostFireAndForget(gatewayUrl, '/api/v1/traces', {
        ...traceBase,
        trace_id: crypto.randomUUID(),
        tool_call: {
          tool_name: tc.name,
          function: tc.name,
          arguments: tc.arguments,
          timestamp: new Date().toISOString(),
        },
        observation: {
          raw_output: { tool_call: tc.name },
          duration_ms: durationMs,
          metadata: {
            token_usage: {
              input_tokens: response.inputTokens,
              output_tokens: response.outputTokens,
              model: response.model || parsed.model,
            },
          },
        },
        safety_validation: {
          policy_name: checkResult?.policy_name ?? 'http-proxy',
          passed: !blocked,
          risk_level: checkResult?.risk_level ?? 'LOW',
        },
        approval_status: blocked ? 'REJECTED' : 'AUTO_APPROVED',
      });
    }
  } else {
    // Log the LLM call itself as a trace
    gatewayPostFireAndForget(gatewayUrl, '/api/v1/traces', {
      ...traceBase,
      trace_id: crypto.randomUUID(),
      tool_call: {
        tool_name: `${parsed.provider}.${parsed.model}`,
        function: 'llm_call',
        arguments: { model: parsed.model, stream: parsed.isStreaming },
        timestamp: new Date().toISOString(),
      },
      observation: {
        raw_output: { stop_reason: response.stopReason, tool_calls: response.toolCalls.length },
        duration_ms: durationMs,
        metadata: {
          token_usage: {
            input_tokens: response.inputTokens,
            output_tokens: response.outputTokens,
            model: response.model || parsed.model,
          },
        },
      },
      safety_validation: {
        policy_name: 'http-proxy',
        passed: true,
        risk_level: 'LOW',
      },
      approval_status: 'AUTO_APPROVED',
    });
  }
}

// ── Pre-check tool calls in request ────────────────────────────────────────

async function preCheckTools(
  gatewayUrl: string,
  agentId: string,
  tools: string[],
  blocking: boolean,
  log: ReturnType<typeof createLogger>,
): Promise<{ blocked: boolean; reason: string; checkResult?: any }> {
  if (tools.length === 0) return { blocked: false, reason: '' };

  // Check if any requested tool is available — pre-flight check
  for (const tool of tools) {
    const result = await gatewayPost(gatewayUrl, '/api/v1/check', {
      agent_id: agentId,
      tool_name: tool,
      arguments: {},
      environment: 'http-proxy',
      blocking,
    });

    if (result.decision === 'block') {
      log.info(`BLOCKED tool '${tool}' — ${result.reason ?? result.risk_level}`);
      return { blocked: true, reason: result.reason ?? `Tool '${tool}' blocked by policy`, checkResult: result };
    }
  }

  return { blocked: false, reason: '' };
}

// ── Forward request to upstream ────────────────────────────────────────────

function forwardToUpstream(
  target: UpstreamTarget,
  originalReq: http.IncomingMessage,
  reqBody: Buffer,
  customHost?: string,
): Promise<{ res: http.IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const host = customHost ?? target.host;

    // Build headers — forward everything except host
    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(originalReq.headers)) {
      if (key === 'host' || key === 'connection') continue;
      if (val !== undefined) headers[key] = val as string;
    }
    headers['host'] = host;
    headers['content-length'] = String(reqBody.length);

    const opts: https.RequestOptions = {
      hostname: host,
      port: 443,
      path: originalReq.url ?? '/',
      method: originalReq.method ?? 'POST',
      headers,
    };

    const upstreamReq = https.request(opts, (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on('end', () => resolve({ res: upstreamRes, body: Buffer.concat(chunks) }));
    });

    upstreamReq.on('error', reject);
    upstreamReq.write(reqBody);
    upstreamReq.end();
  });
}

function forwardStreamToUpstream(
  target: UpstreamTarget,
  originalReq: http.IncomingMessage,
  reqBody: Buffer,
  clientRes: http.ServerResponse,
  provider: 'anthropic' | 'openai',
  log: ReturnType<typeof createLogger>,
  customHost?: string,
): Promise<ParsedResponse> {
  return new Promise((resolve, reject) => {
    const host = customHost ?? target.host;

    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(originalReq.headers)) {
      if (key === 'host' || key === 'connection') continue;
      if (val !== undefined) headers[key] = val as string;
    }
    headers['host'] = host;
    headers['content-length'] = String(reqBody.length);

    const opts: https.RequestOptions = {
      hostname: host,
      port: 443,
      path: originalReq.url ?? '/',
      method: originalReq.method ?? 'POST',
      headers,
    };

    const upstreamReq = https.request(opts, (upstreamRes) => {
      // Forward status and headers to client
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);

      const acc = createStreamAccumulator();
      let sseBuffer = '';

      upstreamRes.on('data', (chunk: Buffer) => {
        // Forward chunk to client immediately
        clientRes.write(chunk);

        // Parse SSE events for trace extraction
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload);
            if (provider === 'anthropic') {
              processAnthropicSSEEvent(acc, event);
            } else {
              processOpenAISSEEvent(acc, event);
            }
          } catch {}
        }
      });

      upstreamRes.on('end', () => {
        clientRes.end();
        resolve(finalizeStreamAccumulator(acc));
      });

      upstreamRes.on('error', (err) => {
        log.error(`Upstream stream error: ${err.message}`);
        clientRes.end();
        resolve(finalizeStreamAccumulator(acc));
      });
    });

    upstreamReq.on('error', reject);
    upstreamReq.write(reqBody);
    upstreamReq.end();
  });
}

// ── Main proxy server ──────────────────────────────────────────────────────

export async function startHttpProxy(config: HttpProxyConfig): Promise<http.Server> {
  const { listenPort, gatewayUrl, agentId, blocking, verbose } = config;
  const log = createLogger(verbose);

  // Resolve upstream target
  let customHost: string | undefined;
  if (config.upstreamUrl) {
    const parsed = new URL(config.upstreamUrl);
    customHost = parsed.hostname;
  }

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const urlPath = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Health check
    if (urlPath === '/health' || urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        proxy: 'aegis-http',
        upstream: config.upstream,
        gateway: gatewayUrl,
        agent_id: agentId,
      }));
      return;
    }

    // Only proxy POST requests to API paths
    const provider = detectProvider(urlPath, config.upstream);
    const target = UPSTREAM_TARGETS[provider];

    log.debug(`${method} ${urlPath} → ${provider} (${customHost ?? target.host})`);

    // Read request body
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

    req.on('end', async () => {
      const reqBody = Buffer.concat(bodyChunks);
      let parsedReq: ParsedRequest | null = null;

      // Parse request body for POST to LLM endpoints
      if (method === 'POST' && reqBody.length > 0) {
        try {
          const bodyJson = JSON.parse(reqBody.toString());
          parsedReq = provider === 'anthropic'
            ? parseAnthropicRequest(bodyJson)
            : parseOpenAIRequest(bodyJson);

          log.info(`${provider} ${parsedReq.model} stream=${parsedReq.isStreaming} tools=[${parsedReq.tools.join(',')}]`);

          // Pre-check available tools if blocking mode
          if (blocking && parsedReq.tools.length > 0) {
            const check = await preCheckTools(gatewayUrl, agentId, parsedReq.tools, blocking, log);
            if (check.blocked) {
              const errorBody = provider === 'anthropic'
                ? {
                    type: 'error',
                    error: { type: 'permission_error', message: `[AEGIS BLOCKED] ${check.reason}` },
                  }
                : {
                    error: { type: 'permission_error', message: `[AEGIS BLOCKED] ${check.reason}`, code: 'policy_blocked' },
                  };
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(errorBody));

              // Log blocked trace
              if (parsedReq) {
                sendTrace(gatewayUrl, agentId, parsedReq, {
                  toolCalls: parsedReq.tools.map(t => ({ name: t, arguments: {} })),
                  inputTokens: 0, outputTokens: 0,
                  model: parsedReq.model, stopReason: 'blocked',
                }, Date.now() - startTime, true, check.checkResult);
              }
              return;
            }
          }
        } catch {
          // Non-JSON body or unparseable — forward as-is
        }
      }

      try {
        // Streaming response
        if (parsedReq?.isStreaming) {
          const parsedRes = await forwardStreamToUpstream(
            target, req, reqBody, res, provider, log, customHost
          );
          const durationMs = Date.now() - startTime;
          log.debug(`Stream complete: ${parsedRes.inputTokens}+${parsedRes.outputTokens} tokens, ${parsedRes.toolCalls.length} tool calls, ${durationMs}ms`);

          // Post-check tool calls from response
          if (parsedReq && parsedRes.toolCalls.length > 0) {
            for (const tc of parsedRes.toolCalls) {
              const checkResult = await gatewayPost(gatewayUrl, '/api/v1/check', {
                agent_id: agentId,
                tool_name: tc.name,
                arguments: tc.arguments,
                environment: 'http-proxy',
                blocking: false,
              });
              log.info(`POST-CHECK ${checkResult.decision?.toUpperCase() ?? 'ALLOW'} ${tc.name} (${checkResult.risk_level ?? 'LOW'})`);
            }
          }

          // Log trace
          if (parsedReq) {
            sendTrace(gatewayUrl, agentId, parsedReq, parsedRes, durationMs, false);
          }
          return;
        }

        // Non-streaming response
        const { res: upstreamRes, body: upstreamBody } = await forwardToUpstream(
          target, req, reqBody, customHost
        );
        const durationMs = Date.now() - startTime;

        // Forward response to client
        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        res.end(upstreamBody);

        // Parse response for trace
        if (parsedReq && upstreamRes.statusCode === 200) {
          let parsedRes: ParsedResponse;
          try {
            const resJson = JSON.parse(upstreamBody.toString());
            parsedRes = provider === 'anthropic'
              ? parseAnthropicResponse(resJson)
              : parseOpenAIResponse(resJson);
          } catch {
            parsedRes = { toolCalls: [], inputTokens: 0, outputTokens: 0, model: parsedReq.model, stopReason: '' };
          }

          log.debug(`Response: ${parsedRes.inputTokens}+${parsedRes.outputTokens} tokens, ${parsedRes.toolCalls.length} tool calls, ${durationMs}ms`);

          // Post-check tool calls from response
          for (const tc of parsedRes.toolCalls) {
            const checkResult = await gatewayPost(gatewayUrl, '/api/v1/check', {
              agent_id: agentId,
              tool_name: tc.name,
              arguments: tc.arguments,
              environment: 'http-proxy',
              blocking: false,
            });
            log.info(`POST-CHECK ${checkResult.decision?.toUpperCase() ?? 'ALLOW'} ${tc.name} (${checkResult.risk_level ?? 'LOW'})`);
          }

          sendTrace(gatewayUrl, agentId, parsedReq, parsedRes, durationMs, false);
        }
      } catch (err: any) {
        log.error(`Upstream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
        }
      }
    });
  });

  server.listen(listenPort, () => {
    log.info(`HTTP proxy listening on port ${listenPort}`);
    log.info(`  Upstream:  ${config.upstream} (${customHost ?? UPSTREAM_TARGETS[config.upstream === 'auto' ? 'anthropic' : config.upstream]?.host})`);
    log.info(`  Gateway:   ${gatewayUrl}`);
    log.info(`  Agent ID:  ${agentId}`);
    log.info(`  Blocking:  ${blocking}`);
    log.info(`  Mode:      ${config.upstream === 'auto' ? 'auto-detect (Anthropic/OpenAI)' : config.upstream}`);
    log.info('');
    log.info('Usage:');
    if (config.upstream === 'anthropic' || config.upstream === 'auto') {
      log.info(`  export ANTHROPIC_BASE_URL=http://localhost:${listenPort}`);
    }
    if (config.upstream === 'openai' || config.upstream === 'auto') {
      log.info(`  export OPENAI_BASE_URL=http://localhost:${listenPort}/v1`);
    }
    log.info('');
  });

  return server;
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
  }

  const config: HttpProxyConfig = {
    listenPort: parseInt(getArg('--port', '8081'), 10),
    gatewayUrl: getArg('--gateway', 'http://localhost:8080'),
    agentId: getArg('--agent-id', 'http-proxy'),
    blocking: args.includes('--blocking'),
    upstream: getArg('--upstream', 'auto') as 'anthropic' | 'openai' | 'auto',
    upstreamUrl: args.includes('--upstream-url') ? getArg('--upstream-url', '') : undefined,
    verbose: args.includes('--verbose') || args.includes('-v'),
  };

  startHttpProxy(config);
}
