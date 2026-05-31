/**
 * Attack-Pattern Detector — multi-step attack chain detection with
 * confidence scoring to minimise false positives.
 *
 * Unlike the existing PPM-based sequence_anomaly signal (which flags
 * statistically unusual transitions), this detector matches tool-call
 * sequences against **known attack playbooks** and scores each match
 * using contextual signals (data sensitivity, destination trust,
 * timing, novelty, upstream anomaly scores).
 *
 * Coverage:
 *   AAT-T5010  Multi-Step Data Exfiltration
 *   AAT-T5011  Credential Harvest Chain
 *   AAT-T5012  Privilege Escalation Chain
 *   AAT-T1001  Prompt Injection Chain (multi-step)
 *   AAT-T8004  Destructive Action Chain
 *   AAT-T9001  Encoded Exfiltration (evasion + exfil)
 *   AAT-T1003  Supply-Chain Compromise Chain
 *   AAT-T6003  Artifact Backdoor Chain
 *
 * Design:
 *   kind = 'meta' so it runs AFTER classify + content + behavior
 *   detectors — it reads upstream signals to enrich confidence.
 *   Supports custom user-defined rules via addRule() / removeRule().
 *   Optionally integrates with SlidingWindowStats for burst detection.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';
import type { SlidingWindowStats } from '../../services/sliding-window';

const NAME = 'aegis.builtin.attack-pattern';
const VERSION = '0.2.0';

// ── Sensitivity classification ──────────────────────────────────────────

const SENSITIVE_PATH_PATTERNS = [
  /\/etc\/(passwd|shadow|sudoers)/i,
  /\.(env|pem|key|p12|pfx|secret)/i,
  /\b(credentials?|secrets?|tokens?|passwords?|private[_-]?keys?)\b/i,
  /\.ssh\//i,
  /\.aws\//i,
  /\.kube\//i,
  /\.docker\/config/i,
  /service[_-]?account.*\.json/i,
];

const SENSITIVE_QUERY_PATTERNS = [
  /[_\b](password|secret|token|ssn|credit_card|salary|api_key)[_\b]?/i,
  /(^|[^a-z])(password|secret|token|ssn|credit_card|salary|api_key)($|[^a-z])/i,
  /\bSELECT\b.*\bFROM\b.*\b(users|credentials|accounts|secrets|employees)\b/i,
];

const SENSITIVE_TOOL_PATTERNS = [
  /^(read|get|fetch|load|open)_?(file|secret|credential|config|env)/i,
  /^(query|select|read)_?(db|database|table)/i,
];

// ── Outbound / external destination ─────────────────────────────────────

const OUTBOUND_TOOL_PATTERNS = [
  /^(http|fetch|request|get|post|put|curl|wget)/i,
  /^(send|post|push|upload|publish|notify)/i,
  /^(email|slack|webhook|sms|telegram)/i,
  /^s3_?(put|upload)/i,
  /^gcs_?(put|upload)/i,
];

const EXTERNAL_DEST_PATTERNS = [
  /https?:\/\/(?!(localhost|127\.0\.0\.1|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)\b)/,
  /@(?!(.*\.(internal|local|corp|company)$))[\w.-]+\.\w{2,}/i,
];

const INTERNAL_DEST_PATTERNS = [
  /localhost/i,
  /127\.0\.0\.1/,
  /::1/,
  /\b10\.\d+\.\d+\.\d+/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /\b192\.168\.\d+\.\d+/,
  /@.*\.(internal|local|corp|company)\b/i,
];

// ── Privileged execution ────────────────────────────────────────────────

const PRIV_EXEC_TOOL_PATTERNS = [
  /^(exec|execute|run|shell|bash|cmd|system|eval)/i,
  /^(deploy|write|alter)/i,
  /^(create_user|grant|chmod|chown|sudo)/i,
];

// ── Recon / enumeration ─────────────────────────────────────────────────

const RECON_TOOL_PATTERNS = [
  /^(list|find|glob|search|scan|enumerate|discover)/i,
  /^(whoami|uname|env|printenv|ps|netstat|ifconfig|ip_addr)/i,
  /^(nmap|portscan|dig|nslookup)/i,
];

// ── Destructive operations ──────────────────────────────────────────────

const DESTRUCTIVE_TOOL_PATTERNS = [
  /^(delete|remove|rm|destroy|purge|wipe|erase)/i,
  /^(drop|truncate)/i,
  /^(force[_-]?push|reset[_-]?hard)/i,
];

const DESTRUCTIVE_CONTENT_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b.*\bWHERE\b.*\b(1\s*=\s*1|TRUE)\b/i,
  /\bgit\s+push\s+--force\b/i,
];

// ── Encoding / obfuscation ──────────────────────────────────────────────

const ENCODING_TOOL_PATTERNS = [
  /^(encode|decode|base64|hex|compress|obfuscate|encrypt)/i,
];

const ENCODING_CONTENT_PATTERNS = [
  /\bbtoa\s*\(/i,
  /\batob\s*\(/i,
  /\bbase64\b/i,
  /\bhex\b/i,
  /\.encode\s*\(/i,
];

// ── Memory / context manipulation ───────────────────────────────────────

const MEMORY_WRITE_TOOL_PATTERNS = [
  /^(write|set|update|modify|patch)_?(memory|context|prompt|instruction|system)/i,
  /^(store|save|persist)_?(memory|context|state)/i,
];

const INJECTION_CONTENT_PATTERNS = [
  /ignore\s+(previous|prior|all)\s+(instructions?|rules?|guidelines?)/i,
  /you\s+are\s+now\b/i,
  /\b(DAN|jailbreak|developer)\s*mode\b/i,
  /forget\s+(your|all|previous)\b/i,
  /from\s+now\s+on\b/i,
  /\bsystem\s*:\s*/i,
];

