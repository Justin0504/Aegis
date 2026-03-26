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

// ── judge (LLM-as-a-Judge) ────────────────────────────────────────────────────
const judge = program.command('judge').description('LLM-as-a-Judge evaluation');

judge
  .command('trace <traceId>')
  .description('Evaluate a single trace with LLM judge')
  .requiredOption('-p, --provider <provider>', 'LLM provider (openai|anthropic)')
  .requiredOption('-k, --api-key <key>', 'LLM API key')
  .option('-m, --model <model>', 'Override default model')
  .action(async (traceId, opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/judge/trace/${traceId}`, {
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    console.log(`\nVerdict for ${traceId}:`);
    console.log(`  Score: ${data.overall_score}/5 (${data.overall_label})`);
    console.log(`  Model: ${data.model_used} (${data.latency_ms}ms)`);
    if (data.dimensions?.length) {
      for (const d of data.dimensions) {
        console.log(`  ${d.name}: ${d.score}/5 — ${d.reasoning}`);
      }
    }
    console.log(`  Summary: ${data.summary}\n`);
  });

judge
  .command('batch')
  .description('Batch-evaluate unscored traces')
  .requiredOption('-p, --provider <provider>', 'LLM provider (openai|anthropic)')
  .requiredOption('-k, --api-key <key>', 'LLM API key')
  .option('-n, --batch-size <n>', 'Number of traces to judge', '10')
  .option('-m, --model <model>', 'Override default model')
  .action(async (opts) => {
    console.log(`Judging up to ${opts.batchSize} unscored traces...`);
    const data = await request('POST', `${gatewayUrl()}/api/v1/judge/batch`, {
      provider: opts.provider,
      apiKey: opts.apiKey,
      batchSize: parseInt(opts.batchSize, 10),
      model: opts.model,
    });
    console.log(`\nJudged: ${data.judged} traces`);
    if (data.avg_score != null) console.log(`Average score: ${data.avg_score}/5`);
    if (data.verdicts?.length) {
      printTable(
        ['TRACE ID', 'SCORE', 'LABEL', 'SUMMARY'],
        [36, 6, 12, 40],
        data.verdicts.map((v: any) => [
          v.trace_id,
          `${v.overall_score}/5`,
          v.overall_label,
          (v.summary || '').substring(0, 40),
        ])
      );
    }
  });

judge
  .command('stats')
  .description('Show LLM judge statistics')
  .action(async () => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/judge/stats`);
    const o = data.overall;
    console.log(`\nLLM Judge Statistics:`);
    console.log(`  Total judged: ${o?.total_judged ?? 0}`);
    console.log(`  Avg score:    ${o?.avg_score ? Number(o.avg_score).toFixed(2) : 'N/A'}/5`);
    console.log(`  Good (4-5):   ${o?.good_count ?? 0}`);
    console.log(`  Bad (1-2):    ${o?.bad_count ?? 0}`);
    console.log(`  Avg latency:  ${o?.avg_latency_ms ? Math.round(o.avg_latency_ms) : 'N/A'}ms`);
    if (data.by_dimension?.length) {
      console.log(`\n  Per-dimension averages:`);
      for (const d of data.by_dimension) {
        console.log(`    ${d.dimension}: ${Number(d.avg_score).toFixed(2)}/5 (${d.count} evals)`);
      }
    }
    if (data.recent_bad?.length) {
      console.log(`\n  Recent low-scoring traces:`);
      for (const t of data.recent_bad) {
        console.log(`    ${t.trace_id} — ${t.overall_score}/5 (${t.overall_label}) — ${t.summary}`);
      }
    }
    console.log();
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

// ── Helpers for hook commands ────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', () => resolve(data.trim()));
    setTimeout(() => resolve(data.trim()), 3000);
  });
}

async function pollCheckDecision(checkId: string, gw: string, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await request('GET', `${gw}/api/v1/check/${checkId}/decision`);
      if (res.decision === 'allow' || res.decision === 'block') return res.decision;
    } catch {}
  }
  return 'block'; // fail-safe on timeout
}

