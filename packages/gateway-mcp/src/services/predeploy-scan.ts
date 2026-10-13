/**
 * Pre-deployment scan service. Bridges the AEGIS gateway to
 * HeadyZhang/agent-audit (MIT, https://github.com/HeadyZhang/agent-audit)
 * which provides 53 OWASP-Agentic-Top-10-mapped static rules with AST
 * + taint-tracking + MCP-config detection.
 *
 * Why integrate vs. roll our own:
 *
 *   - Their AST scanner > our regex scanner on every axis they cover
 *     (Python @tool decorators, tool-shadowing in MCP configs, multi-
 *     file taint tracking, SARIF 2.1.0 output for GitHub Code Scanning).
 *
 *   - License is MIT, no copyleft — commercial bundle safe.
 *
 *   - It's static-only. AEGIS keeps owning runtime / policy / rollback
 *     / Merkle audit. Complementary, not competing.
 *
 * Invocation model:
 *
 *   1. Caller hands us an absolute repo path.
 *   2. We spawn the agent-audit CLI as a subprocess with `--format sarif`.
 *   3. Parse SARIF v2.1.0 (the OASIS open standard for static-analysis
 *      output — GitHub Code Scanning, GitLab, Sonarqube all consume it).
 *   4. Map SARIF Results → AEGIS Finding shape.
 *   5. Append each finding as a signed Merkle leaf so the scan itself
 *      is auditable + non-repudiable (post-hoc anyone can verify what
 *      we found, when, and that nobody tampered with the report).
 *
 * Discovery order for the `agent-audit` binary:
 *
 *   1. PRE_DEPLOY_SCAN_BIN env override (full path)
 *   2. `agent-audit` on PATH (pipx-installed or system Python)
 *   3. `python3 -m agent_audit` (module-style invocation)
 *
 * If none resolve, runs return an `{ ok: false, error }` with a clear
 * remediation pointer ("pipx install agent-audit==0.18.2"). We
 * deliberately don't bundle the binary — Docker / CI image-level
 * concerns belong outside the gateway.
 */

import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from 'pino';
import { AuditLogService } from './audit-log';
import { TransparencyLogService } from './transparency-log';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'note';
export type FindingTier     = 'BLOCK' | 'WARN' | 'INFO';

export interface AegisFinding {
  /** Stable rule identifier from agent-audit (e.g. "AGENT-001"). */
  rule_id: string;
  /** Short human title. */
  title: string;
  /** Long description / explanation of the finding. */
  description?: string;
  severity: FindingSeverity;
  /** Operational tier — derived from severity + rule metadata. */
  tier: FindingTier;
  /** OWASP Agentic Top-10 category (ASI-01..ASI-10) if mapped. */
  owasp_id?: string;
  /** CWE id if mapped. */
  cwe_id?: string;
  /** 0..1 confidence emitted by the analyzer. */
  confidence?: number;
  /** Source-relative file path + line range. */
  location: {
    file_path: string;
    start_line?: number;
    start_column?: number;
    end_line?: number;
    end_column?: number;
  };
  /** Recommended remediation text. */
  remediation?: string;
}

export interface ScanReport {
  ok: true;
  /** Tool name + version (parsed from SARIF runs[0].tool.driver). */
  tool: { name: string; version?: string };
  findings: AegisFinding[];
  summary: {
    total: number;
    by_severity: Partial<Record<FindingSeverity, number>>;
    by_tier:     Partial<Record<FindingTier, number>>;
  };
  scanned_at: string;
  scan_path: string;
  /** Raw SARIF v2.1.0 document the scanner produced. Retained so the
   *  cockpit / CI can re-export it verbatim into GitHub Code Scanning,
   *  GitLab SAST, Sonarqube, etc. without re-running the scan. */
  sarif?: unknown;
}

export interface ScanFailure {
  ok: false;
  error: string;
  /** Set when the binary was missing — UI surfaces install hint. */
  binary_missing?: boolean;
}

export type ScanResult = ScanReport | ScanFailure;

interface ResolvedBinary {
  command: string;
  baseArgs: string[];
}

export class PredeployScanService {
  /** Cached binary resolution; invalidated by reloadBinary(). */
  private resolved: ResolvedBinary | null = null;

  constructor(
    private logger: Logger,
    private audit: AuditLogService,
    private transparency: TransparencyLogService,
  ) {}

