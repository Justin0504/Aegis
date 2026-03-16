#!/usr/bin/env node
/**
 * AEGIS MCP Proxy — lightweight JSON-RPC stdio relay
 *
 * Spawns an upstream MCP server as a child process, relays all JSON-RPC
 * messages between stdin/stdout, and intercepts `tools/call` requests
 * through the AEGIS gateway policy engine + anomaly detector.
 *
 * Zero external dependencies beyond Node.js stdlib.
 *
 * Usage:
 *   agentguard mcp-proxy \
 *     --server "npx -y @modelcontextprotocol/server-filesystem /" \
 *     --gateway http://localhost:8080 \
 *     --agent-id openclaw
 */

import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as https from 'https';

// ── Config ─────────────────────────────────────────────────────────────────

interface ProxyConfig {
  serverCmd: string[];
  gatewayUrl: string;
  agentId: string;
  blocking: boolean;
  failOpen: boolean;
}

// ── HTTP helper (zero deps) ────────────────────────────────────────────────

function httpPost(url: string, body: object, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
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

function httpPostFireAndForget(url: string, body: object): void {
  try {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch {}
}

// ── JSON-RPC line protocol parser ──────────────────────────────────────────

class JsonRpcReader {
  private buffer = '';
  private headerMode = true;
  private contentLength = -1;
  private onMessage: (msg: any) => void;

  constructor(onMessage: (msg: any) => void) {
    this.onMessage = onMessage;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    this.parse();
  }

  private parse(): void {
    while (true) {
      if (this.headerMode) {
        // Look for Content-Length header
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = this.buffer.slice(0, headerEnd);
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          this.contentLength = parseInt(match[1], 10);
        } else {
          // No Content-Length — try bare JSON (some servers skip headers)
          this.contentLength = -1;
        }
        this.buffer = this.buffer.slice(headerEnd + 4);
        this.headerMode = false;
      }

      if (this.contentLength >= 0) {
        // Standard LSP framing: Content-Length header
        if (this.buffer.length < this.contentLength) return;
        const body = this.buffer.slice(0, this.contentLength);
        this.buffer = this.buffer.slice(this.contentLength);
        this.headerMode = true;
        this.contentLength = -1;
        try { this.onMessage(JSON.parse(body)); } catch {}
      } else {
        // Bare JSON fallback: look for complete JSON objects
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) return;
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        this.headerMode = true;
        if (line) {
          try { this.onMessage(JSON.parse(line)); } catch {}
        }
      }
    }
  }
}

function encodeJsonRpc(msg: any): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

// ── Main proxy ─────────────────────────────────────────────────────────────

