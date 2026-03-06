#!/usr/bin/env node
/**
 * agentguard CLI
 * Usage:
 *   agentguard status
 *   agentguard traces list [--agent <id>] [--limit <n>]
 *   agentguard traces approve <traceId>
 *   agentguard traces reject <traceId> [--reason <text>]
 *   agentguard kill-switch <agentId>
 *   agentguard kill-switch list
 *   agentguard costs [--agent <id>]
 */

import { Command } from 'commander';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(os.homedir(), '.agentguard', 'cli.json');

function loadConfig(): { gateway_url: string } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { gateway_url: process.env.AGENTGUARD_URL ?? 'http://localhost:8080' };
  }
}

function gatewayUrl(): string {
  return loadConfig().gateway_url;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function request(method: string, urlStr: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : undefined;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmt$(n: number) {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(ts: string) {
  return new Date(ts).toLocaleString();
}

function col(text: string, width: number) {
  return String(text ?? '').substring(0, width).padEnd(width);
}

function printTable(headers: string[], widths: number[], rows: string[][]) {
  const line = widths.map(w => '-'.repeat(w)).join('  ');
  console.log(headers.map((h, i) => col(h, widths[i])).join('  '));
  console.log(line);
  rows.forEach(r => console.log(r.map((c, i) => col(c, widths[i])).join('  ')));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('agentguard')
  .description('CLI for AEGIS AgentGuard gateway')
  .version('1.0.0');

// ── configure ────────────────────────────────────────────────────────────────
program
  .command('configure')
  .description('Set gateway URL')
  .requiredOption('--url <url>', 'Gateway URL (e.g. http://localhost:8080)')
  .action(({ url }) => {
    const dir = path.dirname(CONFIG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ gateway_url: url }, null, 2));
    console.log(`✓ Saved gateway URL: ${url}`);
  });

// ── status ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Check gateway health')
  .action(async () => {
    try {
      const data = await request('GET', `${gatewayUrl()}/health`);
      console.log(`✓ Gateway is UP  —  ${data.timestamp ?? 'ok'}`);
    } catch (e: any) {
      console.error(`✗ Gateway unreachable: ${e.message}`);
      process.exit(1);
    }
  });

// ── traces ─────────────────────────────────────────────────────────────────
const traces = program.command('traces').description('Manage traces');

traces
  .command('list')
  .description('List recent traces')
  .option('-a, --agent <id>',    'Filter by agent ID')
  .option('-l, --limit <n>',     'Number of traces', '20')
  .option('-s, --status <s>',    'Filter by approval status (PENDING|APPROVED|REJECTED)')
  .action(async (opts) => {
    const params = new URLSearchParams({ limit: opts.limit });
    if (opts.agent)  params.set('agent_id', opts.agent);
    if (opts.status) params.set('approval_status', opts.status);

    const data = await request('GET', `${gatewayUrl()}/api/v1/traces?${params}`);
    if (!data.traces?.length) { console.log('No traces found.'); return; }

    printTable(
      ['TRACE ID (short)', 'AGENT', 'TOOL', 'STATUS', 'TIMESTAMP'],
      [18, 12, 24, 10, 20],
      data.traces.map((t: any) => [
        String(t.trace_id).substring(0, 18),
        String(t.agent_id).substring(0, 12),
        t.tool_call?.tool_name ?? '?',
        t.approval_status ?? 'PENDING',
        fmtDate(t.timestamp),
      ])
    );
    console.log(`\n${data.traces.length} traces`);
  });

traces
  .command('approve <traceId>')
  .description('Approve a trace')
  .option('-b, --by <name>', 'Approver name', 'cli-user')
  .action(async (traceId, opts) => {
    await request('PATCH', `${gatewayUrl()}/api/v1/traces/${traceId}`, {
      approval_status: 'APPROVED',
      approved_by: opts.by,
    });
    console.log(`✓ Trace ${traceId} approved`);
  });

traces
  .command('reject <traceId>')
  .description('Reject a trace')
  .option('-r, --reason <text>', 'Rejection reason')
  .option('-b, --by <name>',     'Approver name', 'cli-user')
  .action(async (traceId, opts) => {
    await request('PATCH', `${gatewayUrl()}/api/v1/traces/${traceId}`, {
      approval_status: 'REJECTED',
      approved_by: opts.by,
      rejection_reason: opts.reason,
    });
    console.log(`✓ Trace ${traceId} rejected`);
  });

// ── kill-switch ─────────────────────────────────────────────────────────────
const ks = program.command('kill-switch').description('Manage agent kill-switch');

ks
  .command('revoke <agentId>')
  .description('Revoke an agent\'s API key (kill switch)')
  .option('-r, --reason <text>', 'Revocation reason', 'CLI revocation')
  .action(async (agentId, opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/kill-switch/revoke`, {
      agent_id: agentId,
      reason: opts.reason,
    });
    if (data.revoked) {
      console.log(`✓ Agent ${agentId} revoked  —  ${data.reason}`);
    } else {
      console.log('Response:', JSON.stringify(data, null, 2));
    }
  });

ks
  .command('list')
  .description('List all agent API key statuses')
  .action(async () => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/kill-switch`);
    if (!data.agents?.length) { console.log('No agents registered.'); return; }
    printTable(
      ['AGENT ID', 'STATUS', 'REVOKED AT', 'REASON'],
      [36, 10, 22, 30],
      data.agents.map((a: any) => [
        a.agent_id,
        a.status,
        a.revoked_at ? fmtDate(a.revoked_at) : '-',
        a.revocation_reason ?? '-',
      ])
    );
  });

// ── costs ───────────────────────────────────────────────────────────────────
program
  .command('costs')
  .description('Show token cost summary')
  .option('-a, --agent <id>', 'Filter by agent ID')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.agent) params.set('agent_id', opts.agent);

    const data = await request('GET', `${gatewayUrl()}/api/v1/traces/stats/cost?${params}`);

    console.log(`\nTotal spend:  ${fmt$(data.total_cost_usd ?? 0)}`);
    console.log(`Input tokens: ${(data.total_input_tokens ?? 0).toLocaleString()}`);
    console.log(`Output tokens:${(data.total_output_tokens ?? 0).toLocaleString()}\n`);

    if (data.by_agent_model?.length) {
      printTable(
        ['AGENT', 'MODEL', 'TRACES', 'TOKENS', 'COST'],
        [12, 32, 8, 12, 10],
        data.by_agent_model.map((r: any) => [
          String(r.agent_id).substring(0, 12),
          String(r.model ?? 'unknown'),
          String(r.trace_count ?? 0),
          ((r.total_input_tokens ?? 0) + (r.total_output_tokens ?? 0)).toLocaleString(),
          fmt$(r.total_cost_usd ?? 0),
        ])
      );
    }
  });

// ── policies ─────────────────────────────────────────────────────────────────
program
  .command('policies')
  .description('List all policies')
  .action(async () => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/policies`);
    const list: any[] = Array.isArray(data) ? data : (data.policies ?? []);
    if (!list.length) { console.log('No policies found.'); return; }
    printTable(
      ['ID', 'NAME', 'RISK', 'ENABLED'],
      [20, 30, 10, 8],
      list.map(p => [p.id, p.name, p.risk_level, p.enabled ? 'yes' : 'no'])
    );
  });

program.parse(process.argv);
