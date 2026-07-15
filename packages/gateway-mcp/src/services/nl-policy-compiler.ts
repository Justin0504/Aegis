/**
 * NlPolicyCompilerService — natural-language → workflow-aware DSL.
 *
 * The unique-to-AEGIS value:
 *   "Don't let support_agent send an email when the refund is over $10k"
 *   →  a DSL rule that references the ACTUAL workflow node UUID for
 *      send_email inside support_agent, not a global tool_name match.
 *
 * Two backends, picked at compile() time:
 *   1. `llm` — if the caller (or gateway env) supplies an LLM client,
 *      we hand the model a prompt containing the workflow graph JSON +
 *      the user's description and ask for a strict JSON DSL rule back.
 *      The model output is validated + parsed to a real PolicyDsl.
 *   2. `heuristic` — a small deterministic pattern matcher covering the
 *      handful of policy shapes that don't need an LLM:
 *        · "block tool X"
 *        · "require approval for tool X"
 *        · "require approval when X.amount > N"
 *        · "block when risk >= HIGH"
 *      Enough to keep the endpoint useful (and testable) with zero
 *      configuration. The cockpit will always prefer `llm` when it's
 *      available.
 *
 * Every compile() run returns:
 *   - `compiled` — the PolicyDsl object (already schema-parsed, so a
 *     downstream `getEvaluator()` never sees a bad rule).
 *   - `references` — { node_uuids[], binding_uuids[] } the compiler
 *     actually resolved. The cockpit uses these to highlight nodes
 *     on the workflow view so users can see what their rule targets.
 *   - `explanation` — a plain-English restatement of what the rule
 *     will do, so operators can sanity-check before saving.
 *   - `backend` — 'llm' | 'heuristic', for the audit trail.
 *   - `warnings` — soft signals ("your description mentioned
 *     `send_email` but I couldn't find a node by that name").
 *
 * See services/workflow/types.ts for the WorkflowGraph shape and
 * services/policy-dsl.ts for how the compiled DSL is loaded into the
 * per-tenant evaluator.
 */

import { Logger } from 'pino';
import type { PolicyDsl, Rule as PolicyRule } from '@agentguard/core-schema';
import { PolicyDslSchema } from '@agentguard/core-schema';
import type { WorkflowGraph, WorkflowNode, ToolBinding } from './workflow/types';

// ── LLM client contract (adapter-pattern, no vendor lock-in) ──────────

/**
 * Minimum contract we ask of an LLM. Any adapter (Anthropic, OpenAI,
 * a local model) satisfies this. Keeps the compiler unit-testable
 * with a plain function stub.
 *
 * The adapter MUST return raw text; JSON parsing + schema validation
 * happen inside the compiler so a malformed model response can't
 * poison the rule set.
 */
export interface NlLlmClient {
  complete(opts: {
    system: string;
    user: string;
    /** Milliseconds. 8000 is a reasonable ceiling for a rule compile. */
    timeoutMs?: number;
  }): Promise<string>;
}

// ── Public API ────────────────────────────────────────────────────────

export interface NlCompileRequest {
  /** Natural-language description of the policy. Required. */
  description: string;
  /** Workflow graph the rule should target. When present, the compiler
   *  can resolve node references (send_email → the specific node UUID)
   *  and reject descriptions that name nodes / tools not in the graph.
   *  Omit for framework-agnostic rules ("block all shell tools"). */
  workflow?: WorkflowGraph;
  /** Optional rule name — defaults to a slugified prefix of the
   *  description. */
  name?: string;
  /** Force a specific backend; useful in tests. Defaults to 'llm'
   *  when an LLM client is configured, else 'heuristic'. */
  backend?: 'llm' | 'heuristic';
}

export interface NlCompileResult {
  compiled: PolicyDsl;
  references: {
    node_uuids: string[];
    binding_uuids: string[];
  };
  explanation: string;
  backend: 'llm' | 'heuristic';
  warnings: string[];
}

export class NlPolicyCompilerService {
  constructor(
    private logger: Logger,
    private llm?: NlLlmClient,
  ) {}