// ── hook ─────────────────────────────────────────────────────────────────────
const hook = program.command('hook').description('Hook handlers (invoked by Claude Code — not for direct use)');

hook
  .command('pre-tool-use')
  .description('PreToolUse hook: check tool call against AEGIS policies')
  .action(async () => {
    const raw = await readStdin();
    let event: any = {};
    try { event = raw ? JSON.parse(raw) : {}; } catch {}

    const toolName  = String(event.tool_name  ?? '');
    const toolInput = event.tool_input ?? {};
    const sessionId = String(event.session_id ?? '');
    const gw        = process.env.AGENTGUARD_URL ?? loadConfig().gateway_url;
    const agentId   = process.env.AGENTGUARD_AGENT_ID ?? 'claude-code';
    const blocking  = process.env.AGENTGUARD_BLOCKING === 'true';

    if (!toolName) process.exit(0);

    try {
      const result = await request('POST', `${gw}/api/v1/check`, {
        agent_id:    agentId,
        tool_name:   toolName,
        arguments:   toolInput,
        environment: 'claude-code',
        blocking:    false,
      });

      if (result.decision === 'block') {
        const reason = result.reason ?? `${result.risk_level ?? 'HIGH'} risk tool blocked by AEGIS policy`;
        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        process.exit(2);
      }

      if (blocking && result.decision === 'pending') {
        process.stderr.write(`[AEGIS] Waiting for human approval (check: ${result.check_id})...\n`);
        const decision = await pollCheckDecision(result.check_id, gw);
        if (decision !== 'allow') {
          process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Rejected by reviewer' }));
          process.exit(2);
        }
      }

      process.exit(0);
    } catch {
      // Fail-open: gateway unreachable should not block the user
      process.stderr.write('[AEGIS] Gateway unreachable — allowing tool call (fail-open)\n');
      process.exit(0);
    }
  });

hook
  .command('post-tool-use')
  .description('PostToolUse hook: record trace to AEGIS gateway')
  .action(async () => {
    const raw = await readStdin();
    let event: any = {};
    try { event = raw ? JSON.parse(raw) : {}; } catch {}

    const gw       = process.env.AGENTGUARD_URL ?? loadConfig().gateway_url;
    const agentId  = process.env.AGENTGUARD_AGENT_ID ?? 'claude-code';
    const toolName = String(event.tool_name ?? '');
    const sessionId = String(event.session_id ?? '');

    // Fire-and-forget — never block Claude Code
    request('POST', `${gw}/api/v1/traces`, [{
      agent_id:    agentId,
      session_id:  sessionId,
      tool_name:   toolName,
      tool_call:   event.tool_input ?? {},
      observation: { raw_output: event.tool_response ?? null },
      timestamp:   new Date().toISOString(),
      environment: 'claude-code',
      hash_chain:  'hook',
      blocked:     false,
    }]).catch(() => {});

    process.exit(0);
  });

// ── claude-code ───────────────────────────────────────────────────────────────
const cc = program.command('claude-code').description('Claude Code integration');

cc
  .command('setup')
  .description('Configure Claude Code hooks to audit every tool call via AEGIS')
  .option('--gateway <url>',   'AEGIS gateway URL', '')
  .option('--agent-id <id>',   'Agent ID to tag traces with', 'claude-code')
  .option('--blocking',        'Block HIGH/CRITICAL risk tools (requires human approval)')
  .option('--dry-run',         'Print config without writing to disk')
  .action((opts) => {
    const gw      = opts.gateway || loadConfig().gateway_url;
    const agentId = opts.agentId;
    const blockEnv = opts.blocking ? ' AGENTGUARD_BLOCKING=true' : '';

    const preCmd  = `AGENTGUARD_URL=${gw} AGENTGUARD_AGENT_ID=${agentId}${blockEnv} agentguard hook pre-tool-use`;
    const postCmd = `AGENTGUARD_URL=${gw} AGENTGUARD_AGENT_ID=${agentId} agentguard hook post-tool-use`;

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings: any = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

    settings.hooks = settings.hooks ?? {};
    settings.hooks.PreToolUse = [{ matcher: '.*', hooks: [{ type: 'command', command: preCmd }] }];
    settings.hooks.PostToolUse = [{ matcher: '.*', hooks: [{ type: 'command', command: postCmd }] }];

    if (opts.dryRun) {
      console.log('Would write to:', settingsPath);
      console.log(JSON.stringify(settings, null, 2));
      return;
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`✓ Hooks configured in ${settingsPath}`);
    console.log(`  Gateway:  ${gw}`);
    console.log(`  Agent ID: ${agentId}`);
    console.log(`  Blocking: ${opts.blocking ? 'enabled (HIGH/CRITICAL requires approval)' : 'disabled (audit-only)'}`);
    console.log('\nRestart Claude Code for changes to take effect.');
  });

