/**
 * CoverageScanService — the missing half of predeploy-scan.
 *
 * The existing PredeployScanService wraps HeadyZhang/agent-audit, a
 * third-party SAST that finds *code smells* (hardcoded secrets, unsafe
 * eval, etc.). Coverage-scan answers a different question: given the
 * tool calls the agent WILL make at runtime, does the tenant's DSL
 * catch the dangerous ones?
 *
 * Flow:
 *   1. Accept uploaded source files.
 *   2. Run WorkflowExtractor → tool_bindings per node.
 *   3. Load the tenant's compiled DslEvaluator.
 *   4. For each binding, synthesise a minimal DslContext (tool_name +
 *      classifier category) and dry-run the evaluator.
 *   5. Bucket each binding as covered / uncovered / warn based on
 *      the returned MatchResult + sink-sensitivity table.
 *   6. Emit per-node coverage %, dead-rule report, and a ranked list
 *      of remediation suggestions.
 *
 * Non-goals:
 *   - We do NOT re-implement policy semantics here — we drive the real
 *     DslEvaluator so the report reflects what will actually fire at
 *     runtime.
 *   - We do NOT persist the report; the caller decides whether to
 *     Merkle-anchor it. Predeploy-scan.ts already has that pattern; a
 *     future release can wire this in.
 */

import type { WorkflowGraph, ToolBinding } from './types';
import { inferProvider } from './types';
import { WorkflowExtractorService, type WorkflowFile } from './extractor';
import type { DslPolicyService } from '../policy-dsl';
import type { MatchResult } from '../../policies/dsl/evaluator';
import { classifyToolCall } from '../classifier';

/**
 * Sensitive sinks — tool categories where an *uncovered* binding is a
 * BLOCKER, not just a warning. Anything else defaults to `info`.
 *
 * The list is intentionally conservative — false positives here are
 * cheap (extra rule added), false negatives are the whole point of
 * pre-deploy scan and expensive.
 */
const SENSITIVE_PROVIDERS: ReadonlySet<string> = new Set([
  'stripe', 'circle_usdc', 'coinbase', 'plaid', 'visa', 'mastercard', 'brex',
  'postgres', 'mysql',
  's3',
  'slack', 'sendgrid', 'twilio',
  'shell', 'file',
  'http',    // any outbound HTTP is at least "warn"-worthy
]);

const SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set([
  'payment', 'money-movement',
  'database', 'destructive-database',
  'file', 'shell', 'network', 'email',
]);

export type BindingStatus = 'covered' | 'uncovered' | 'warn';
export type BindingSeverity = 'blocker' | 'warn' | 'info';

export interface CoverageBinding {
  node_id: string;
  tool_name: string;
  provider?: string;
  category?: string;                    // from classifyToolCall
  status: BindingStatus;
  severity: BindingSeverity;
  matched_rule?: {
    name: string;
    decision: string;
    reason?: string;
    tags?: string[];
  };
  /**
   * Human-readable rationale for `status` and `severity`. Rendered
   * inline in the cockpit coverage panel.
   */
  explain: string;
}

export interface NodeCoverage {
  node_id: string;
  node_name: string;
  total: number;
  covered: number;
  uncovered_blocker: number;
  uncovered_warn: number;
  coverage_pct: number;
}

export interface CoverageRecommendation {
  kind: 'add_rule' | 'remove_dead_rule' | 'raise_severity';
  message: string;
  target?: string;                      // tool_name, rule name, etc.
  suggested_dsl?: string;               // pseudo-DSL snippet
}

export interface CoverageReport {
  workflow: WorkflowGraph;
  summary: {
    total_bindings: number;
    covered: number;
    uncovered_blocker: number;
    uncovered_warn: number;
    coverage_pct: number;
    dead_rules: string[];               // rules that matched zero bindings
    per_node: NodeCoverage[];
  };
  bindings: CoverageBinding[];
  recommendations: CoverageRecommendation[];
  scanned_at: string;
}

export class CoverageScanService {
  constructor(
    private extractor: WorkflowExtractorService,
    private dsl: DslPolicyService,
  ) {}