  async compile(req: NlCompileRequest): Promise<NlCompileResult> {
    if (!req.description || !req.description.trim()) {
      throw new Error('description is required');
    }

    const backend = req.backend ?? (this.llm ? 'llm' : 'heuristic');
    const start = Date.now();
    try {
      if (backend === 'llm') {
        if (!this.llm) throw new Error('LLM backend requested but no client configured');
        return await this.compileWithLlm(req);
      }
      return this.compileHeuristic(req);
    } finally {
      this.logger.debug(
        { backend, took_ms: Date.now() - start, len: req.description.length },
        'nl-policy compile',
      );
    }
  }

  // ── Heuristic backend — small, deterministic, zero-dependency ─────

  /**
   * Pattern-matches on a handful of phrasings and produces a
   * corresponding DSL rule. NOT meant to cover the long tail — its
   * job is to be predictable + tests can rely on the same output on
   * every machine. The cockpit surfaces the backend name so the user
   * can tell they got the heuristic (and could ask for an LLM upgrade).
   */
  private compileHeuristic(req: NlCompileRequest): NlCompileResult {
    const desc = req.description.trim();
    const lower = desc.toLowerCase();
    const warnings: string[] = [];
    const nodeUuids: string[] = [];
    const bindingUuids: string[] = [];

    // Attempt to resolve any bare tool name mentioned in the text to
    // an actual workflow node / binding — that's the workflow-aware
    // magic even the heuristic backend can offer.
    const toolNameHit = req.workflow
      ? findMentionedTool(desc, req.workflow)
      : null;
    if (toolNameHit) {
      if (toolNameHit.binding.uuid) bindingUuids.push(toolNameHit.binding.uuid);
      if (toolNameHit.node.uuid) nodeUuids.push(toolNameHit.node.uuid);
    }

    let rule: PolicyRule;
    let explanation: string;

    // Pattern 1 — "require approval for X" or "pause X for review"
    if (/require\s+(human\s+)?approval|pause .* for review|need approval/i.test(lower)) {
      const dollarThreshold = extractDollarThreshold(lower);
      const conditions: Record<string, unknown> = {};
      if (toolNameHit) {
        conditions['workflow.binding_id'] = toolNameHit.binding.uuid;
      } else {
        conditions['tool.name'] = { '!=': null };
      }
      if (dollarThreshold !== null) {
        // Amount is commonly at tool.args.amount — best guess.
        conditions['tool.args.amount'] = { '>': dollarThreshold };
      }
      rule = {
        name:  req.name ?? deriveName(desc, 'require-approval'),
        when:  { all: [conditions] },
        then:  { decision: 'pending', reason: desc.slice(0, 200) },
      } as PolicyRule;
      explanation = toolNameHit
        ? `When node "${toolNameHit.node.name}" fires with tool "${toolNameHit.binding.tool_name}"`
          + (dollarThreshold !== null ? ` and amount > $${dollarThreshold}` : '')
          + ', pause for human approval.'
        : `Whenever any tool call runs${dollarThreshold !== null ? ` with amount > $${dollarThreshold}` : ''}, pause for human approval.`;
    }
    // Pattern 2 — "block tool X" / "don't let X" / "never call X"
    else if (/block|don'?t\s+let|never\s+(call|allow)|refuse/i.test(lower)) {
      const conditions: Record<string, unknown> = {};
      if (toolNameHit) {
        conditions['workflow.binding_id'] = toolNameHit.binding.uuid;
      } else {
        // No tool resolved — fall back to risk-based block if the user
        // mentioned a risk band.
        const risk = extractRiskLevel(lower);
        if (risk) conditions['policy.riskLevel'] = risk;
        else {
          warnings.push('block-shaped rule but no tool / node / risk level detected; the generated rule may be too broad');
          conditions['tool.name'] = { '!=': null };
        }
      }
      rule = {
        name:  req.name ?? deriveName(desc, 'block'),
        when:  { all: [conditions] },
        then:  { decision: 'block', reason: desc.slice(0, 200) },
      } as PolicyRule;
      explanation = toolNameHit
        ? `Block every call to "${toolNameHit.binding.tool_name}" from node "${toolNameHit.node.name}".`
        : `Block calls matching the described condition.`;
    }
    // Pattern 3 — "log" / "monitor" (route to pending; the AEGIS DSL
    // is decision-only, so a "warn" intent is expressed as
    // "pause for review" with a low-priority reason string).
    else if (/^(log|monitor|track|record|alert)/i.test(lower)) {
      warnings.push('AEGIS DSL has no `warn` decision — routed "log/monitor" to `pending` (call is paused, not silently allowed)');
      const conditions: Record<string, unknown> = toolNameHit
        ? { 'workflow.binding_id': toolNameHit.binding.uuid }
        : { 'tool.name': { '!=': null } };
      rule = {
        name:  req.name ?? deriveName(desc, 'watch'),
        when:  { all: [conditions] },
        then:  { decision: 'pending', reason: `[watch] ${desc.slice(0, 190)}` },
      } as PolicyRule;
      explanation = 'Pause the call for review (AEGIS has no silent-log decision — a review queue entry gets created instead).';
    }
    // Pattern 4 — nothing matched → conservative default
    else {
      warnings.push('description did not match any heuristic pattern; produced a conservative "pending on any tool" rule');
      rule = {
        name:  req.name ?? deriveName(desc, 'pending'),
        when:  { all: [{ 'tool.name': { '!=': null } }] },
        then:  { decision: 'pending', reason: desc.slice(0, 200) },
      } as PolicyRule;
      explanation = 'Nothing matched a known template — emitted a fallback pending rule (every call routes to human review). Rephrase with "block", "require approval", or by naming a specific tool for a narrower rule.';
    }

    const compiled = PolicyDslSchema.parse({ version: 1, rules: [rule] });
    return {
      compiled,
      references: { node_uuids: nodeUuids, binding_uuids: bindingUuids },
      explanation,
      backend: 'heuristic',
      warnings,
    };
  }