cc
  .command('status')
  .description('Show Claude Code integration status and recent traces')
  .option('-a, --agent-id <id>', 'Agent ID', 'claude-code')
  .action(async (opts) => {
    // Check hook config
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let hooksOk = false;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      hooksOk = settings.hooks?.PreToolUse?.some(
        (h: any) => h.hooks?.some((hh: any) => String(hh.command ?? '').includes('agentguard'))
      ) ?? false;
    } catch {}

    console.log(`\nClaude Code hooks:  ${hooksOk ? '✓ configured' : '✗ not configured  (run: agentguard claude-code setup)'}`);

    // Gateway health
    try {
      const health = await request('GET', `${gatewayUrl()}/health`);
      console.log(`Gateway:            ✓ UP  (${health.timestamp ?? 'ok'})`);
    } catch {
      console.log(`Gateway:            ✗ unreachable at ${gatewayUrl()}`);
    }

    // Recent traces
    try {
      const params = new URLSearchParams({ limit: '5', agent_id: opts.agentId });
      const data = await request('GET', `${gatewayUrl()}/api/v1/traces?${params}`);
      const list: any[] = data.traces ?? [];
      console.log(`\nRecent traces (agent=${opts.agentId}):`);
      if (!list.length) {
        console.log('  No traces yet — run Claude Code and AEGIS will appear here.');
      } else {
        printTable(
          ['TOOL', 'STATUS', 'TIMESTAMP'],
          [28, 14, 22],
          list.map((t: any) => [
            t.tool_call?.tool_name ?? t.tool_name ?? '?',
            t.approval_status ?? 'RECORDED',
            fmtDate(t.timestamp),
          ])
        );
      }
    } catch {}
    console.log('');
  });

cc
  .command('mcp-config')
  .description('Print MCP server config snippet to add AEGIS audit tools to Claude Code')
  .option('--gateway <url>', 'AEGIS gateway URL', '')
  .action((opts) => {
    const gw = opts.gateway || loadConfig().gateway_url;
    const wsUrl = gw.replace(/^http/, 'ws');
    const snippet = {
      mcpServers: {
        'aegis-audit': { url: `${wsUrl}/mcp-audit` },
      },
    };
    console.log('\nAdd this to ~/.claude/claude_desktop_config.json (merge with existing mcpServers):\n');
    console.log(JSON.stringify(snippet, null, 2));
    console.log('\nThen Claude Code can use tools like:');
    console.log('  query_traces, list_violations, get_agent_stats, list_policies\n');
  });

// ── anomalies ─────────────────────────────────────────────────────────────────
const anomalies = program.command('anomalies').description('View behavioral anomaly events');

