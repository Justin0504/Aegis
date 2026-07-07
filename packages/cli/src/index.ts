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

function loadConfig(): { gateway_url: string; api_key?: string } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // Canonical env: AEGIS_GATEWAY_URL. Legacy: AGENTGUARD_URL.
    return {
      gateway_url:
        process.env.AEGIS_GATEWAY_URL ??
        process.env.AGENTGUARD_URL ??
        'http://localhost:8080',
    };
  }
}

function gatewayUrl(): string {
  return loadConfig().gateway_url;
}

function apiKey(): string | undefined {
  // Canonical env: AEGIS_API_KEY. Legacy: AGENTGUARD_API_KEY.
  return (
    process.env.AEGIS_API_KEY ||
    process.env.AGENTGUARD_API_KEY ||
    loadConfig().api_key
  );
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

interface RequestOpts {
  /** Override the API key for this request. */
  apiKey?: string;
  /** Skip auth even if a key is available — used by the bootstrap call. */
  noAuth?: boolean;
  /** Per-request status code if non-2xx — wraps the resolved value. */
  expectJson?: boolean;
}

function request(
  method: string,
  urlStr: string,
  body?: object,
  opts: RequestOpts = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string | number> = {
      'Content-Type':   'application/json',
      'Content-Length': data ? Buffer.byteLength(data) : 0,
    };
    if (!opts.noAuth) {
      const key = opts.apiKey ?? apiKey();
      if (key) headers['X-API-Key'] = key;
    }

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
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

// ── Output-mode helpers ─────────────────────────────────────────────
//
// Every command that opts in checks `jsonMode()` and either
// `emitHuman(...)` (a table, coloured chips, whatever fits the eye) or
// `emitJSON(obj)` (a single line, machine-parseable). The pattern is
// `if (jsonMode()) return emitJSON(obj);` at the top of the action —
// keeps the readable path unchanged for the majority of interactive use.
//
// Not every command has been migrated yet; new commands (tail, replay,
// completion below) are JSON-aware from birth. Migrating the older
// ones is mechanical and can happen incrementally.
function jsonMode(): boolean {
  return Boolean(program.opts().json);
}

function emitJSON(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function emitHuman(fn: () => void): void {
  if (jsonMode()) return;
  fn();
}

// ── TTY-aware colour ────────────────────────────────────────────────
//
// Reads NO_COLOR (https://no-color.org) and skips colour when stdout
// isn't a TTY, so `agentguard status | grep OK` and CI logs stay
// clean. Colours are opt-in per call site — no accidental colouring.
const COLOR_ENABLED = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
} as const;

type Colour = keyof typeof ANSI;

function c(text: string, colour: Colour): string {
  if (!COLOR_ENABLED) return text;
  return `${ANSI[colour]}${text}${ANSI.reset}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('agentguard')
  .description('CLI for AEGIS AgentGuard gateway')
  .version('1.0.0')
  // Global machine-readable output. Commands that support it check
  // jsonMode() and emit a single JSON object instead of formatted text.
  // Any script downstream can then `jq` the result.
  .option('--json', 'Emit machine-readable JSON to stdout')
  .option('--no-color', 'Disable ANSI colour (also honours NO_COLOR env)');

// ── configure ────────────────────────────────────────────────────────────────
program
  .command('configure')
  .description('Set gateway URL (and optionally bootstrap an API key)')
  .requiredOption('--url <url>', 'Gateway URL (e.g. http://localhost:8080)')
  .option('--api-key <key>', 'API key for authenticated routes (or use --bootstrap)')
  .option('--bootstrap', 'Auto-fetch the gateway-issued API key (works once, on first connect)')
  .action(async ({ url, apiKey: keyOpt, bootstrap }) => {
    const dir = path.dirname(CONFIG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const existing = loadConfig();
    const next: { gateway_url: string; api_key?: string } = {
      ...existing,
      gateway_url: url,
    };
    if (keyOpt) next.api_key = keyOpt;
    if (bootstrap) {
      try {
        const data = await request('GET', `${url.replace(/\/$/, '')}/api/v1/auth/key`, undefined, { noAuth: true });
        if (data && typeof data === 'object' && data.api_key) {
          next.api_key = data.api_key;
          console.log(`✓ Bootstrapped API key: ${data.api_key.slice(0, 8)}…`);
        } else {
          console.error('⚠ Bootstrap returned no api_key; key may already be issued — pass --api-key explicitly');
        }
      } catch (e) {
        console.error(`⚠ Bootstrap failed: ${(e as Error).message}`);
      }
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    console.log(`✓ Saved gateway URL: ${url}`);
    if (next.api_key) console.log(`✓ Saved API key (${next.api_key.length} chars)`);
  });

// ── status ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Check gateway health')
  .action(async () => {
    try {
      const data = await request('GET', `${gatewayUrl()}/health`);
      if (jsonMode()) return emitJSON({ status: 'up', gateway_url: gatewayUrl(), ...data });
      console.log(`${c('✓', 'green')} Gateway is UP  —  ${data.timestamp ?? 'ok'}`);
    } catch (e: any) {
      if (jsonMode()) { emitJSON({ status: 'down', gateway_url: gatewayUrl(), error: e.message }); process.exit(2); }
      console.error(`${c('✗', 'red')} Gateway unreachable: ${e.message}`);
      process.exit(2);
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
    if (jsonMode()) return emitJSON({ traces: data.traces ?? [], total: data.total ?? data.traces?.length ?? 0 });
    if (!data.traces?.length) { console.log('No traces found.'); return; }

    printTable(
      ['TRACE ID (short)', 'AGENT', 'TOOL', 'STATUS', 'TIMESTAMP'],
      [18, 12, 24, 10, 20],
      data.traces.map((t: any) => [
        String(t.trace_id).substring(0, 18),
        String(t.agent_id).substring(0, 12),
        t.tool_call?.tool_name ?? '?',
        colouredStatus(t.approval_status ?? 'PENDING'),
        fmtDate(t.timestamp),
      ])
    );
    console.log(`\n${data.traces.length} traces`);
  });

// Small helper — coloured status chip. Kept local so command action
// bodies don't drown in colour logic.
function colouredStatus(status: string): string {
  if (status === 'APPROVED')          return c(status, 'green');
  if (status === 'REJECTED')          return c(status, 'red');
  if (status === 'PENDING_APPROVAL')  return c(status, 'yellow');
  return status;
}

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
    if (jsonMode()) return emitJSON(data);

    console.log(`\nTotal spend:  ${c(fmt$(data.total_cost_usd ?? 0), 'bold')}`);
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
    // Also render the new by-tool aggregation (Cockpit shows this too).
    if (data.by_tool?.length) {
      console.log(`\n${c('By tool:', 'dim')}`);
      printTable(
        ['TOOL', 'CALLS', 'TOKENS', 'COST'],
        [32, 8, 12, 10],
        data.by_tool.slice(0, 10).map((r: any) => [
          String(r.tool_name ?? '(unknown)').substring(0, 32),
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
  .requiredOption('-p, --provider <provider>', 'LLM provider (openai|anthropic|gemini)')
  .requiredOption('-k, --api-key <key>', 'LLM API key')
  .option('-m, --model <model>', 'Override default model')
  .option('--rejudge', 'Re-evaluate even if already judged')
  .option('-d, --dimensions <dims>', 'Comma-separated dimensions to evaluate')
  .action(async (traceId, opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/judge/trace/${traceId}`, {
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      forceRejudge: opts.rejudge ?? false,
      dimensions: opts.dimensions ? opts.dimensions.split(',') : undefined,
    });
    console.log(`\nVerdict for ${traceId}:`);
    console.log(`  Score: ${data.overall_score}/5 (${data.overall_label})`);
    console.log(`  Model: ${data.model_used} (${data.latency_ms}ms)`);
    if (data.dimensions?.length) {
      for (const d of data.dimensions) {
        const bar = '█'.repeat(d.score) + '░'.repeat(5 - d.score);
        console.log(`  ${d.name.padEnd(14)} ${bar} ${d.score}/5 — ${d.reasoning}`);
      }
    }
    console.log(`  Summary: ${data.summary}\n`);
  });