  /** Run agent-audit and return parsed findings.
   *
   *  Audit + transparency: every scan emits an `predeploy.scan` audit
   *  row + one signed Merkle leaf per finding. The leaves carry the
   *  rule_id + location + confidence — enough for offline replay,
   *  small enough not to bloat the log. */
  async scan(opts: {
    orgId: string;
    path: string;
    actor?: { user_id?: string; user_email?: string; ip_address?: string };
    /** Cap on findings ingested; defaults to 500. */
    max?: number;
    /** Extra flags forwarded to agent-audit (e.g. `--severity high`). */
    extra?: string[];
  }): Promise<ScanResult> {
    const binary = await this.resolveBinary();
    if (!binary) {
      return {
        ok: false,
        error: 'agent-audit binary not found. Install via `pipx install agent-audit` or set PRE_DEPLOY_SCAN_BIN to the absolute path.',
        binary_missing: true,
      };
    }
    // Write SARIF to a file, not stdout. agent-audit renders stdout through
    // a terminal console that wraps long lines at the detected width, which
    // put a raw newline inside the $schema URL and made every report
    // unparseable when the gateway ran without a wide TTY (found by the
    // Cockpit screenshot pass, 2026-10-13).
    const outDir = mkdtempSync(join(tmpdir(), 'aegis-scan-'));
    const outFile = join(outDir, 'report.sarif');
    const args = [...binary.baseArgs, 'scan', opts.path, '--format', 'sarif', '--no-color', '--output', outFile, ...(opts.extra ?? [])];
    let stdout = '';
    let stderr = '';
    let exitCode: number;
    try {
      ({ stdout, stderr, exitCode } = await runCmd(binary.command, args, 60_000));
    } catch (err: any) {
      this.logger.warn({ err: err.message }, 'agent-audit invocation failed');
      return { ok: false, error: `agent-audit subprocess failed: ${err.message}` };
    }

    // agent-audit returns exit 0 on success, exit 1 when --fail-on
    // threshold is met. Both produce valid SARIF on stdout. Only
    // unexpected codes (negative / OOM) should be treated as fatal.
    if (exitCode < 0) {
      return { ok: false, error: `agent-audit exited abnormally (code ${exitCode}): ${stderr.slice(0, 500)}` };
    }
    let sarif: any;
    let raw = stdout;
    try { raw = readFileSync(outFile, 'utf8'); } catch { /* older agent-audit without --output: fall back to stdout */ }
    finally { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { sarif = JSON.parse(raw); }
    catch (err: any) {
      return { ok: false, error: `agent-audit output was not valid SARIF JSON: ${err.message}\nfirst 500 chars: ${raw.slice(0, 500)}` };
    }
    const parsed = parseSarif(sarif, opts.max ?? 500);
    if (!parsed) {
      return { ok: false, error: 'SARIF document had no runs[]' };
    }
    // Retain the raw SARIF for re-export by /scan/repo.sarif and the
    // history table (added in a follow-up). We trim to a single run
    // (runs[0]) since that's what AEGIS consumes, and clamp results[]
    // to the same `max` the parser used so the JSON we hand back
    // doesn't include un-ingested findings.
    parsed.sarif = trimSarif(sarif, opts.max ?? 500);

    // Audit + transparency
    this.audit.log({
      org_id: opts.orgId,
      action: 'predeploy.scan',
      resource_type: 'system',
      resource_id: opts.path,
      user_id:    opts.actor?.user_id,
      user_email: opts.actor?.user_email,
      ip_address: opts.actor?.ip_address,
      details: {
        tool: parsed.tool,
        finding_count: parsed.findings.length,
        by_severity: parsed.summary.by_severity,
        by_tier:     parsed.summary.by_tier,
      },
    });
    for (const f of parsed.findings) {
      try {
        this.transparency.append({
          payload: {
            action: 'predeploy.finding',
            scan_path: opts.path,
            rule_id: f.rule_id,
            severity: f.severity,
            tier: f.tier,
            owasp_id: f.owasp_id ?? null,
            cwe_id: f.cwe_id ?? null,
            location: f.location,
            timestamp: new Date().toISOString(),
          },
          source: 'predeploy' as any,
          org_id: opts.orgId,
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, rule_id: f.rule_id }, 'transparency append failed for predeploy finding');
      }
    }

    return parsed;
  }

  /** Re-resolve the binary path (used by tests / config reload). */
  reloadBinary(): void { this.resolved = null; }

  /** Discovery: env override → `agent-audit` on PATH → python -m. */
  private async resolveBinary(): Promise<ResolvedBinary | null> {
    if (this.resolved) return this.resolved;
    const envBin = process.env.PRE_DEPLOY_SCAN_BIN;
    if (envBin && envBin.length > 0) {
      this.resolved = { command: envBin, baseArgs: [] };
      return this.resolved;
    }
    if (await canRun('agent-audit', ['--version'])) {
      this.resolved = { command: 'agent-audit', baseArgs: [] };
      return this.resolved;
    }
    if (await canRun('python3', ['-m', 'agent_audit', '--version'])) {
      this.resolved = { command: 'python3', baseArgs: ['-m', 'agent_audit'] };
      return this.resolved;
    }
    return null;
  }
}

// ── SARIF parser ───────────────────────────────────────────────────────

/** Map a SARIF severity level to AEGIS FindingSeverity. */
function mapSarifSeverity(level: string | undefined, securityProperties?: any): FindingSeverity {
  const s = (securityProperties?.['security-severity'] ?? '').toString();
  const score = Number.parseFloat(s);
  if (!Number.isNaN(score)) {
    if (score >= 9.0) return 'critical';
    if (score >= 7.0) return 'high';
    if (score >= 4.0) return 'medium';
    if (score >= 0.1) return 'low';
  }
  switch ((level ?? '').toLowerCase()) {
    case 'error':   return 'high';
    case 'warning': return 'medium';
    case 'note':    return 'note';
    case 'none':    return 'low';
    default:        return 'medium';
  }
}

/** Severity → operational tier. */
function severityToTier(sev: FindingSeverity): FindingTier {
  if (sev === 'critical' || sev === 'high') return 'BLOCK';
  if (sev === 'medium') return 'WARN';
  return 'INFO';
}

export function parseSarif(sarif: any, max: number): ScanReport | null {
  if (!sarif || !Array.isArray(sarif.runs) || sarif.runs.length === 0) return null;
  const run = sarif.runs[0];
  const driver = run?.tool?.driver ?? {};
  const ruleIndex: Record<string, any> = {};
  for (const rule of driver.rules ?? []) {
    if (rule?.id) ruleIndex[rule.id] = rule;
  }

  const findings: AegisFinding[] = [];
  const byS: Partial<Record<FindingSeverity, number>> = {};
  const byT: Partial<Record<FindingTier, number>> = {};

  for (const result of run.results ?? []) {
    if (findings.length >= max) break;
    const ruleId = result.ruleId ?? result.rule?.id ?? 'UNKNOWN';
    const rule = ruleIndex[ruleId] ?? {};
    const loc = result.locations?.[0]?.physicalLocation;
    const file = loc?.artifactLocation?.uri ?? 'unknown';
    const region = loc?.region ?? {};
    const sev = mapSarifSeverity(result.level ?? rule?.defaultConfiguration?.level, rule?.properties);
    const tier = severityToTier(sev);
    byS[sev] = (byS[sev] ?? 0) + 1;
    byT[tier] = (byT[tier] ?? 0) + 1;

    findings.push({
      rule_id: ruleId,
      title: rule?.shortDescription?.text ?? rule?.name ?? ruleId,
      description: result.message?.text ?? rule?.fullDescription?.text,
      severity: sev,
      tier,
      owasp_id: extractOwasp(rule),
      cwe_id: extractCwe(rule),
      confidence: typeof result.properties?.confidence === 'number' ? result.properties.confidence : undefined,
      location: {
        file_path: file,
        start_line:   region.startLine,
        start_column: region.startColumn,
        end_line:     region.endLine,
        end_column:   region.endColumn,
      },
      remediation: rule?.help?.text ?? rule?.helpUri ?? undefined,
    });
  }

  return {
    ok: true,
    tool: { name: driver.name ?? 'unknown', version: driver.semanticVersion ?? driver.version },
    findings,
    summary: { total: findings.length, by_severity: byS, by_tier: byT },
    scanned_at: new Date().toISOString(),
    scan_path: run?.invocations?.[0]?.workingDirectory?.uri ?? '',
  };
}

function extractOwasp(rule: any): string | undefined {
  const tags = rule?.properties?.tags;
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    const m = String(t).match(/ASI-?\d+/i);
    if (m) return m[0].toUpperCase();
  }
  return undefined;
}
function extractCwe(rule: any): string | undefined {
  const tags = rule?.properties?.tags;
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    const m = String(t).match(/CWE-\d+/i);
    if (m) return m[0].toUpperCase();
  }
  return undefined;
}

/** Trim a SARIF document so we don't carry around ingestion-truncated
 *  results. Keeps runs[0], clamps `results[]` to the same `max` the
 *  parser used. Other fields pass through verbatim. */
export function trimSarif(sarif: any, max: number): any {
  if (!sarif || !Array.isArray(sarif.runs) || sarif.runs.length === 0) return sarif;
  const run0 = sarif.runs[0];
  const results = Array.isArray(run0.results) ? run0.results.slice(0, max) : [];
  return {
    ...sarif,
    runs: [{
      ...run0,
      results,
    }],
  };
}

// ── subprocess helpers ─────────────────────────────────────────────────

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignored */ }
      reject(new Error(`subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function canRun(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { exitCode } = await runCmd(cmd, args, 2000);
    return exitCode === 0;
  } catch { return false; }
}