anomalies
  .command('list')
  .description('List recent anomaly events')
  .option('-a, --agent <id>',    'Filter by agent ID')
  .option('-l, --limit <n>',     'Number of events', '20')
  .option('-d, --decision <d>',  'Filter by decision (flag|escalate|block)')
  .option('-s, --min-score <n>', 'Minimum anomaly score', '0.3')
  .action(async (opts) => {
    const params = new URLSearchParams({ limit: opts.limit, min_score: opts.minScore });
    if (opts.agent)    params.set('agent_id', opts.agent);
    if (opts.decision) params.set('decision', opts.decision);

    const data = await request('GET', `${gatewayUrl()}/api/v1/anomalies?${params}`);
    const events: any[] = data.events ?? [];
    if (!events.length) { console.log('No anomaly events found.'); return; }

    printTable(
      ['AGENT', 'SCORE', 'DECISION', 'TOP SIGNAL', 'TIMESTAMP'],
      [14, 8, 10, 32, 20],
      events.map((e: any) => {
        const signals = typeof e.signals === 'string' ? JSON.parse(e.signals) : e.signals;
        const top = signals?.[0];
        return [
          String(e.agent_id).substring(0, 14),
          e.composite_score.toFixed(2),
          e.decision,
          top ? `${top.type} (${top.score.toFixed(2)})` : '-',
          e.created_at ? fmtDate(e.created_at) : '-',
        ];
      })
    );
    console.log(`\n${events.length} of ${data.total ?? events.length} events`);
  });