judge
  .command('batch')
  .description('Batch-evaluate unscored traces')
  .requiredOption('-p, --provider <provider>', 'LLM provider (openai|anthropic|gemini)')
  .requiredOption('-k, --api-key <key>', 'LLM API key')
  .option('-n, --batch-size <n>', 'Number of traces to judge', '10')
  .option('-m, --model <model>', 'Override default model')
  .option('-c, --concurrency <n>', 'Parallel LLM calls', '3')
  .option('-a, --agent <id>', 'Filter to specific agent')
  .option('--rejudge', 'Re-evaluate already scored traces')
  .option('-d, --dimensions <dims>', 'Comma-separated dimensions to evaluate')
  .action(async (opts) => {
    const agent = opts.agent ? ` for agent ${opts.agent}` : '';
    console.log(`Judging up to ${opts.batchSize} traces${agent} (concurrency: ${opts.concurrency})...`);
    const data = await request('POST', `${gatewayUrl()}/api/v1/judge/batch`, {
      provider: opts.provider,
      apiKey: opts.apiKey,
      batchSize: parseInt(opts.batchSize, 10),
      model: opts.model,
      concurrency: parseInt(opts.concurrency, 10),
      agentId: opts.agent,
      forceRejudge: opts.rejudge ?? false,
      dimensions: opts.dimensions ? opts.dimensions.split(',') : undefined,
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
  .option('-a, --agent <id>', 'Show stats for specific agent')
  .action(async (opts) => {
    const url = opts.agent
      ? `${gatewayUrl()}/api/v1/judge/stats?agent_id=${encodeURIComponent(opts.agent)}`
      : `${gatewayUrl()}/api/v1/judge/stats`;
    const data = await request('GET', url);
    const o = data.overall;
    const header = opts.agent ? `LLM Judge Statistics (${opts.agent}):` : 'LLM Judge Statistics:';
    console.log(`\n${header}`);
    console.log(`  Total judged: ${o?.total_judged ?? 0}`);
    console.log(`  Avg score:    ${o?.avg_score ? Number(o.avg_score).toFixed(2) : 'N/A'}/5`);
    console.log(`  Good (4-5):   ${o?.good_count ?? 0}`);
    console.log(`  Bad (1-2):    ${o?.bad_count ?? 0}`);
    console.log(`  Avg latency:  ${o?.avg_latency_ms ? Math.round(o.avg_latency_ms) : 'N/A'}ms`);
    if (data.score_trend != null) {
      const sign = data.score_trend > 0 ? '+' : '';
      console.log(`  24h trend:    ${sign}${data.score_trend} pts`);
    }
    if (data.distribution?.length) {
      console.log(`\n  Score distribution:`);
      const total = data.distribution.reduce((s: number, d: any) => s + d.count, 0);
      for (const d of data.distribution) {
        const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 3)) || '░';
        console.log(`    ${d.score}/5: ${bar} ${d.count} (${pct}%)`);
      }
    }
    if (data.by_dimension?.length) {
      console.log(`\n  Per-dimension averages:`);
      for (const d of data.by_dimension) {
        console.log(`    ${(d.dimension || '').padEnd(14)} ${Number(d.avg_score).toFixed(2)}/5 (${d.count} evals)`);
      }
    }
    if (data.by_model?.length) {
      console.log(`\n  Per-model breakdown:`);
      for (const m of data.by_model) {
        console.log(`    ${m.model_used}: ${m.count} evals, avg ${Number(m.avg_score).toFixed(2)}/5, ${Math.round(m.avg_latency_ms)}ms`);
      }
    }
    if (data.by_agent?.length) {
      console.log(`\n  Per-agent breakdown:`);
      for (const a of data.by_agent) {
        console.log(`    ${a.agent_id}: ${a.count} evals, avg ${Number(a.avg_score).toFixed(2)}/5${a.bad_count > 0 ? `, ${a.bad_count} bad` : ''}`);
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

// ── supply-scan (supply chain security) ─────────────────────────────
// Renamed from `scan` to disambiguate from the framework/agent scanner
// below (`agentguard scan <path>`). Commander doesn't allow two
// subcommands with the same name.
program
  .command('supply-scan [dir]')
  .alias('supply-chain-scan')
  .description('Scan directory for supply chain security issues (source maps, secrets, unsafe configs)')
  .option('--fix', 'Auto-fix: add *.map to .npmignore')
  .action(async (dir, opts) => {
    const targetDir = path.resolve(dir || '.');
    console.log(`\nScanning ${targetDir} for supply chain security issues...\n`);

    // Dynamic import from gateway service (shared logic)
    // For CLI, we re-implement lightweight scanning inline
    const issues: Array<{ severity: string; file: string; detail: string }> = [];
    let filesScanned = 0;
    const mapFiles: string[] = [];

    function walk(d: string, depth: number) {
      if (depth > 8) return;
      let entries: string[];
      try { entries = fs.readdirSync(d); } catch { return; }
      for (const entry of entries) {
        if (['node_modules', '.git', '.next', '__pycache__', 'venv'].includes(entry)) continue;
        const full = path.join(d, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { walk(full, depth + 1); continue; }
        if (stat.size > 10 * 1024 * 1024) continue;
        filesScanned++;
        const rel = path.relative(targetDir, full);

        // Source map files
        if (/\.(js|ts|jsx|tsx|css|mjs|cjs)\.map$/i.test(entry)) {
          mapFiles.push(rel);
          issues.push({ severity: 'HIGH', file: rel, detail: `Source map — contains full original source code (${(stat.size / 1024).toFixed(1)}KB)` });
          try {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('"sourcesContent"')) {
              issues.push({ severity: 'CRITICAL', file: rel, detail: 'sourcesContent embedded — ENTIRE source code will be published' });
            }
          } catch {}
          continue;
        }

        // Dangerous files
        const DANGEROUS = ['.env', '.env.local', '.env.production', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519'];
        if (DANGEROUS.includes(entry)) {
          issues.push({ severity: 'CRITICAL', file: rel, detail: `Sensitive file — should not be published` });
          // Check .npmrc for tokens
          if (entry === '.npmrc') {
            try {
              const c = fs.readFileSync(full, 'utf8');
              if (c.includes('_authToken') || c.includes('_auth=')) {
                issues.push({ severity: 'CRITICAL', file: rel, detail: '.npmrc contains auth token' });
              }
            } catch {}
          }
        }

        // Scan JS/TS for secrets and sourceMappingURL
        const ext = path.extname(entry).toLowerCase();
        if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json'].includes(ext) && stat.size < 2 * 1024 * 1024) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            if (/\/\/[#@]\s*sourceMappingURL\s*=/.test(content)) {
              issues.push({ severity: 'MEDIUM', file: rel, detail: 'Contains sourceMappingURL — may expose source map location' });
            }
            const SECRET_PATTERNS = [
              { name: 'AWS Key',       re: /AKIA[0-9A-Z]{16}/ },
              { name: 'GitHub Token',  re: /gh[ps]_[A-Za-z0-9_]{36,}/ },
              { name: 'npm Token',     re: /npm_[A-Za-z0-9]{36,}/ },
              { name: 'Private Key',   re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
              { name: 'Anthropic Key', re: /sk-ant-[A-Za-z0-9_-]{40,}/ },
              { name: 'OpenAI Key',    re: /sk-[A-Za-z0-9]{48,}/ },
              { name: 'Slack Webhook', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+/ },
              { name: 'Database URL',  re: /(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/i },
            ];
            for (const { name, re } of SECRET_PATTERNS) {
              if (re.test(content)) {
                issues.push({ severity: 'CRITICAL', file: rel, detail: `${name} found in build artifact` });
                break;
              }
            }
          } catch {}
        }
      }
    }

    walk(targetDir, 0);

    // Check .npmignore / package.json
    const npmignorePath = path.join(targetDir, '.npmignore');
    const hasNpmignore = fs.existsSync(npmignorePath);
    let excludesMaps = false;
    if (hasNpmignore) {
      try {
        const c = fs.readFileSync(npmignorePath, 'utf8');
        excludesMaps = /\*\.map\b/.test(c);
      } catch {}
    }

    // Report
    const sevOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    issues.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));

    if (issues.length === 0) {
      console.log(`  SAFE — ${filesScanned} files scanned, no issues found.\n`);
    } else {
      const critical = issues.filter(i => i.severity === 'CRITICAL').length;
      const high = issues.filter(i => i.severity === 'HIGH').length;
      console.log(`  ${issues.length} issues found (${critical} critical, ${high} high) in ${filesScanned} files:\n`);
      for (const issue of issues) {
        const badge = issue.severity === 'CRITICAL' ? '\x1b[31mCRITICAL\x1b[0m'
                    : issue.severity === 'HIGH'     ? '\x1b[33mHIGH\x1b[0m'
                    : issue.severity === 'MEDIUM'   ? '\x1b[36mMEDIUM\x1b[0m'
                    : 'LOW';
        console.log(`  [${badge}] ${issue.file}`);
        console.log(`          ${issue.detail}`);
      }
    }

    if (mapFiles.length > 0) {
      console.log(`\n  Source maps found: ${mapFiles.length}`);
      if (!excludesMaps) {
        console.log(`  WARNING: .npmignore does not exclude *.map files`);
      }
    }

    // Publish config check
    console.log(`\n  Publish config:`);
    console.log(`    .npmignore:     ${hasNpmignore ? (excludesMaps ? 'OK (excludes *.map)' : 'EXISTS but missing *.map') : 'MISSING'}`);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
      if (pkg.files) {
        console.log(`    package.json:   "files" field present: ${JSON.stringify(pkg.files)}`);
      } else {
        console.log(`    package.json:   no "files" field (all files will be published)`);
      }
    } catch {
      console.log(`    package.json:   not found`);
    }

    // Auto-fix
    if (opts.fix && mapFiles.length > 0 && !excludesMaps) {
      const line = '*.map\n';
      if (hasNpmignore) {
        fs.appendFileSync(npmignorePath, '\n# Exclude source maps (added by agentguard scan --fix)\n' + line);
      } else {
        fs.writeFileSync(npmignorePath, '# Generated by agentguard scan --fix\n*.map\n.env*\n.npmrc\n');
      }
      console.log(`\n  FIXED: Added *.map to .npmignore`);
    } else if (mapFiles.length > 0 && !excludesMaps) {
      console.log(`\n  Run \x1b[1magentguard scan --fix\x1b[0m to auto-add *.map to .npmignore`);
    }

    console.log();
    process.exit(issues.some(i => i.severity === 'CRITICAL') ? 1 : 0);
  });

// ── code-shield ──────────────────────────────────────────────────────────────
const codeShield = program
  .command('code-shield')
  .description('Static checks on agent-generated code (eval, exec, secrets, dangerous shell/SQL)');

const SEV_COLOR: Record<string, string> = {
  LOW:      '\x1b[2m',   // dim
  MEDIUM:   '\x1b[33m',  // yellow
  HIGH:     '\x1b[31m',  // red
  CRITICAL: '\x1b[31;1m',// bold red
};
const RESET = '\x1b[0m';

function detectLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (['.py', '.pyw'].includes(ext)) return 'python';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'javascript';
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'shell';
  if (['.sql'].includes(ext)) return 'sql';
  return 'any';
}

interface ShieldFinding {
  rule: string; description: string; severity: string;
  language: string; line: number; column: number;
  snippet: string; cwe?: string;
}
interface ShieldResult {
  worst: string | null;
  findings: ShieldFinding[];
  unique_findings: number;
  scanned_chars: number;
  latency_ms: number;
}

function printShieldResult(label: string, result: ShieldResult): void {
  const head =
    result.worst === null
      ? `\x1b[2m✓ clean\x1b[0m  ${label}`
      : `${SEV_COLOR[result.worst] ?? ''}● ${result.worst}${RESET}  ${label}` +
        `  (${result.unique_findings} finding${result.unique_findings === 1 ? '' : 's'}, ${result.latency_ms}ms)`;
  console.log(head);
  for (const f of result.findings) {
    const sev = `${SEV_COLOR[f.severity] ?? ''}${f.severity}${RESET}`;
    console.log(`    ${sev}  ${f.rule}  ${f.line}:${f.column}`);
    console.log(`    ${'\x1b[2m'}${f.description}${RESET}`);
    console.log(`      ${'\x1b[2m'}${f.snippet}${RESET}`);
  }
}

codeShield
  .command('scan <file...>')
  .description('Scan one or more files for unsafe code patterns')
  .option('--language <lang>', 'Override language detection (python|javascript|shell|sql|any)')
  .option('--fail-on <sev>', 'Exit non-zero when any finding reaches this severity (LOW|MEDIUM|HIGH|CRITICAL)', 'HIGH')
  .option('--disable <rules>', 'Comma-separated rule ids to skip (e.g. sh.sudo,js.innerHTML)')
  .action(async (files: string[], opts: Record<string, string>) => {
    const rank: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    const failOn = (opts.failOn || 'HIGH').toUpperCase();
    if (!(failOn in rank)) {
      console.error(`Unknown --fail-on value: ${opts.failOn}`);
      process.exit(2);
    }
    const disabledRules = (opts.disable || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let worstSeenRank = 0;
    for (const f of files) {
      let code: string;
      try {
        code = fs.readFileSync(f, 'utf8');
      } catch (e) {
        console.error(`\x1b[31m✗\x1b[0m cannot read ${f}: ${(e as Error).message}`);
        process.exitCode = 2;
        continue;
      }
      const language = opts.language || detectLanguage(f);
      const body: Record<string, unknown> = { code, language };
      if (disabledRules.length) body.disabled_rules = disabledRules;
      try {
        const result = (await request(
          'POST',
          `${gatewayUrl()}/api/v1/code-shield/scan`,
          body,
        )) as ShieldResult & { error?: string };
        if ('error' in result && result.error) {
          console.error(`\x1b[31m✗\x1b[0m ${f}: gateway error — ${result.error}`);
          process.exitCode = 2;
          continue;
        }
        printShieldResult(f, result);
        if (result.worst && rank[result.worst] > worstSeenRank) {
          worstSeenRank = rank[result.worst];
        }
      } catch (e) {
        console.error(`\x1b[31m✗\x1b[0m ${f}: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    }

    if (worstSeenRank >= rank[failOn]) {
      console.log(
        `\n\x1b[31m✗ exit 1: at least one finding meets --fail-on ${failOn}\x1b[0m`,
      );
      process.exit(1);
    }
  });

codeShield
  .command('rules')
  .description('List built-in CodeShield rules and what each catches')
  .option('--offline', 'Skip gateway lookup; print the bundled fallback catalog')
  .action(async (opts: { offline?: boolean }) => {
    interface RuleRow {
      id: string;
      severity: string;
      language: string;
      description: string;
    }
    // Fallback catalog — used when --offline or the gateway is
    // unreachable. Kept short and in lockstep with the gateway's
    // services/code-shield.ts; the canonical source is the live
    // GET /api/v1/code-shield/rules endpoint.
    const FALLBACK: RuleRow[] = [
      { id: 'py.exec',              severity: 'CRITICAL', language: 'python',     description: 'exec(...) — arbitrary code execution' },
      { id: 'py.eval',              severity: 'CRITICAL', language: 'python',     description: 'eval(...) — arbitrary expression eval' },
      { id: 'py.os.system',         severity: 'HIGH',     language: 'python',     description: 'os.system(...) shell command' },
      { id: 'py.subprocess.shell',  severity: 'HIGH',     language: 'python',     description: 'subprocess with shell=True' },
      { id: 'py.pickle.loads',      severity: 'HIGH',     language: 'python',     description: 'pickle.loads on untrusted input' },
      { id: 'js.eval',              severity: 'CRITICAL', language: 'javascript', description: 'eval(...) — arbitrary code execution' },
      { id: 'js.new-function',      severity: 'CRITICAL', language: 'javascript', description: 'new Function(...) — arbitrary code' },
      { id: 'js.child_process.exec',severity: 'HIGH',     language: 'javascript', description: 'child_process.exec / execSync' },
      { id: 'js.innerHTML',         severity: 'MEDIUM',   language: 'javascript', description: 'innerHTML = var — DOM-based XSS' },
      { id: 'sh.rm-rf-root',        severity: 'CRITICAL', language: 'shell',      description: 'rm -rf / or $HOME' },
      { id: 'sh.curl-pipe-sh',      severity: 'HIGH',     language: 'shell',      description: 'curl ... | sh — unverified install' },
      { id: 'sh.sudo',              severity: 'MEDIUM',   language: 'shell',      description: 'sudo invocation' },
      { id: 'sql.drop-table',       severity: 'HIGH',     language: 'sql',        description: 'DROP TABLE' },
      { id: 'sql.delete-no-where',  severity: 'HIGH',     language: 'sql',        description: 'DELETE FROM ... without WHERE' },
      { id: 'secret.aws-access-key',severity: 'CRITICAL', language: 'any',        description: 'AWS access key (AKIA...)' },
      { id: 'secret.openai-key',    severity: 'CRITICAL', language: 'any',        description: 'OpenAI API key (sk-...)' },
      { id: 'secret.anthropic-key', severity: 'CRITICAL', language: 'any',        description: 'Anthropic key (sk-ant-...)' },
      { id: 'secret.github-token',  severity: 'CRITICAL', language: 'any',        description: 'GitHub token (ghp_ / gho_ / ...)' },
      { id: 'secret.private-key',   severity: 'CRITICAL', language: 'any',        description: 'PEM private key block' },
    ];

    let rules: RuleRow[] = FALLBACK;
    let source = 'bundled fallback';
    if (!opts.offline) {
      try {
        const resp = await request('GET', `${gatewayUrl()}/api/v1/code-shield/rules`);
        if (resp && Array.isArray((resp as { rules?: RuleRow[] }).rules)) {
          rules = (resp as { rules: RuleRow[] }).rules;
          source = `live: ${gatewayUrl()}`;
        }
      } catch {
        // fall through to FALLBACK with the offline note
      }
    }

    printTable(
      ['RULE', 'SEVERITY', 'LANGUAGE', 'DESCRIPTION'],
      [24, 10, 12, 60],
      rules.map((r) => [
        r.id,
        `${SEV_COLOR[r.severity] ?? ''}${r.severity}${RESET}`,
        r.language,
        r.description,
      ]),
    );
    console.log(`\n\x1b[2m${rules.length} rule(s) · source: ${source}\x1b[0m`);
  });

// ── doctor ───────────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Health probe — gateway, auth, policies, alignment, code-shield, DB writes')
  .action(async () => {
    interface Check {
      name: string;
      ok: boolean;
      note?: string;
    }
    const checks: Check[] = [];
    const base = gatewayUrl();
    const key = apiKey();

    console.log(`\nProbing AEGIS at ${base}\n`);

    // 1. /health — anonymous, must respond
    try {
      const h = await request('GET', `${base}/health`, undefined, { noAuth: true });
      const ok = !!h && (h.status === 'ok' || h.timestamp || h.tier);
      checks.push({
        name: 'gateway /health',
        ok,
        note: ok ? `tier=${h.tier ?? 'unknown'}, version=${h.version ?? '?'}` : 'unexpected payload',
      });
    } catch (e) {
      checks.push({ name: 'gateway /health', ok: false, note: (e as Error).message });
      // Without the gateway up, the rest of the probes are moot.
      summarize(checks);
      process.exit(2);
    }

    // 2. API key present + working — try /api/v1/stats (auth-required)
    if (!key) {
      checks.push({
        name: 'api key configured',
        ok: false,
        note: 'no AGENTGUARD_API_KEY env var and no api_key in config — run `agentguard configure --url <url> --bootstrap`',
      });
    } else {
      try {
        const s = await request('GET', `${base}/api/v1/stats`);
        const ok = !!s && typeof s === 'object' && !('error' in s);
        checks.push({
          name: 'api key authenticates',
          ok,
          note: ok ? `keyed-routes reachable (${key.slice(0, 8)}…)` : `auth failed: ${JSON.stringify(s).slice(0, 100)}`,
        });
      } catch (e) {
        checks.push({ name: 'api key authenticates', ok: false, note: (e as Error).message });
      }
    }

    // 3. Policies loaded
    try {
      const p = await request('GET', `${base}/api/v1/policies`);
      const arr = Array.isArray(p) ? p : Array.isArray(p?.policies) ? p.policies : [];
      checks.push({
        name: 'policies loaded',
        ok: arr.length > 0,
        note: `${arr.length} policy entr${arr.length === 1 ? 'y' : 'ies'} active`,
      });
    } catch (e) {
      checks.push({ name: 'policies loaded', ok: false, note: (e as Error).message });
    }

    // 4. Code-shield endpoint — confirm scan path is wired
    try {
      const r = await request(
        'POST',
        `${base}/api/v1/code-shield/scan`,
        { code: 'eval(x)', language: 'python' },
      );
      const ok = !!r && Array.isArray((r as any).findings);
      checks.push({
        name: 'code-shield reachable',
        ok,
        note: ok ? `worst=${r.worst ?? 'null'}, ${r.unique_findings} finding(s) on canary` : 'unexpected payload',
      });
    } catch (e) {
      checks.push({ name: 'code-shield reachable', ok: false, note: (e as Error).message });
    }

    // 5. Alignment endpoint — best-effort, may not be configured if no LLM key
    try {
      const r = await request('GET', `${base}/api/v1/alignment/recent?limit=1`);
      const ok = !!r && Array.isArray((r as any).items);
      checks.push({
        name: 'alignment endpoint reachable',
        ok,
        note: ok
          ? `recent endpoint OK (${(r as any).items.length} item(s) buffered)`
          : `${JSON.stringify(r).slice(0, 100)}`,
      });
    } catch (e) {
      checks.push({ name: 'alignment endpoint reachable', ok: false, note: (e as Error).message });
    }

    summarize(checks);
    process.exit(checks.some((c) => !c.ok) ? 1 : 0);

    function summarize(rows: Check[]) {
      for (const c of rows) {
        const mark = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`  ${mark} ${c.name}`);
        if (c.note) console.log(`      \x1b[2m${c.note}\x1b[0m`);
      }
      const failed = rows.filter((r) => !r.ok).length;
      console.log();
      if (failed === 0) {
        console.log('\x1b[32mAll checks passed.\x1b[0m');
      } else {
        console.log(`\x1b[31m${failed} of ${rows.length} check(s) failed.\x1b[0m`);
      }
    }
  });

// ── evidence-pack (SOC 2 export) ─────────────────────────────────────────────
const evidencePack = program
  .command('evidence-pack')
  .description('Download or verify a SOC 2 evidence pack');

evidencePack
  .command('export', { isDefault: true })
  .description('Download a signed evidence pack (audit log + policies + tenant config + integrity verdict)')
  .option('-o, --out <file>', 'Write the pack to this file (default: ./aegis-evidence-<timestamp>.json)')
  .action(async (opts: { out?: string }) => {
    const url = `${gatewayUrl()}/api/v1/evidence-pack/export`;
    let raw: any;
    try {
      raw = await request('GET', url);
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m gateway error: ${(e as Error).message}`);
      process.exit(2);
    }
    if (raw && typeof raw === 'object' && 'error' in raw) {
      console.error(`\x1b[31m✗\x1b[0m ${raw.error}`);
      process.exit(2);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = opts.out || `./aegis-evidence-${stamp}.json`;
    fs.writeFileSync(target, JSON.stringify(raw, null, 2));
    const stat = fs.statSync(target);
    const kb = (stat.size / 1024).toFixed(1);
    console.log(`\x1b[32m✓\x1b[0m wrote ${target}  \x1b[2m(${kb} KB)\x1b[0m`);
    if (raw.meta) {
      console.log(`    \x1b[2morg: ${raw.meta.org_id} · generated_at: ${raw.meta.generated_at}\x1b[0m`);
      console.log(
        `    \x1b[2maudit rows: ${(raw.audit_log ?? []).length} · ` +
          `agents: ${raw.integrity?.total_agents ?? 0} · ` +
          `broken chains: ${raw.integrity?.broken_agents ?? 0}\x1b[0m`,
      );
      if (raw.signature) {
        console.log(
          `    \x1b[2msigned: ${raw.signature.algorithm} · key_id ${raw.signature.key_id}\x1b[0m`,
        );
      }
    }
  });

evidencePack
  .command('verify <file>')
  .description('Verify a pack\'s Ed25519 signature offline using the pubkey embedded in the file')
  .action(async (file: string) => {
    let pack: any;
    try {
      pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m cannot read ${file}: ${(e as Error).message}`);
      process.exit(2);
    }
    if (!pack || typeof pack !== 'object' || !pack.signature) {
      console.log(`\x1b[31m✗\x1b[0m ${file}: no signature in pack`);
      process.exit(1);
    }
    // Offline verify — recompute the canonical form locally using
    // the gateway's published algorithm (strip signature field then
    // JSON.stringify the rest with the constructor's insertion
    // order). No network call, no API key needed.
    const { signature, ...rest } = pack;
    const data = JSON.stringify(rest);
    let ok = false;
    try {
      const { createPublicKey, verify: nodeVerify } = await import('crypto');
      const pub = createPublicKey(signature.public_key_pem);
      ok = nodeVerify(null, Buffer.from(data, 'utf8'), pub, Buffer.from(signature.signature, 'base64'));
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m verify failed: ${(e as Error).message}`);
      process.exit(2);
    }
    if (ok) {
      console.log(`\x1b[32m✓\x1b[0m ${file}: signature valid`);
      console.log(`    \x1b[2malgorithm: ${signature.algorithm}\x1b[0m`);
      console.log(`    \x1b[2mkey_id:    ${signature.key_id}\x1b[0m`);
      console.log(`    \x1b[2mgenerated_at: ${pack.meta?.generated_at ?? '?'}\x1b[0m`);
      process.exit(0);
    } else {
      console.log(`\x1b[31m✗\x1b[0m ${file}: SIGNATURE INVALID — pack has been mutated since export`);
      process.exit(1);
    }
  });

// ── integrity (audit-chain verification) ────────────────────────────────────
const integrity = program
  .command('integrity')
  .description('Verify the tamper-evident audit trail for an agent');

integrity
  .command('verify-all')
  .description('Verify every agent\'s chain in one sweep — the "are any chains broken right now" question')
  .action(async () => {
    let report: any;
    try {
      report = await request('GET', `${gatewayUrl()}/api/v1/integrity/verify-all`);
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m gateway error: ${(e as Error).message}`);
      process.exit(2);
    }
    if (report && report.error) {
      console.error(`\x1b[31m✗\x1b[0m ${report.error}`);
      process.exit(2);
    }
    const ok = report.broken_agents === 0;
    const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(
      `${mark} ${report.ok_agents}/${report.total_agents} chains intact  ` +
      `\x1b[2m(${report.latency_ms}ms)\x1b[0m`,
    );
    if (report.agents.length > 0) {
      for (const a of report.agents) {
        const m = a.ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m';
        const id = a.agent_id.length > 24 ? a.agent_id.slice(0, 8) + '…' : a.agent_id;
        const tail = a.ok
          ? `\x1b[2m${a.total} traces\x1b[0m`
          : `\x1b[31m${a.broken_at?.reason} @ seq ${a.broken_at?.sequence_number}\x1b[0m`;
        console.log(`${m}  ${id.padEnd(28)}  ${tail}`);
      }
    }
    process.exit(ok ? 0 : 1);
  });

integrity
  .command('verify <agentId>')
  .description('Recompute the hash chain for an agent — proves no traces were tampered or removed')
  .action(async (agentId: string) => {
    const url = `${gatewayUrl()}/api/v1/integrity/verify?agent_id=${encodeURIComponent(agentId)}`;
    let report: any;
    try {
      report = await request('GET', url);
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m gateway error: ${(e as Error).message}`);
      process.exit(2);
    }
    if (report && report.error) {
      console.error(`\x1b[31m✗\x1b[0m ${report.error}`);
      process.exit(2);
    }

    const ok = report.ok === true;
    const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const tail = `(${report.total} trace${report.total === 1 ? '' : 's'}, ${report.latency_ms}ms)`;
    console.log(`${mark} agent ${agentId}  ${tail}`);

    if (report.latest_trace_id) {
      console.log(`    \x1b[2mlatest: ${report.latest_trace_id}\x1b[0m`);
    }
    if (!ok && report.broken_at) {
      const b = report.broken_at;
      console.log(`    \x1b[31mbroken at sequence ${b.sequence_number} (${b.trace_id})\x1b[0m`);
      console.log(`    \x1b[2mreason:   ${b.reason}\x1b[0m`);
      console.log(`    \x1b[2mexpected: ${b.expected}\x1b[0m`);
      console.log(`    \x1b[2mactual:   ${b.actual}\x1b[0m`);
    }
    process.exit(ok ? 0 : 1);
  });

// ── admin (enterprise management) ────────────────────────────────────────────
const admin = program.command('admin').description('Enterprise administration');

// Organizations
admin
  .command('orgs')
  .description('List organizations')
  .action(async () => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/orgs`);
    const orgs = data.organizations ?? [];
    if (!orgs.length) { console.log('No organizations found.'); return; }
    printTable(
      ['ID', 'NAME', 'SLUG', 'PLAN', 'CREATED'],
      [12, 24, 16, 12, 20],
      orgs.map((o: any) => [o.id.substring(0, 12), o.name, o.slug, o.plan, o.created_at?.substring(0, 19)])
    );
  });

admin
  .command('create-org')
  .description('Create a new organization')
  .requiredOption('-n, --name <name>', 'Organization name')
  .requiredOption('-s, --slug <slug>', 'URL-safe slug')
  .option('--plan <plan>', 'Plan (free|pro|enterprise)', 'free')
  .action(async (opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/admin/orgs`, {
      name: opts.name, slug: opts.slug, plan: opts.plan,
    });
    console.log(`\nOrganization created: ${data.org_id}`);
    console.log(`API Key: ${data.api_key}`);
    console.log(`Prefix:  ${data.key_prefix}`);
    console.log('\nSave this API key — it will not be shown again.\n');
  });

// Users
admin
  .command('users <orgId>')
  .description('List users in an organization')
  .action(async (orgId) => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/orgs/${orgId}/users`);
    const users = data.users ?? [];
    if (!users.length) { console.log('No users found.'); return; }
    printTable(
      ['ID', 'EMAIL', 'NAME', 'ROLE', 'STATUS'],
      [12, 30, 20, 10, 10],
      users.map((u: any) => [u.id.substring(0, 12), u.email, u.name || '-', u.role, u.status])
    );
  });

admin
  .command('create-user <orgId>')
  .description('Create a user in an organization')
  .requiredOption('-e, --email <email>', 'User email')
  .requiredOption('-r, --role <role>', 'Role (owner|admin|auditor|viewer)')
  .option('-n, --name <name>', 'User name')
  .action(async (orgId, opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/admin/orgs/${orgId}/users`, {
      email: opts.email, role: opts.role, name: opts.name,
    });
    console.log(`User created: ${data.id} (${data.email}, ${data.role})`);
  });

// API Keys
admin
  .command('keys <orgId>')
  .description('List API keys for an organization')
  .action(async (orgId) => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/orgs/${orgId}/keys`);
    const keys = data.keys ?? [];
    if (!keys.length) { console.log('No API keys found.'); return; }
    printTable(
      ['ID', 'PREFIX', 'NAME', 'RATE LIMIT', 'LAST USED', 'EXPIRES'],
      [12, 14, 16, 10, 20, 20],
      keys.map((k: any) => [
        k.id.substring(0, 12), k.key_prefix, k.name,
        `${k.rate_limit}/min`,
        k.last_used_at?.substring(0, 19) ?? 'never',
        k.expires_at?.substring(0, 19) ?? 'never',
      ])
    );
  });

admin
  .command('create-key <orgId>')
  .description('Create a new API key')
  .option('-n, --name <name>', 'Key name', 'CLI Key')
  .option('--rate-limit <n>', 'Requests per minute', '1000')
  .option('--expires-in <days>', 'Expiry in days')
  .action(async (orgId, opts) => {
    const data = await request('POST', `${gatewayUrl()}/api/v1/admin/orgs/${orgId}/keys`, {
      name: opts.name,
      rate_limit: parseInt(opts.rateLimit, 10),
      expires_in_days: opts.expiresIn ? parseInt(opts.expiresIn, 10) : undefined,
    });
    console.log(`\nAPI Key created: ${data.key}`);
    console.log(`Key ID:  ${data.key_id}`);
    console.log(`Prefix:  ${data.prefix}`);
    console.log('\nSave this API key — it will not be shown again.\n');
  });

// Audit log
admin
  .command('audit-log')
  .description('View admin audit log')
  .option('--action <action>', 'Filter by action')
  .option('--resource <type>', 'Filter by resource type')
  .option('-n, --limit <n>', 'Max entries', '20')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.action) params.set('action', opts.action);
    if (opts.resource) params.set('resource_type', opts.resource);
    params.set('limit', opts.limit);
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/audit-log?${params}`);
    const entries = data.entries ?? [];
    if (!entries.length) { console.log('No audit entries found.'); return; }
    console.log(`\nAudit Log (${data.total} total):\n`);
    for (const e of entries) {
      const details = e.details ? ` — ${JSON.stringify(e.details)}` : '';
      console.log(`  [${e.created_at}] ${e.action} ${e.resource_type}${e.resource_id ? ':' + e.resource_id.substring(0, 12) : ''}${details}`);
    }
    console.log();
  });

// Usage & quotas
admin
  .command('usage <orgId>')
  .description('View usage and quota dashboard')
  .action(async (orgId) => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/usage/${orgId}`);
    console.log(`\nUsage Dashboard (${data.plan} plan, period: ${data.period}):\n`);
    for (const [metric, info] of Object.entries(data.quotas || {})) {
      const q = info as any;
      const limit = q.limit === -1 ? 'unlimited' : q.limit;
      const bar = q.pct > 0 ? '█'.repeat(Math.min(20, Math.round(q.pct / 5))) : '░';
      const warn = q.pct >= 80 ? ' ⚠' : '';
      console.log(`  ${metric.padEnd(24)} ${bar} ${q.current}/${limit} (${q.pct}%)${warn}`);
    }
    console.log();
  });

// SLA metrics
admin
  .command('sla')
  .description('View SLA metrics summary')
  .option('--hours <n>', 'Lookback period in hours', '24')
  .action(async (opts) => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/sla?hours=${opts.hours}`);
    console.log(`\nSLA Summary (last ${data.period_hours}h):\n`);
    console.log(`  Uptime:       ${data.uptime_pct}%`);
    console.log(`  Requests:     ${data.total_requests}`);
    console.log(`  Errors:       ${data.total_errors}`);
    console.log(`  Latency P50:  ${data.latency.p50}ms`);
    console.log(`  Latency P95:  ${data.latency.p95}ms`);
    console.log(`  Latency P99:  ${data.latency.p99}ms`);
    console.log(`  Avg latency:  ${data.latency.avg}ms`);
    console.log();
  });

// Retention
admin
  .command('retention')
  .description('View data retention policies')
  .action(async () => {
    const data = await request('GET', `${gatewayUrl()}/api/v1/admin/retention`);
    const policies = data.policies ?? [];
    if (!policies.length) { console.log('No retention policies found.'); return; }
    printTable(
      ['ID', 'RESOURCE', 'DAYS', 'ENABLED', 'LAST PURGE'],
      [20, 18, 6, 8, 20],
      policies.map((p: any) => [
        p.id.substring(0, 20), p.resource_type, p.retention_days,
        p.enabled ? 'yes' : 'no', p.last_purge_at?.substring(0, 19) ?? 'never',
      ])
    );
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

// ── scan ───────────────────────────────────────────────────────────────────
// Walks a repo and emits the AEGIS onboarding-format report (JSON to
// stdout, friendly table to stderr). Defers to tools/repo-scanner/index.mjs
// which is bundled into ./repo-scanner/ at publish time.
program
  .command('scan [path]')
  .description('Scan a repo for files that import LLM/agent frameworks')
  .option('--json',           'Emit machine-readable JSON only')
  .option('--include-tests',  'Do not skip test files / test dirs')
  .option('--max-files <n>',  'Cap files scanned (default 5000)', undefined)
  .action(async (pathArg, opts) => {
    const target = pathArg ?? process.cwd();
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'tools', 'repo-scanner', 'index.mjs'),
      path.join(__dirname, '..', 'repo-scanner', 'index.mjs'),
      path.join(__dirname, 'repo-scanner', 'index.mjs'),
    ];
    const scanPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!scanPath) {
      console.error('✗ repo-scanner script not found. Reinstall agentguard-cli or run from the monorepo.');
      process.exit(2);
    }
    const args: string[] = [scanPath, target];
    if (opts.json)          args.push('--json');
    if (opts.includeTests)  args.push('--include-tests');
    if (opts.maxFiles)      args.push('--max-files', String(opts.maxFiles));
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
  });

// ── inject ─────────────────────────────────────────────────────────────────
// Inserts the AEGIS bootstrap snippet at the top of entry files. Defaults
// to dry-run; pass --write to apply, --revert to undo.
program
  .command('inject')
  .description('Insert agentguard.auto(...) at the top of entry files in a repo')
  .option('--report <path>',  'Path to scanner report JSON')
  .option('--file <path>',    'Single file to inject')
  .option('--language <l>',   'python | javascript (when using --file)')
  .option('--gateway <url>',  'Gateway URL', undefined)
  .option('--api-key <key>',  'API key (defaults to configured key)', undefined)
  .option('--agent-id <id>',  'Override the suggested agent id (single-file mode only)', undefined)
  .option('--only-entry-points', 'Only inject into files where is_entry_point=true', false)
  .option('--include-protected', 'Inject even if file already looks protected', false)
  .option('--write',          'Apply the edits (default is dry-run)', false)
  .option('--revert',         'Restore .aegis.bak backups for files in the report/positional list', false)
  .action(async (opts, cmd) => {
    const cfg = loadConfig();
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'tools', 'codemod-inject', 'index.mjs'),
      path.join(__dirname, '..', 'codemod-inject', 'index.mjs'),
      path.join(__dirname, 'codemod-inject', 'index.mjs'),
    ];
    const injectPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!injectPath) {
      console.error('✗ codemod-inject script not found. Reinstall agentguard-cli or run from the monorepo.');
      process.exit(2);
    }
    const args: string[] = [injectPath];
    if (opts.report)            args.push('--report', opts.report);
    if (opts.file)              args.push('--file', opts.file);
    if (opts.language)          args.push('--language', opts.language);
    args.push('--gateway', opts.gateway ?? cfg.gateway_url);
    const apiKey = opts.apiKey ?? cfg.api_key;
    if (apiKey)                 args.push('--api-key', apiKey);
    if (opts.agentId)           args.push('--agent-id', opts.agentId);
    if (opts.onlyEntryPoints)   args.push('--only-entry-points');
    if (opts.includeProtected)  args.push('--include-protected');
    if (opts.write)             args.push('--write');
    if (opts.revert)            args.push('--revert');
    // Pass through extra positional arguments (e.g. file paths for --revert)
    for (const arg of cmd?.args ?? []) args.push(arg);
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
  });

// ── demo ───────────────────────────────────────────────────────────────────
// Self-contained walkthrough — drives the gateway with a realistic mix of
// safe + risky tool calls so the Cockpit panels light up end-to-end.
// Spawns tools/demo-agent/index.mjs (works when installed in the monorepo)
// or falls back to the bundled copy (npm-published variant).
program
  .command('demo')
  .description('Run the AEGIS demo agent against the gateway')
  .option('--gateway <url>', 'Gateway URL', undefined)
  .option('--api-key <key>', 'API key (defaults to configured key)', undefined)
  .option('--count <n>',     'Number of tool calls to simulate', '12')
  .option('--delay <ms>',    'Delay between calls in ms',       '1500')
  .option('--agent-id <id>', 'Override the demo agent id',       undefined)
  .action(async (opts) => {
    const cfg     = loadConfig();
    const gateway = opts.gateway ?? cfg.gateway_url;
    const apiKey  = opts.apiKey  ?? cfg.api_key ?? '';
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'tools', 'demo-agent', 'index.mjs'),
      path.join(__dirname, '..', 'demo-agent', 'index.mjs'),
      path.join(__dirname, 'demo-agent', 'index.mjs'),
    ];
    const demoPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!demoPath) {
      console.error('✗ demo agent script not found. Reinstall agentguard-cli or run it from the monorepo.');
      process.exit(2);
    }
    const args = [demoPath, '--gateway', gateway, '--count', String(opts.count), '--delay', String(opts.delay)];
    if (apiKey)      args.push('--api-key', apiKey);
    if (opts.agentId) args.push('--agent-id', opts.agentId);
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
  });

// ── tail ────────────────────────────────────────────────────────────
//
// Live-tails traces from the gateway. Polls /api/v1/traces?since=... on
// a short interval and prints each new one as a single line. Colour-
// coded by risk_level so glancing at the terminal tells you what the
// agent is doing without needing to open the cockpit.
//
// Design note: not using SSE / websockets because the gateway doesn't
// expose one, and polling is what Sentry / Datadog / Honeycomb CLIs
// do anyway. If we ship an SSE endpoint later, this command can be
// upgraded transparently — the argument shape stays the same.
program
  .command('tail')
  .description('Live-tail traces from the gateway (Ctrl+C to exit)')
  .option('-a, --agent <id>',        'Filter by agent ID')
  .option('-i, --interval <ms>',     'Poll interval in milliseconds', '2000')
  .option('-t, --tool <name>',       'Filter by tool_name substring')
  .option('-r, --risk <level>',      'Minimum risk level (LOW|MEDIUM|HIGH|CRITICAL)')
  .action(async (opts) => {
    const intervalMs = Math.max(500, parseInt(opts.interval, 10));
    const riskOrder: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const riskFloor = opts.risk ? (riskOrder[opts.risk] ?? 0) : -1;
    const toolNeedle = opts.tool?.toLowerCase();
    let since: string | undefined;

    if (!jsonMode()) {
      console.error(c('agentguard tail — polling every ' + intervalMs + 'ms. Ctrl+C to exit.', 'dim'));
    }

    // Track seen trace_ids across a short window so a slow gateway
    // returning duplicates on the boundary doesn't print them twice.
    const seen = new Set<string>();
    const seenMax = 512;

    process.on('SIGINT', () => {
      if (!jsonMode()) console.error(c('\nagentguard tail — stopped.', 'dim'));
      process.exit(0);
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const params = new URLSearchParams({ limit: '100' });
        if (opts.agent) params.set('agent_id', opts.agent);
        if (since)     params.set('start_time', since);
        const data = await request('GET', `${gatewayUrl()}/api/v1/traces?${params}`);
        const traces: any[] = (data.traces ?? [])
          .filter((t: any) => !seen.has(t.trace_id))
          // Poll returns newest-first; reverse so we print chronologically
          .reverse();
        for (const t of traces) {
          const risk = t.safety_validation?.risk_level ?? 'LOW';
          if (riskFloor >= 0 && (riskOrder[risk] ?? 0) < riskFloor) continue;
          const toolName = t.tool_call?.tool_name ?? '?';
          if (toolNeedle && !toolName.toLowerCase().includes(toolNeedle)) continue;

          seen.add(t.trace_id);
          if (seen.size > seenMax) {
            // Trim oldest — Set preserves insertion order.
            const drop = seen.size - seenMax;
            let i = 0;
            for (const id of seen) { if (i++ >= drop) break; seen.delete(id); }
          }

          if (jsonMode()) {
            emitJSON({
              trace_id:  t.trace_id,
              timestamp: t.timestamp,
              agent_id:  t.agent_id,
              tool_name: toolName,
              risk,
              status:    t.approval_status,
              blocked:   Boolean(t.blocked),
            });
          } else {
            const riskColour: Colour =
              risk === 'CRITICAL' ? 'red' :
              risk === 'HIGH'     ? 'red' :
              risk === 'MEDIUM'   ? 'yellow' :
              'dim';
            const stamp = new Date(t.timestamp).toISOString().slice(11, 19);
            console.log(
              `${c(stamp, 'dim')}  ${c(risk.padEnd(8), riskColour)}  ${c(String(t.agent_id).slice(0, 12).padEnd(12), 'cyan')}  ${toolName.padEnd(28)}  ${t.approval_status ?? ''}`,
            );
          }
        }
        // Advance the since cursor to the most recent trace we saw,
        // whether it passed filters or not — avoids re-fetching them.
        const newest = (data.traces ?? [])[0];
        if (newest?.timestamp) since = newest.timestamp;
      } catch (e: any) {
        if (jsonMode()) emitJSON({ error: e.message, retry_in_ms: intervalMs });
        else console.error(c(`tail: ${e.message}`, 'red'));
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  });

// ── replay ──────────────────────────────────────────────────────────
//
// Manually drain the SDK's local disk fallback into the gateway. The
// Python + JS SDKs auto-replay on startup, but there's no automatic
// replay for existing processes (e.g. long-running server that never
// restarts). This command is the operator-facing companion — point it
// at any AGENTGUARD_TRACES_DIR (default ~/.agentguard/traces) and it
// walks the queue oldest-first, POSTing each file and deleting on
// success, stopping on first failure so the operator can investigate.
program
  .command('replay')
  .description('Replay locally-persisted traces into the gateway')
  .option('-d, --dir <path>', 'Trace fallback directory', path.join(os.homedir(), '.agentguard', 'traces'))
  .option('--dry-run',        'List queued traces without sending')
  .option('--rate <n>',       'Max sends per second', '20')
  .action(async (opts) => {
    const dir = path.resolve(opts.dir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch (e: any) {
      if (jsonMode()) return emitJSON({ error: `cannot read ${dir}: ${e.message}` });
      console.error(c(`✗ Cannot read ${dir}: ${e.message}`, 'red'));
      process.exit(2);
    }
    if (!files.length) {
      if (jsonMode()) return emitJSON({ queued: 0, sent: 0, failed: 0, dir });
      console.log(`${c('✓', 'green')} No traces queued in ${dir}`);
      return;
    }

    if (opts.dryRun) {
      if (jsonMode()) return emitJSON({ queued: files.length, dir, files });
      console.log(`${c('•', 'yellow')} ${files.length} trace(s) queued in ${dir}:`);
      for (const f of files.slice(0, 20)) console.log(`  ${f}`);
      if (files.length > 20) console.log(`  … and ${files.length - 20} more`);
      return;
    }

    const rate = Math.max(1, parseInt(opts.rate, 10));
    const intervalMs = 1000 / rate;
    let sent = 0, failed = 0;

    for (const name of files) {
      const full = path.join(dir, name);
      let payload: any;
      try { payload = JSON.parse(fs.readFileSync(full, 'utf8')); }
      catch (e: any) {
        if (!jsonMode()) console.error(c(`  skip ${name}: ${e.message}`, 'yellow'));
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      try {
        await request('POST', `${gatewayUrl()}/api/v1/traces`, payload);
        fs.unlinkSync(full);
        sent++;
        if (!jsonMode()) console.log(`${c('✓', 'green')} ${name}`);
      } catch (e: any) {
        failed++;
        if (!jsonMode()) console.error(`${c('✗', 'red')} ${name}: ${e.message}`);
        // Stop on first failure — operator investigates before we
        // fire the whole queue at a broken gateway.
        break;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }

    const remaining = files.length - sent - failed;
    if (jsonMode()) return emitJSON({ queued: files.length, sent, failed, remaining, dir });
    console.log(`\n${c('Sent:', 'bold')} ${sent}  ${c('Failed:', failed ? 'red' : 'dim')} ${failed}  Remaining: ${remaining}`);
    if (failed) process.exit(1);
  });

// ── completion ──────────────────────────────────────────────────────
//
// Shell tab-completion for bash / zsh / fish. Commander doesn't ship
// completion out of the box, so we emit hand-rolled scripts that
// enumerate the top-level command names + a handful of common
// subcommands. Installation is documented in the printed banner.
program
  .command('completion <shell>')
  .description('Emit shell tab-completion script (bash|zsh|fish)')
  .action((shell) => {
    // Pull command names from the Commander tree so this stays in
    // sync as new commands are added.
    const cmds = program.commands.map(cmd => cmd.name()).filter(n => n !== 'completion');
    const cmdList = cmds.join(' ');

    if (shell === 'bash') {
      process.stdout.write(`# agentguard bash completion
# Install:  agentguard completion bash > /usr/local/etc/bash_completion.d/agentguard
#   or add to ~/.bashrc:  eval "$(agentguard completion bash)"
_agentguard_complete() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cmds="${cmdList}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
    return 0
  fi
  # Common option completion — offer --json and --help for any command.
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--json --no-color --help" -- "$cur") )
    return 0
  fi
}
complete -F _agentguard_complete agentguard
`);
      return;
    }

    if (shell === 'zsh') {
      process.stdout.write(`#compdef agentguard
# agentguard zsh completion
# Install:  agentguard completion zsh > "\${fpath[1]}/_agentguard"
#   or eval directly:  eval "$(agentguard completion zsh)"
_agentguard() {
  local -a commands
  commands=(${cmds.map(n => `'${n}:${n}'`).join(' ')})
  _arguments -C \\
    '(-h --help)'{-h,--help}'[show help]' \\
    '--json[emit machine-readable JSON]' \\
    '--no-color[disable ANSI colour]' \\
    '1: :->cmds' \\
    '*::arg:->args'
  case "$state" in
    cmds) _describe 'command' commands ;;
    args) _files ;;
  esac
}
_agentguard "$@"
`);
      return;
    }

    if (shell === 'fish') {
      process.stdout.write(`# agentguard fish completion
# Install:  agentguard completion fish > ~/.config/fish/completions/agentguard.fish
complete -c agentguard -f -n '__fish_use_subcommand' -a "${cmdList}"
complete -c agentguard -l json      -d 'Emit JSON output'
complete -c agentguard -l no-color  -d 'Disable ANSI colour'
complete -c agentguard -l help -s h -d 'Show help'
`);
      return;
    }

    console.error(c(`unknown shell "${shell}" — use bash, zsh, or fish`, 'red'));
    process.exit(2);
  });

program.parse(process.argv);