// ── Write / artifact creation ───────────────────────────────────────────

const WRITE_TOOL_PATTERNS = [
  /^(write|create|save|put|store)_?(file|script|code|artifact|module)/i,
];

const BACKDOOR_CONTENT_PATTERNS = [
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bos\.system\s*\(/i,
  /\bsubprocess\b/i,
  /\b__import__\s*\(/i,
  /\brequire\s*\(\s*['"]child_process['"]\s*\)/i,
  /\bimport\s+os\b/i,
  /\bProcess\.Start\b/i,
  /\bRuntime\.getRuntime\(\)\.exec\b/i,
];

// ── Install / package management ────────────────────────────────────────

const INSTALL_TOOL_PATTERNS = [
  /^(install|add|pip_install|npm_install|gem_install)/i,
  /^(add_package|add_dependency)/i,
];

// ── Call history store (in-memory, per agent) ───────────────────────────

/** @public — exported for custom rule authors */
export interface HistoryEntry {
  timestamp: number;
  toolName: string;
  args: Record<string, unknown>;
  sensitivity: number;   // 0-100
  isOutbound: boolean;
  isPrivExec: boolean;
  isRecon: boolean;
  isDestructive: boolean;
  isEncoding: boolean;
  isMemoryWrite: boolean;
  isFileWrite: boolean;
  isInstall: boolean;
  hasInjectionContent: boolean;
  hasBackdoorContent: boolean;
  hasEncodingContent: boolean;
  hasDestructiveContent: boolean;
}

const MAX_HISTORY = 50;
const MAX_AGENTS = 5_000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

// ── Attack-pattern rules ────────────────────────────────────────────────

/** @public — exported so tenants can define custom rules */
export interface PatternRule {
  id: string;
  name: string;
  ontology: string;
  steps: Array<(e: HistoryEntry) => boolean>;
  baseConfidence: number;
  severity: Severity;
  category: string;
}

const BUILT_IN_RULES: PatternRule[] = [
  // ── Original 3 rules ──────────────────────────────────────────────
  {
    id: 'DATA_EXFIL',
    name: 'Multi-Step Data Exfiltration',
    ontology: 'AAT-T5010',
    steps: [
      (e) => e.sensitivity >= 40,
      (e) => e.isOutbound,
    ],
    baseConfidence: 30,
    severity: 'critical',
    category: 'attack-pattern.data-exfil',
  },
  {
    id: 'CRED_HARVEST',
    name: 'Credential Harvest Chain',
    ontology: 'AAT-T5011',
    steps: [
      (e) => e.sensitivity >= 40 && e.isRecon,
      (e) => e.isOutbound,
    ],
    baseConfidence: 40,
    severity: 'critical',
    category: 'attack-pattern.cred-harvest',
  },
  {
    id: 'PRIV_ESCALATION',
    name: 'Privilege Escalation Chain',
    ontology: 'AAT-T5012',
    steps: [
      (e) => e.isRecon,
      (e) => e.sensitivity >= 30,
      (e) => e.isPrivExec,
    ],
    baseConfidence: 25,
    severity: 'critical',
    category: 'attack-pattern.priv-escalation',
  },

  // ── New rules ─────────────────────────────────────────────────────

  {
    id: 'PROMPT_INJECTION_CHAIN',
    name: 'Prompt Injection Chain',
    ontology: 'AAT-T1001',
    steps: [
      (e) => e.isMemoryWrite && e.hasInjectionContent,   // Step 1: inject malicious instructions
      (e) => e.isPrivExec || e.isOutbound,                // Step 2: exploit the injection
    ],
    baseConfidence: 50,
    severity: 'critical',
    category: 'attack-pattern.prompt-injection-chain',
  },
  {
    id: 'DESTRUCTIVE_ACTION',
    name: 'Destructive Action Chain',
    ontology: 'AAT-T8004',
    steps: [
      (e) => e.isRecon || e.sensitivity >= 30,            // Step 1: gather info
      (e) => e.isDestructive || e.hasDestructiveContent,  // Step 2: destroy
    ],
    baseConfidence: 45,
    severity: 'critical',
    category: 'attack-pattern.destructive-action',
  },
  {
    id: 'ENCODED_EXFIL',
    name: 'Encoded Exfiltration',
    ontology: 'AAT-T9001',
    steps: [
      (e) => e.sensitivity >= 40,                         // Step 1: access sensitive data
      (e) => e.isEncoding || e.hasEncodingContent,        // Step 2: encode it
      (e) => e.isOutbound,                                // Step 3: send it out
    ],
    baseConfidence: 35,
    severity: 'critical',
    category: 'attack-pattern.encoded-exfil',
  },
  {
    id: 'SUPPLY_CHAIN',
    name: 'Supply-Chain Compromise',
    ontology: 'AAT-T1003',
    steps: [
      (e) => e.isInstall,                                 // Step 1: install unknown package
      (e) => e.isPrivExec,                                // Step 2: execute privileged action
    ],
    baseConfidence: 45,
    severity: 'critical',
    category: 'attack-pattern.supply-chain',
  },
  {
    id: 'ARTIFACT_BACKDOOR',
    name: 'Artifact Backdoor',
    ontology: 'AAT-T6003',
    steps: [
      (e) => e.isFileWrite && e.hasBackdoorContent,       // Step 1: write file with backdoor
      (e) => e.isPrivExec,                                // Step 2: execute / load it
    ],
    baseConfidence: 50,
    severity: 'critical',
    category: 'attack-pattern.artifact-backdoor',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function flatStringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 256) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) flatStringValues(v, out, depth + 1);
  else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) flatStringValues(v, out, depth + 1);
  }
  return out;
}

function anyContentMatch(args: Record<string, unknown>, patterns: RegExp[]): boolean {
  const strs = flatStringValues(args);
  return strs.some(s => patterns.some(p => p.test(s)));
}

function scoreSensitivity(toolName: string, args: Record<string, unknown>): number {
  let score = 0;
  const strs = flatStringValues(args);

  if (SENSITIVE_TOOL_PATTERNS.some(p => p.test(toolName))) score += 30;

  for (const s of strs) {
    if (SENSITIVE_PATH_PATTERNS.some(p => p.test(s))) { score += 40; break; }
  }

  for (const s of strs) {
    if (SENSITIVE_QUERY_PATTERNS.some(p => p.test(s))) { score += 30; break; }
  }

  return Math.min(score, 100);
}

function hasExternalDest(args: Record<string, unknown>): boolean {
  const strs = flatStringValues(args);
  return strs.some(s => EXTERNAL_DEST_PATTERNS.some(p => p.test(s)));
}

function hasInternalDest(args: Record<string, unknown>): boolean {
  const strs = flatStringValues(args);
  return strs.some(s => INTERNAL_DEST_PATTERNS.some(p => p.test(s)));
}

// ── HistoryEntry builder ────────────────────────────────────────────────

function buildEntry(toolName: string, args: Record<string, unknown>): HistoryEntry {
  return {
    timestamp: Date.now(),
    toolName,
    args,
    sensitivity:          scoreSensitivity(toolName, args),
    isOutbound:           OUTBOUND_TOOL_PATTERNS.some(p => p.test(toolName)),
    isPrivExec:           PRIV_EXEC_TOOL_PATTERNS.some(p => p.test(toolName)),
    isRecon:              RECON_TOOL_PATTERNS.some(p => p.test(toolName)),
    isDestructive:        DESTRUCTIVE_TOOL_PATTERNS.some(p => p.test(toolName)),
    isEncoding:           ENCODING_TOOL_PATTERNS.some(p => p.test(toolName)),
    isMemoryWrite:        MEMORY_WRITE_TOOL_PATTERNS.some(p => p.test(toolName)),
    isFileWrite:          WRITE_TOOL_PATTERNS.some(p => p.test(toolName)),
    isInstall:            INSTALL_TOOL_PATTERNS.some(p => p.test(toolName)),
    hasInjectionContent:  anyContentMatch(args, INJECTION_CONTENT_PATTERNS),
    hasBackdoorContent:   anyContentMatch(args, BACKDOOR_CONTENT_PATTERNS),
    hasEncodingContent:   anyContentMatch(args, ENCODING_CONTENT_PATTERNS),
    hasDestructiveContent:anyContentMatch(args, DESTRUCTIVE_CONTENT_PATTERNS),
  };
}

// ── Confidence bonuses & penalties ──────────────────────────────────────

function computeConfidence(
  rule: PatternRule,
  matchedEntries: HistoryEntry[],
  currentEntry: HistoryEntry,
  upstreamSignals: ReadonlyArray<Signal>,
  slidingWindow?: SlidingWindowStats,
  agentId?: string,
): number {
  let confidence = rule.baseConfidence;

  // ── Bonuses ───────────────────────────────────────────────────────

  const allEntries = [...matchedEntries, currentEntry];
  const maxSensitivity = Math.max(...allEntries.map(e => e.sensitivity));
  if (maxSensitivity >= 70) confidence += 15;
  if (maxSensitivity >= 90) confidence += 10;

  if (currentEntry.isOutbound && hasExternalDest(currentEntry.args)) confidence += 20;

  if (matchedEntries.length > 0) {
    const elapsed = currentEntry.timestamp - matchedEntries[0].timestamp;
    if (elapsed < 10_000) confidence += 15;
    else if (elapsed < 30_000) confidence += 10;
  }

  // Upstream risk signals (from content/behavior detectors)
  const hasUpstreamRisk = upstreamSignals.some(s =>
    s.severity === 'critical' || s.severity === 'warn'
  );
  if (hasUpstreamRisk) confidence += 10;

  // PPM sequence anomaly bonus — if the upstream anomaly detector
  // flagged this transition as statistically surprising, boost confidence
  const ppmSignal = upstreamSignals.find(s =>
    s.detector === 'aegis.builtin.anomaly' &&
    s.evidence?.signals &&
    Array.isArray(s.evidence.signals) &&
    (s.evidence.signals as Array<{ type?: string; score?: number }>)
      .some(sig => sig.type === 'sequence_anomaly' && (sig.score ?? 0) > 0.5)
  );
  if (ppmSignal) confidence += 10;

  // SlidingWindow burst detection — if agent is calling tools at an
  // unusually high rate, this looks more like automated attack
  if (slidingWindow && agentId) {
    const callCount = slidingWindow.getCallCount(agentId, 60); // last 60 sec
    if (callCount > 20) confidence += 10;
    const highRisk = slidingWindow.getHighRiskRate(agentId, 300);
    if (highRisk > 0.5) confidence += 10;
  }

  // ── Penalties ─────────────────────────────────────────────────────

  if (currentEntry.isOutbound && hasInternalDest(currentEntry.args)) confidence -= 25;

  if (maxSensitivity < 30) confidence -= 20;

  if (matchedEntries.length > 0) {
    const elapsed = currentEntry.timestamp - matchedEntries[0].timestamp;
    if (elapsed > 3 * 60_000) confidence -= 15;
    if (elapsed > DEFAULT_WINDOW_MS) confidence -= 30;
  }

  return Math.max(0, Math.min(100, confidence));
}

// ── Detector class ──────────────────────────────────────────────────────

export interface AttackPatternDetectorOptions {
  blockThreshold?: number;
  flagThreshold?: number;
  windowMs?: number;
  slidingWindow?: SlidingWindowStats;
}

export class AttackPatternDetector implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'meta' as const;

  get coverage(): ReadonlyArray<string> {
    const ontologySet = new Set<string>();
    for (const rule of this.rules) ontologySet.add(rule.ontology);
    return [...ontologySet];
  }

  /** Active rules — built-in + user-added */
  private rules: PatternRule[] = [...BUILT_IN_RULES];

  /** Per-agent call history. Key = agent ID */
  private history = new Map<string, HistoryEntry[]>();
  private agentOrder: string[] = [];

  private readonly blockThreshold: number;
  private readonly flagThreshold: number;
  private readonly windowMs: number;
  private readonly slidingWindow?: SlidingWindowStats;

  constructor(opts: AttackPatternDetectorOptions = {}) {
    this.blockThreshold = opts.blockThreshold ?? 70;
    this.flagThreshold = opts.flagThreshold ?? 40;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.slidingWindow = opts.slidingWindow;
  }

  // ── Custom Rules API ──────────────────────────────────────────────

  /** Add a custom attack pattern rule at runtime */
  addRule(rule: PatternRule): void {
    if (this.rules.some(r => r.id === rule.id)) {
      throw new Error(`rule already exists: ${rule.id}`);
    }
    this.rules.push(rule);
  }

  /** Remove a rule by ID. Returns true if removed. */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** Get all active rules (read-only) */
  getRules(): ReadonlyArray<PatternRule> {
    return this.rules;
  }

  // ── Core evaluation ───────────────────────────────────────────────

  evaluate(ctx: DetectorContext): Signal[] {
    const agentId = ctx.agent.id;
    const now = Date.now();

    const entry = buildEntry(ctx.tool.name, ctx.tool.args);
    entry.timestamp = now;

    const agentHistory = this.getHistory(agentId);
    const cutoff = now - this.windowMs;
    const recentHistory = agentHistory.filter(e => e.timestamp >= cutoff);

    const signals: Signal[] = [];

    for (const rule of this.rules) {
      const match = this.matchRule(rule, recentHistory, entry);
      if (!match) continue;

      const confidence = computeConfidence(
        rule,
        match.matchedEntries,
        entry,
        ctx.upstream ?? [],
        this.slidingWindow,
        agentId,
      );

      if (confidence >= this.flagThreshold) {
        signals.push({
          detector: NAME,
          version: VERSION,
          severity: confidence >= this.blockThreshold ? 'critical' : 'warn',
          category: rule.category,
          message: `${rule.name} detected (confidence ${confidence}%) — ` +
            `${match.matchedEntries.map(e => e.toolName).join(' → ')} → ${entry.toolName}`,
          evidence: {
            rule_id: rule.id,
            confidence,
            threshold_block: this.blockThreshold,
            threshold_flag: this.flagThreshold,
            chain: [...match.matchedEntries.map(e => ({
              tool: e.toolName,
              sensitivity: e.sensitivity,
              timestamp: e.timestamp,
            })), {
              tool: entry.toolName,
              sensitivity: entry.sensitivity,
              timestamp: entry.timestamp,
            }],
            decision: confidence >= this.blockThreshold ? 'block' : 'flag',
          },
          ontology: [rule.ontology],
        });
      }
    }

    this.recordEntry(agentId, entry);
    return signals;
  }

  // ── Pattern matching ──────────────────────────────────────────────

  private matchRule(
    rule: PatternRule,
    history: HistoryEntry[],
    current: HistoryEntry,
  ): { matchedEntries: HistoryEntry[] } | null {
    const totalSteps = rule.steps.length;
    if (totalSteps < 2) return null;

    if (!rule.steps[totalSteps - 1](current)) return null;

    const matched: HistoryEntry[] = [];
    let stepIdx = 0;
    for (const entry of history) {
      if (stepIdx >= totalSteps - 1) break;
      if (rule.steps[stepIdx](entry)) {
        matched.push(entry);
        stepIdx++;
      }
    }

    if (matched.length !== totalSteps - 1) return null;
    return { matchedEntries: matched };
  }

  // ── History management ────────────────────────────────────────────

  private getHistory(agentId: string): HistoryEntry[] {
    return this.history.get(agentId) ?? [];
  }

  private recordEntry(agentId: string, entry: HistoryEntry): void {
    let entries = this.history.get(agentId);
    if (!entries) {
      this.evictIfNeeded();
      entries = [];
      this.history.set(agentId, entries);
      this.agentOrder.push(agentId);
    }

    entries.push(entry);

    if (entries.length > MAX_HISTORY) {
      entries.splice(0, entries.length - MAX_HISTORY);
    }

    const idx = this.agentOrder.indexOf(agentId);
    if (idx !== -1) {
      this.agentOrder.splice(idx, 1);
      this.agentOrder.push(agentId);
    }
  }

  private evictIfNeeded(): void {
    while (this.history.size >= MAX_AGENTS && this.agentOrder.length > 0) {
      const oldest = this.agentOrder.shift()!;
      this.history.delete(oldest);
    }
  }

  /** Visible for testing */
  _reset(): void {
    this.history.clear();
    this.agentOrder = [];
  }

  _getHistory(agentId: string): HistoryEntry[] {
    return this.getHistory(agentId);
  }
}