export async function startProxy(config: ProxyConfig): Promise<void> {
  const { serverCmd, gatewayUrl, agentId, blocking, failOpen } = config;

  const log = (msg: string) => process.stderr.write(`[AEGIS] ${msg}\n`);

  // Spawn upstream MCP server
  const upstream: ChildProcess = spawn(serverCmd[0], serverCmd.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (!upstream.stdin || !upstream.stdout) {
    log('Failed to spawn upstream server');
    process.exit(1);
  }

  // Forward upstream stderr to our stderr
  upstream.stderr?.on('data', (d: Buffer) => process.stderr.write(d));

  upstream.on('error', (err) => {
    log(`Upstream server error: ${err.message}`);
    process.exit(1);
  });

  upstream.on('exit', (code) => {
    log(`Upstream server exited with code ${code}`);
    process.exit(code ?? 1);
  });

  // Track pending requests for response routing
  const pendingRequests = new Map<string | number, { resolve: (msg: any) => void }>();
  let toolsCache: any[] = [];

  // ── Read from upstream server ──────────────────────────────────────────
  const upstreamReader = new JsonRpcReader((msg) => {
    // Check if this is a response to our forwarded request
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
      const pending = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      pending.resolve(msg);
      return;
    }
    // Otherwise forward to client (notifications, etc.)
    process.stdout.write(encodeJsonRpc(msg));
  });

  upstream.stdout.setEncoding('utf8');
  upstream.stdout.on('data', (chunk: string) => upstreamReader.feed(chunk));

  // Send a message to upstream and wait for response
  function sendToUpstream(msg: any): Promise<any> {
    return new Promise((resolve) => {
      pendingRequests.set(msg.id, { resolve });
      upstream.stdin!.write(encodeJsonRpc(msg));
      // Timeout after 30s
      setTimeout(() => {
        if (pendingRequests.has(msg.id)) {
          pendingRequests.delete(msg.id);
          resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Upstream timeout' } });
        }
      }, 30000);
    });
  }

  // ── Read from client (stdin) ───────────────────────────────────────────
  const clientReader = new JsonRpcReader(async (msg) => {
    // Intercept tools/call
    if (msg.method === 'tools/call') {
      await handleToolCall(msg);
      return;
    }

    // Intercept tools/list to cache tool names
    if (msg.method === 'tools/list') {
      const response = await sendToUpstream(msg);
      if (response.result?.tools) {
        toolsCache = response.result.tools;
        log(`${toolsCache.length} tools from upstream`);
      }
      process.stdout.write(encodeJsonRpc(response));
      return;
    }

    // Forward everything else
    const response = await sendToUpstream(msg);
    process.stdout.write(encodeJsonRpc(response));
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => clientReader.feed(chunk));
  process.stdin.on('end', () => {
    upstream.kill();
    process.exit(0);
  });

  // ── Tool call interception ─────────────────────────────────────────────
  async function handleToolCall(msg: any): Promise<void> {
    const { id, params } = msg;
    const toolName = params?.name ?? params?.tool ?? '';
    const args = params?.arguments ?? {};

    // Pre-execution check
    const checkResult = await httpPost(`${gatewayUrl}/api/v1/check`, {
      agent_id: agentId,
      tool_name: toolName,
      arguments: args,
      environment: 'openclaw',
      blocking,
    });

    const decision = checkResult.decision ?? 'allow';
    const riskLevel = checkResult.risk_level ?? 'LOW';
    const reason = checkResult.reason ?? '';
    const anomaly = checkResult.anomaly;

    // Log decision
    const anomalyInfo = anomaly ? ` anomaly=${anomaly.score}` : '';
    log(`${decision.toUpperCase()} ${toolName} (${riskLevel}${anomalyInfo})`);

    if (decision === 'block') {
      process.stdout.write(encodeJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: `[AEGIS BLOCKED] Tool '${toolName}' was blocked.\nRisk: ${riskLevel}\nReason: ${reason}`,
          }],
          isError: true,
        },
      }));
      return;
    }

    if (decision === 'pending') {
      process.stdout.write(encodeJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: `[AEGIS PENDING] Tool '${toolName}' awaiting human approval.\nCheck ID: ${checkResult.check_id}\nOpen the AEGIS dashboard to approve or reject.`,
          }],
          isError: true,
        },
      }));
      return;
    }

    // Forward to upstream
    const startTime = Date.now();
    const response = await sendToUpstream(msg);
    const durationMs = Date.now() - startTime;

    // Send trace (fire and forget)
    const resultText = response.result?.content
      ?.map((c: any) => c.text ?? '').join(' ').slice(0, 2000) ?? '';
    const hasError = !!response.error || response.result?.isError;

    httpPostFireAndForget(`${gatewayUrl}/api/v1/traces`, {
      trace_id: require('crypto').randomUUID(),
      agent_id: agentId,
      timestamp: new Date().toISOString(),
      sequence_number: 0,
      input_context: { prompt: `Tool call: ${toolName}` },
      thought_chain: { raw_tokens: '' },
      tool_call: { tool_name: toolName, function: toolName, arguments: args, timestamp: new Date().toISOString() },
      observation: {
        raw_output: hasError ? { error: response.error?.message ?? 'error' } : { result: resultText },
        error: hasError ? (response.error?.message ?? 'Tool error') : undefined,
        duration_ms: durationMs,
      },
      integrity_hash: require('crypto').randomUUID().replace(/-/g, '') + require('crypto').randomUUID().replace(/-/g, ''),
      safety_validation: {
        policy_name: checkResult.policy_name ?? 'aegis-proxy',
        passed: decision === 'allow',
        risk_level: riskLevel,
      },
      approval_status: 'AUTO_APPROVED',
      environment: 'PRODUCTION',
      version: '1.0.0',
    });

    // Forward upstream response to client
    process.stdout.write(encodeJsonRpc(response));
  }

  log(`Proxy started — gateway=${gatewayUrl} agent=${agentId} upstream=${serverCmd.join(' ')}`);
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const serverIdx = args.indexOf('--server');
  const gatewayIdx = args.indexOf('--gateway');
  const agentIdx = args.indexOf('--agent-id');
  const blockingFlag = args.includes('--blocking');

  if (serverIdx === -1) {
    process.stderr.write('Usage: agentguard mcp-proxy --server <cmd...> [--gateway URL] [--agent-id ID] [--blocking]\n');
    process.exit(1);
  }

  // Everything after --server until next flag is the server command
  const serverCmd: string[] = [];
  for (let i = serverIdx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    serverCmd.push(args[i]);
  }

  const gatewayUrl = gatewayIdx !== -1 ? args[gatewayIdx + 1] : 'http://localhost:8080';
  const agentId = agentIdx !== -1 ? args[agentIdx + 1] : 'mcp-proxy';

  startProxy({ serverCmd, gatewayUrl, agentId, blocking: blockingFlag, failOpen: true });
}
