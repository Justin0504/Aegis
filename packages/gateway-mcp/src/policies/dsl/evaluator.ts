/**
 * Safe walker over a CompiledDsl.
 *
 * No eval, no Function constructors. Dotted-path access only;
 * comparators are exact-match opcodes. Bounded by rule count (100,
 * enforced at compile) and a constant-time short-circuit.
 */

import { DslDecision } from '@agentguard/core-schema';
import {
  CompiledCondition,
  CompiledDsl,
  CompiledRule,
  FieldCheck,
} from './ast';

export interface DslContext {
  classifier?: {
    category?: string;
    signals?: string[];
    risks?: Array<{ type?: string; severity?: string }>;
    [k: string]: unknown;
  };
  anomaly?: {
    score?: number;
    decision?: string;
    [k: string]: unknown;
  };
  policy?: {
    passed?: boolean;
    riskLevel?: string;
    violations?: string[];
    [k: string]: unknown;
  };
  /**
   * Optional agent alignment signal — only present when an SDK that
   * captures chain-of-thought has run /api/v1/alignment/check and
   * passes the result through to /check. Rules can match on
   * `alignment.score < X` or `alignment.drifted == true`.
   */
  alignment?: {
    score?: number;
    drifted?: boolean;
    signals?: string[];
    reason?: string;
    [k: string]: unknown;
  };
  /**
   * Optional CodeShield signal — present when the caller ran
   * /api/v1/code-shield/scan on generated code before invoking the
   * tool. Rules can match on `code_shield.worst == "CRITICAL"` or
   * `code_shield.findings_count > 0`.
   */
  code_shield?: {
    worst?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
    findings_count?: number;
    rules?: string[];
    [k: string]: unknown;
  };
  tool?: {
    name?: string;
    args?: Record<string, unknown>;
    [k: string]: unknown;
  };
  agent?: { id?: string; [k: string]: unknown };
  tenant?: { id?: string; deploymentMode?: string; [k: string]: unknown };
  /**
   * Phase 1.3 workflow-anchored context. Populated when the SDK sent
   * `workflow_node_id` / `workflow_binding_id` on the intercepted
   * call. Enables Phase 2 NL policies to say
   *   when workflow.node_id == "<uuid>" and ...
   * rather than string-matching `tool.name`. Absent when the caller
   * has no workflow scope — legacy calls continue to work.
   */
  workflow?: {
    node_id?: string;
    binding_id?: string;
    [k: string]: unknown;
  };
}

export interface MatchResult {
  decision: DslDecision;
  reason?: string;
  ruleName: string;
  tags?: string[];
}

export class DslEvaluator {
  constructor(private compiled: CompiledDsl) {}

  /** Walk rules top-down. First matching rule wins. */
  evaluate(ctx: DslContext): MatchResult | null {
    for (const rule of this.compiled.rules) {
      if (this.matches(rule, ctx)) {
        return {
          decision: rule.then.decision,
          reason: rule.then.reason,
          tags: rule.then.tags,
          ruleName: rule.name,
        };
      }
    }
    return null;
  }

  private matches(rule: CompiledRule, ctx: DslContext): boolean {
    if (!rule.when) return true;
    return evalCondition(rule.when, ctx);
  }
}

function evalCondition(cond: CompiledCondition, ctx: DslContext): boolean {
  switch (cond.kind) {
    case 'all':
      for (const child of cond.children) {
        if (!evalCondition(child, ctx)) return false;
      }
      return true;
    case 'any':
      for (const child of cond.children) {
        if (evalCondition(child, ctx)) return true;
      }
      return false;
    case 'not':
      return !evalCondition(cond.child, ctx);
    case 'field':
      for (const check of cond.checks) {
        if (!evalFieldCheck(check, ctx)) return false;
      }
      return true;
  }
}

function evalFieldCheck(check: FieldCheck, ctx: DslContext): boolean {
  const value = readPath(ctx as unknown as Record<string, unknown>, check.path);
  return evalOp(check.op, value);
}

function evalOp(op: FieldCheck['op'], value: unknown): boolean {
  switch (op.kind) {
    case 'eq':
      return strictEqualish(value, op.value);
    case 'ne':
      return !strictEqualish(value, op.value);
    case 'gt':
      return typeof value === 'number' && value > op.value;
    case 'lt':
      return typeof value === 'number' && value < op.value;
    case 'gte':
      return typeof value === 'number' && value >= op.value;
    case 'lte':
      return typeof value === 'number' && value <= op.value;
    case 'in':
      return op.values.some((v) => strictEqualish(value, v));
    case 'matches':
      return typeof value === 'string' && op.regex.test(value);
  }
}

/**
 * Equality used by `==`/`in`. Strict for primitives, but treats null and
 * undefined as the same so missing fields don't accidentally equal "null".
 */
function strictEqualish(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function readPath(
  root: Record<string, unknown>,
  path: string[],
): unknown {
  let cur: unknown = root;
  for (const segment of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Order decisions by strictness; used by the final merge. */
const STRICTNESS: Record<DslDecision, number> = {
  allow: 0,
  pending: 1,
  block: 2,
};

export function strictest(a: DslDecision, b: DslDecision): DslDecision {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}