  // ── LLM backend — ships the workflow graph as context ─────────────

  private async compileWithLlm(req: NlCompileRequest): Promise<NlCompileResult> {
    const system = buildLlmSystemPrompt(req.workflow);
    const user = req.description.trim();
    const raw = await this.llm!.complete({ system, user, timeoutMs: 8000 });

    // Extract the JSON block. LLMs sometimes wrap in ```json fences.
    const jsonText = extractJsonBlock(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`LLM produced non-JSON output: ${(e as Error).message}`);
    }

    // Validate through the same PolicyDslSchema the DSL evaluator uses.
    // A model that hallucinates a bad shape can't pollute the rule set.
    const shaped =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rules)
        ? { version: 1 as const, rules: (parsed as any).rules }
        : { version: 1 as const, rules: [parsed] };
    const compiled = PolicyDslSchema.parse(shaped);

    const refs = resolveReferences(compiled, req.workflow);
    return {
      compiled,
      references: refs,
      explanation: (parsed as any).explanation ?? 'LLM-generated rule (no explanation provided).',
      backend: 'llm',
      warnings: refs.warnings,
    };
  }
}

// ── Helpers (module-local) ────────────────────────────────────────────

/**
 * Best-effort match of a tool name mentioned in free text against a
 * workflow's tool bindings. Prefers exact-substring hits; falls back
 * to a partial suffix match ("email" → "send_email"). Returns null
 * when nothing plausible was found.
 */
function findMentionedTool(
  desc: string,
  workflow: WorkflowGraph,
): { node: WorkflowNode; binding: ToolBinding } | null {
  const lower = desc.toLowerCase();
  const byNodeId = new Map(workflow.nodes.map(n => [n.id, n]));

  // Exact match on tool_name first.
  for (const b of workflow.tool_bindings) {
    const t = b.tool_name.toLowerCase();
    if (lower.includes(t) && byNodeId.has(b.node_id)) {
      return { node: byNodeId.get(b.node_id)!, binding: b };
    }
  }
  // Fallback: partial — split tool name on _ and match any component.
  for (const b of workflow.tool_bindings) {
    const parts = b.tool_name.toLowerCase().split('_').filter(p => p.length >= 4);
    for (const p of parts) {
      if (lower.includes(p) && byNodeId.has(b.node_id)) {
        return { node: byNodeId.get(b.node_id)!, binding: b };
      }
    }
  }
  return null;
}

/** Extract a dollar threshold from patterns like "over $10k", "> 5000". */
function extractDollarThreshold(lower: string): number | null {
  // "$10k" / "$10,000" / "10000"
  const dollarMatch = lower.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|m|million)?/);
  if (dollarMatch) {
    return normaliseNumber(dollarMatch[1], dollarMatch[2]);
  }
  const bareMatch = lower.match(/(?:over|above|greater than|more than|>=?)\s+([\d,]+(?:\.\d+)?)\s*(k|thousand|m|million)?/);
  if (bareMatch) {
    return normaliseNumber(bareMatch[1], bareMatch[2]);
  }
  return null;
}