anomalies
  .command('summary <agentId>')
  .description('Show anomaly summary for a specific agent')
  .action(async (agentId) => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/agents/${agentId}/anomaly-summary`);
    console.log(`\nAnomaly Summary for ${agentId}`);
    console.log(`Total events: ${data.total_events ?? 0}`);

    const dec = data.by_decision ?? {};
    console.log(`\nBy decision:`);
    for (const [d, count] of Object.entries(dec)) {
      console.log(`  ${col(d, 10)} ${count}`);
    }

    const topSig: any[] = data.top_signals ?? [];
    if (topSig.length) {
      console.log('\nTop signals:');
      printTable(
        ['SIGNAL TYPE', 'COUNT', 'AVG SCORE'],
        [24, 8, 10],
        topSig.map(s => [s.type, String(s.count), s.avg_score.toFixed(2)])
      );
    }

    const trend: any[] = data.trend_7d ?? [];
    if (trend.length) {
      console.log('\n7-day trend:');
      for (const t of trend) {
        const bar = '#'.repeat(Math.min(t.count, 50));
        console.log(`  ${t.day}  ${bar} ${t.count}`);
      }
    }
    console.log('');
  });

// ── mcp-proxy ─────────────────────────────────────────────────────────────────
program
  .command('mcp-proxy')
  .description('Start AEGIS MCP stdio proxy — wraps any MCP server with policy enforcement')
  .requiredOption('--server <cmd...>', 'Upstream MCP server command (e.g. npx -y @modelcontextprotocol/server-filesystem /)')
  .option('--gateway <url>',  'AEGIS gateway URL', '')
  .option('--agent-id <id>',  'Agent ID', 'mcp-proxy')
  .option('--blocking',       'Enable blocking mode (HIGH/CRITICAL requires human approval)')
  .action(async (opts) => {
    const { startProxy } = require('./mcp-proxy');
    const gw = opts.gateway || loadConfig().gateway_url;
    await startProxy({
      serverCmd: opts.server,
      gatewayUrl: gw,
      agentId: opts.agentId,
      blocking: opts.blocking ?? false,
      failOpen: true,
    });
  });

// ── http-proxy ───────────────────────────────────────────────────────────────
program
  .command('http-proxy')
  .description('Start AEGIS HTTP forward proxy — intercepts LLM API calls (Anthropic/OpenAI)')
  .option('-p, --port <port>',      'Proxy listen port', '8081')
  .option('--gateway <url>',        'AEGIS gateway URL', '')
  .option('--agent-id <id>',        'Agent ID', 'http-proxy')
  .option('--upstream <provider>',   'Upstream provider: anthropic | openai | auto', 'auto')
  .option('--upstream-url <url>',    'Override upstream base URL')
  .option('--blocking',             'Enable blocking mode')
  .option('-v, --verbose',          'Verbose logging')
  .action(async (opts) => {
    const { startHttpProxy } = require('./http-proxy');
    const gw = opts.gateway || loadConfig().gateway_url;
    await startHttpProxy({
      listenPort: parseInt(opts.port, 10),
      gatewayUrl: gw,
      agentId: opts.agentId,
      blocking: opts.blocking ?? false,
      upstream: opts.upstream,
      upstreamUrl: opts.upstreamUrl,
      verbose: opts.verbose ?? false,
    });
  });

// ── openclaw ──────────────────────────────────────────────────────────────────
const oc = program.command('openclaw').description('OpenClaw integration');

oc
  .command('setup')
  .description('Auto-configure OpenClaw to use AEGIS-proxied MCP servers')
  .option('--gateway <url>',    'AEGIS gateway URL', '')
  .option('--agent-id <id>',    'Agent ID', 'openclaw')
  .option('--servers <list>',   'Comma-separated MCP servers (default: filesystem)', 'filesystem')
  .option('--blocking',         'Block HIGH/CRITICAL risk tools (requires human approval)')
  .option('--config-path <p>',  'OpenClaw config file path', '')
  .option('--dry-run',          'Print config without writing to disk')
  .action((opts) => {
    const gw      = opts.gateway || loadConfig().gateway_url;
    const agentId = opts.agentId;
    const servers = opts.servers.split(',').map((s: string) => s.trim());
    const blockingFlag = opts.blocking ? ' --blocking' : '';

    const knownServers: Record<string, { cmd: string; args: string[] }> = {
      filesystem: { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] },
      github:     { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      postgres:   { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
      memory:     { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      brave:      { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
      fetch:      { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
      puppeteer:  { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    };

    const mcpServers: Record<string, any> = {};

    // Add AEGIS audit server (direct, no proxy needed)
    const wsUrl = gw.replace(/^http/, 'ws');
    mcpServers['aegis-audit'] = { url: `${wsUrl}/mcp-audit` };

    // Add proxied upstream servers
    for (const name of servers) {
      const known = knownServers[name];
      const serverArgs = known
        ? [known.cmd, ...known.args]
        : [`npx`, `-y`, `@modelcontextprotocol/server-${name}`];

      mcpServers[`aegis-${name}`] = {
        command: 'agentguard',
        args: [
          'mcp-proxy',
          '--server', ...serverArgs,
          '--gateway', gw,
          '--agent-id', agentId,
          ...(opts.blocking ? ['--blocking'] : []),
        ],
      };
    }

    const configObj = { mcpServers };

    // Determine config file path
    const configPath = opts.configPath || path.join(os.homedir(), '.openclaw', 'config.json');

    if (opts.dryRun) {
      console.log('Would write to:', configPath);
      console.log(JSON.stringify(configObj, null, 2));
      return;
    }

    // Read existing config and merge
    let existing: any = {};
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    existing.mcpServers = { ...(existing.mcpServers ?? {}), ...mcpServers };

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));

    console.log(`✓ OpenClaw configured with AEGIS proxy`);
    console.log(`  Config: ${configPath}`);
    console.log(`  Gateway: ${gw}`);
    console.log(`  Agent ID: ${agentId}`);
    console.log(`  Servers: ${servers.join(', ')}`);
    console.log(`  Blocking: ${opts.blocking ? 'enabled' : 'disabled'}`);
    console.log(`  Audit tools: aegis-audit (query_traces, list_violations, query_anomalies)`);
    console.log(`\nHow it works:`);
    console.log(`  OpenClaw → agentguard mcp-proxy → Policy Check → Upstream MCP Server`);
    console.log(`  Every tool call is policy-checked, anomaly-scored, and logged.`);
    console.log(`\nFor full LLM API interception (HTTP proxy), also run:`);
    console.log(`  agentguard http-proxy --gateway ${gw} --agent-id ${agentId}`);
    console.log(`  export ANTHROPIC_BASE_URL=http://localhost:8081`);
    console.log(`  export OPENAI_BASE_URL=http://localhost:8081/v1`);
  });