  scan(opts: {
    orgId: string;
    files: WorkflowFile[];
    root_path?: string;
    agent_id?: string;
  }): CoverageReport {
    const workflow = this.extractor.extract({
      files: opts.files,
      root_path: opts.root_path,
      agent_id: opts.agent_id,
    });

    const evaluator = this.dsl.getEvaluator(opts.orgId);

    // Track which rules were hit at least once (for the dead-rule
    // list). Populated as we dry-run bindings.
    const ruleHits = new Map<string, number>();

    const bindings: CoverageBinding[] = workflow.tool_bindings.map(b =>
      this.evaluateBinding(b, evaluator, ruleHits),
    );

    // Summary + per-node stats.
    const byNode = new Map<string, CoverageBinding[]>();
    for (const b of bindings) {
      const list = byNode.get(b.node_id) ?? [];
      list.push(b);
      byNode.set(b.node_id, list);
    }

    const perNode: NodeCoverage[] = workflow.nodes.map(n => {
      const bs = byNode.get(n.id) ?? [];
      const covered   = bs.filter(b => b.status === 'covered').length;
      const blockers  = bs.filter(b => b.severity === 'blocker' && b.status !== 'covered').length;
      const warns     = bs.filter(b => b.severity === 'warn'    && b.status !== 'covered').length;
      return {
        node_id: n.id,
        node_name: n.name,
        total: bs.length,
        covered,
        uncovered_blocker: blockers,
        uncovered_warn:    warns,
        coverage_pct: bs.length === 0 ? 100 : Math.round((covered / bs.length) * 100),
      };
    });

    const total       = bindings.length;
    const covered     = bindings.filter(b => b.status === 'covered').length;
    const blockers    = bindings.filter(b => b.severity === 'blocker' && b.status !== 'covered').length;
    const warns       = bindings.filter(b => b.severity === 'warn'    && b.status !== 'covered').length;

    // Dead rules — any rule name known to the evaluator but never hit.
    const dead_rules = this.deadRules(opts.orgId, ruleHits);

    // Recommendations — one per uncovered blocker + one per dead rule.
    const recommendations: CoverageRecommendation[] = [];
    for (const b of bindings) {
      if (b.status !== 'covered' && b.severity === 'blocker') {
        recommendations.push({
          kind: 'add_rule',
          target: b.tool_name,
          message: `Add a DSL rule that covers ${b.tool_name}${b.provider ? ` (${b.provider})` : ''} — currently unmatched and classified as ${b.category ?? 'sensitive'}.`,
          suggested_dsl: suggestDsl(b),
        });
      }
    }
    for (const r of dead_rules) {
      recommendations.push({
        kind: 'remove_dead_rule',
        target: r,
        message: `Rule "${r}" never matched any tool binding in the current workflow. Remove or narrow its condition.`,
      });
    }

    return {
      workflow,
      summary: {
        total_bindings: total,
        covered,
        uncovered_blocker: blockers,
        uncovered_warn:    warns,
        coverage_pct: total === 0 ? 100 : Math.round((covered / total) * 100),
        dead_rules,
        per_node: perNode,
      },
      bindings,
      recommendations,
      scanned_at: new Date().toISOString(),
    };
  }

  // ── per-binding evaluation ─────────────────────────────────────────

  private evaluateBinding(
    b: ToolBinding,
    evaluator: ReturnType<DslPolicyService['getEvaluator']>,
    ruleHits: Map<string, number>,
  ): CoverageBinding {
    // Classify the tool call (uses the same classifier the runtime
    // check pipeline uses, so coverage numbers reflect production).
    const classification = classifyToolCall(b.tool_name, {});
    const category = (classification as any).category as string | undefined;
    const provider = b.provider ?? inferProvider(b.tool_name);

    const severity = this.severityForBinding(provider, category);

    if (!evaluator) {
      return {
        node_id: b.node_id, tool_name: b.tool_name, provider, category,
        status: severity === 'info' ? 'uncovered' : 'uncovered',
        severity,
        explain: `No DSL loaded for tenant; every binding is uncovered.`,
      };
    }

    // Synthesise the minimum DslContext that a real /check request
    // would present. Rules that only depend on tool.name / category
    // will fire; rules that require runtime signals (anomaly, PII,
    // alignment) can't be evaluated statically — we treat those as
    // "warn" (partially-covered).
    const ctx = {
      tool: { name: b.tool_name, args: {} },
      classifier: category ? { category } : undefined,
      agent: { id: 'predeploy-scan' },
    };
    let match: MatchResult | null = null;
    try {
      match = evaluator.evaluate(ctx as any);
    } catch {
      match = null;
    }

    if (match) {
      const hitCount = ruleHits.get(match.ruleName) ?? 0;
      ruleHits.set(match.ruleName, hitCount + 1);
      return {
        node_id: b.node_id, tool_name: b.tool_name, provider, category,
        status: 'covered',
        severity,
        matched_rule: {
          name: match.ruleName,
          decision: match.decision,
          reason: match.reason,
          tags: match.tags,
        },
        explain: `Matched rule "${match.ruleName}" → ${match.decision}.`,
      };
    }

    return {
      node_id: b.node_id, tool_name: b.tool_name, provider, category,
      status: 'uncovered',
      severity,
      explain: severity === 'blocker'
        ? `No rule matched a sensitive ${category ?? 'unknown-category'} sink. Blocker.`
        : `No rule matched. Category "${category ?? 'unknown'}" — informational.`,
    };
  }

  private severityForBinding(provider: string | undefined, category: string | undefined): BindingSeverity {
    if (provider && SENSITIVE_PROVIDERS.has(provider)) {
      // File / shell / DB / payments always default to blocker on uncovered.
      if (['stripe', 'circle_usdc', 'coinbase', 'plaid', 'visa', 'mastercard',
           'shell', 'file', 'postgres', 'mysql'].includes(provider)) {
        return 'blocker';
      }
      return 'warn';
    }
    if (category && SENSITIVE_CATEGORIES.has(category)) {
      return 'blocker';
    }
    return 'info';
  }

  private deadRules(orgId: string, hits: Map<string, number>): string[] {
    const evaluator = this.dsl.getEvaluator(orgId);
    if (!evaluator) return [];
    // We reach into the compiled rule list — the evaluator exposes
    // it only via evaluate(). Duck-type an escape hatch.
    const compiled = (evaluator as any).compiled;
    if (!compiled?.rules) return [];
    const dead: string[] = [];
    for (const r of compiled.rules) {
      if (!hits.has(r.name)) dead.push(r.name);
    }
    return dead;
  }
}

/** Suggest a starter DSL block for an uncovered binding. Pseudo-DSL —
 *  the operator adapts it before saving. */
function suggestDsl(b: CoverageBinding): string {
  const decision = b.severity === 'blocker' ? 'BLOCK' : 'ESCALATE';
  const nameSlug = `${b.tool_name}-guard`.replace(/[^\w-]/g, '-').toLowerCase();
  return [
    `- name: "${nameSlug}"`,
    `  when: tool.name == "${b.tool_name}"`,
    `  then:`,
    `    decision: ${decision}`,
    `    reason: "Auto-suggested by coverage scan — refine before use"`,
  ].join('\n');
}