function normaliseNumber(numStr: string, suffix?: string): number {
  const base = Number(numStr.replace(/,/g, ''));
  if (!Number.isFinite(base)) return NaN;
  if (!suffix) return base;
  const s = suffix.toLowerCase();
  if (s === 'k' || s === 'thousand') return base * 1_000;
  if (s === 'm' || s === 'million')  return base * 1_000_000;
  return base;
}

function extractRiskLevel(lower: string): string | null {
  if (/critical/.test(lower))   return 'CRITICAL';
  if (/high[\s-]?risk|high\b/.test(lower)) return 'HIGH';
  if (/medium/.test(lower))     return 'MEDIUM';
  if (/low[\s-]?risk|low\b/.test(lower))   return 'LOW';
  return null;
}

function deriveName(desc: string, prefix: string): string {
  const slug = desc
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 60);
  return `${prefix}-${slug || 'rule'}`;
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // If not fenced, find the first { ... last } — cheap balanced-brace guess.
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return raw.slice(first, last + 1);
  return raw.trim();
}

function buildLlmSystemPrompt(workflow?: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push(
    'You are an AEGIS policy compiler. Convert the operator\'s',
    'natural-language policy description into a strict JSON DSL rule.',
    '',
    'Output MUST be valid JSON with this shape (no prose, no fences):',
    '  { "rules": [ { "name": "...", "when": {...}, "then": { "decision": "..." } } ], "explanation": "..." }',
    '',
    'Decisions are exactly one of: "allow", "block", "require_approval", "warn".',
    'Conditions use dotted paths against this context object:',
    '  { tool.name, tool.args.*, agent.id, classifier.category,',
    '    anomaly.score, policy.riskLevel, workflow.node_id, workflow.binding_id }',
    'Comparators: bare value = equality; { ">": N }, { "<": N }, { ">=": N },',
    '  { "<=": N }, { "!=": v }, { "in": [...] }.',
    '',
    'Prefer `workflow.node_id` / `workflow.binding_id` (UUIDs from the graph',
    'below) over `tool.name` string matches — UUIDs survive tool renames.',
  );
  if (workflow) {
    lines.push('', 'WORKFLOW GRAPH:');
    lines.push('Nodes:');
    for (const n of workflow.nodes) {
      lines.push(`  - name="${n.name}" uuid=${n.uuid ?? '<none>'} kind=${n.kind}`);
    }
    lines.push('Tool bindings (node → tool):');
    for (const b of workflow.tool_bindings) {
      lines.push(`  - node=${b.node_id} tool="${b.tool_name}" binding_uuid=${b.uuid ?? '<none>'}`);
    }
  }
  return lines.join('\n');
}

function resolveReferences(dsl: PolicyDsl, workflow?: WorkflowGraph): {
  node_uuids: string[]; binding_uuids: string[]; warnings: string[];
} {
  const nodeUuids = new Set<string>();
  const bindingUuids = new Set<string>();
  const warnings: string[] = [];
  const validNodes    = new Set(workflow?.nodes.map(n => n.uuid).filter((x): x is string => Boolean(x)));
  const validBindings = new Set(workflow?.tool_bindings.map(b => b.uuid).filter((x): x is string => Boolean(x)));

  const walk = (v: unknown): void => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as any)) {
        if (k === 'workflow.node_id' && typeof val === 'string') {
          nodeUuids.add(val);
          if (workflow && !validNodes.has(val)) {
            warnings.push(`rule references workflow.node_id=${val} which is not in the supplied graph`);
          }
        } else if (k === 'workflow.binding_id' && typeof val === 'string') {
          bindingUuids.add(val);
          if (workflow && !validBindings.has(val)) {
            warnings.push(`rule references workflow.binding_id=${val} which is not in the supplied graph`);
          }
        } else {
          walk(val);
        }
      }
    }
  };
  walk(dsl);
  return {
    node_uuids: [...nodeUuids],
    binding_uuids: [...bindingUuids],
    warnings,
  };
}