oc
  .command('mcp-config')
  .description('Print AEGIS-proxied MCP server config snippet (use `setup` to auto-write)')
  .option('--gateway <url>',    'AEGIS gateway URL', '')
  .option('--agent-id <id>',    'Agent ID', 'openclaw')
  .option('--servers <list>',   'Comma-separated MCP servers to proxy', 'filesystem')
  .option('--python',           'Use Python proxy instead of TypeScript (requires pip install mcp)')
  .action((opts) => {
    const gw      = opts.gateway || loadConfig().gateway_url;
    const agentId = opts.agentId;
    const servers = opts.servers.split(',').map((s: string) => s.trim());
    const usePython = opts.python ?? false;

    const knownServers: Record<string, { cmd: string; args: string[] }> = {
      filesystem: { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] },
      github:     { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      postgres:   { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
      memory:     { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      brave:      { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
      fetch:      { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
      puppeteer:  { cmd: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
    };

    const mcpServers: Record<string, any> = {};
    const wsUrl = gw.replace(/^http/, 'ws');
    mcpServers['aegis-audit'] = { url: `${wsUrl}/mcp-audit` };

    for (const name of servers) {
      const known = knownServers[name];
      const serverArgs = known
        ? [known.cmd, ...known.args]
        : ['npx', '-y', `@modelcontextprotocol/server-${name}`];

      if (usePython) {
        mcpServers[`aegis-${name}`] = {
          command: 'python',
          args: ['-m', 'agentguard.mcp_proxy', '--server', ...serverArgs, '--gateway', gw, '--agent-id', agentId],
        };
      } else {
        mcpServers[`aegis-${name}`] = {
          command: 'agentguard',
          args: ['mcp-proxy', '--server', ...serverArgs, '--gateway', gw, '--agent-id', agentId],
        };
      }
    }

    console.log('\nMerge into your OpenClaw/Claude Desktop config:\n');
    console.log(JSON.stringify({ mcpServers }, null, 2));
    console.log('\nFlow: Client → agentguard mcp-proxy → Policy + Anomaly Check → Upstream MCP Server');
    console.log(`\nPrerequisites:`);
    console.log(`  npm link @agentguard/cli   (or: npx agentguard)`);
    if (usePython) console.log('  pip install agentguard-aegis mcp');
    console.log(`  AEGIS gateway running at ${gw}\n`);
    console.log('Tip: use `agentguard openclaw setup` to auto-write config.\n');
  });

oc
  .command('status')
  .description('Show OpenClaw integration status and recent traces')
  .option('-a, --agent-id <id>', 'Agent ID', 'openclaw')
  .action(async (opts) => {
    // Gateway health
    try {
      const health = await request('GET', `${gatewayUrl()}/health`);
      console.log(`\nGateway:  ✓ UP  (${health.timestamp ?? 'ok'})`);
    } catch {
      console.log(`\nGateway:  ✗ unreachable at ${gatewayUrl()}`);
    }

    // Recent traces
    try {
      const params = new URLSearchParams({ limit: '5', agent_id: opts.agentId });
      const data   = await request('GET', `${gatewayUrl()}/api/v1/traces?${params}`);
      const list: any[] = data.traces ?? [];
      console.log(`\nRecent traces (agent=${opts.agentId}):`);
      if (!list.length) {
        console.log('  No traces yet — start OpenClaw with AGENTGUARD_URL set to see traces here.');
      } else {
        printTable(
          ['TOOL', 'STATUS', 'TIMESTAMP'],
          [28, 14, 22],
          list.map((t: any) => [
            t.tool_call?.tool_name ?? t.tool_name ?? '?',
            t.approval_status ?? 'RECORDED',
            fmtDate(t.timestamp),
          ])
        );
      }
    } catch {}

    console.log('\nCoverage matrix:');
    console.log('  MCP skills (filesystem, github …)   intercepted if proxy configured');
    console.log('  OpenClaw messaging (Telegram, Slack) NOT intercepted');
    console.log('  Python SDK auto-patch                intercepted if AGENTGUARD_URL set\n');
  });

program.parse(process.argv);
