/**
 * WorkflowGraph — the canonical output of every framework-specific
 * extractor. Whatever the source language is (Python for LangGraph /
 * CrewAI / AutoGen, TypeScript for Mastra / LangGraph.js), the
 * downstream consumer (predeploy scan, coverage map, cockpit workflow
 * view) only ever sees this shape.
 *
 * Design rules:
 *  - Every node has a stable `id` (slug-cased, deterministic from the
 *    source location) so the graph diff between two commits is
 *    meaningful.
 *  - Every edge is uni-directional. Conditional edges are represented
 *    as N distinct edges from the same source, each with its own
 *    `condition` string.
 *  - Tool bindings live in a separate array (not folded into node
 *    metadata) so multi-tool nodes and per-tool policy attachment are
 *    both cheap.
 *  - Warnings are structured — `code` is a machine identifier
 *    (`AMBIGUOUS_ROUTING`, `TOOL_NAME_DYNAMIC`, `NO_ENTRY_POINT`) so
 *    the cockpit can render fix hints per code.
 */

export type Framework =
  | 'langgraph'
  | 'crewai'
  | 'autogen'
  | 'mastra'
  | 'unknown';

export type SourceLanguage = 'python' | 'typescript' | 'javascript' | 'mixed';

export type NodeKind =
  | 'agent'          // e.g. CrewAI `Agent`, AutoGen `AssistantAgent`
  | 'router'         // conditional dispatch node
  | 'tool'           // dedicated tool wrapper node
  | 'condition'      // pure branching without side effects
  | 'human'          // human-in-the-loop pause
  | 'end';           // terminal / finish node

export type EdgeKind =
  | 'sequential'     // A → B unconditional
  | 'conditional'    // A → B when <condition>
  | 'parallel'       // A fan-out to multiple targets
  | 'entry'          // START → A (framework-declared entry)
  | 'finish';        // A → END

export interface SourceRef {
  file: string;              // relative to the workflow root
  line: number;              // 1-indexed
  col?: number;
}

export interface WorkflowNode {
  id: string;                // stable slug, e.g. "customer_support"
  /**
   * Deterministic UUID v5 derived from (slug, source_ref.file, kind).
   * Stable across re-extractions of the same source. Renames give a
   * new uuid — that's a feature, not a bug: policy authors want to
   * know a node was replaced, not silently retargeted.
   *
   * This is what downstream layers (policies, compensators, intercepts)
   * reference — the slug is a display convenience only.
   *
   * Optional at the *parser* boundary — framework parsers only emit
   * the raw fields; the orchestrator (extractor.ts) computes UUIDs
   * once, canonically, before returning the WorkflowGraph. Downstream
   * consumers can safely assume it's set on any graph returned by
   * `WorkflowExtractorService.extract()`.
   */
  uuid?: string;
  name: string;              // display name from source
  kind: NodeKind;
  description?: string;      // extracted from docstring / comment
  source_ref?: SourceRef;
  metadata: {
    llm_model?: string;
    temperature?: number;
    max_tokens?: number;
    system_prompt?: string;  // first 200 chars if detectable
    role?: string;           // CrewAI-style role field
    tools_declared?: string[]; // convenience — full listing lives in tool_bindings
  };
}

export interface WorkflowEdge {
  from: string;              // node id
  to: string;                // node id
  kind: EdgeKind;
  condition?: string;        // pseudo-code snippet from the source
  source_ref?: SourceRef;
  /**
   * Deterministic UUID v5 derived from (from, to, kind, condition).
   * See WorkflowNode.uuid — same optional-at-parser-boundary rule.
   */
  uuid?: string;
}

export interface ToolBinding {
  node_id: string;
  tool_name: string;         // canonical name — as it will appear in tool_call.tool_name
  provider?: string;         // e.g. "stripe", "circle_usdc", "postgres" — inferred from name
  arg_schema_hint?: string;  // stringified schema summary if detectable
  source_ref?: SourceRef;
  /**
   * Deterministic UUID v5 derived from (node_id, tool_name). This is
   * the anchor for L5 (rollback compensators) so a compensator can be
   * attached to "this exact tool call inside this exact node" instead
   * of the tool_name globally. Optional at parser boundary — see
   * WorkflowNode.uuid.
   */
  uuid?: string;
}

export type WarningCode =
  | 'NO_ENTRY_POINT'
  | 'UNREACHABLE_NODE'
  | 'AMBIGUOUS_ROUTING'
  | 'TOOL_NAME_DYNAMIC'
  | 'UNKNOWN_NODE_REFERENCE'
  | 'CYCLE_DETECTED'
  | 'FRAMEWORK_DETECT_LOW_CONFIDENCE'
  | 'MULTI_FRAMEWORK_DETECTED';

export interface WorkflowWarning {
  severity: 'info' | 'warn' | 'error';
  code: WarningCode;
  message: string;
  source_ref?: SourceRef;
}

export interface WorkflowGraph {
  /** Optional — set when the caller has already correlated the graph
   *  to a registered agent id in the AEGIS registry. */
  agent_id?: string;
  framework: Framework;
  /** Framework version — best-effort, from imports / requirements. */
  framework_version?: string;
  extracted_at: string;      // ISO 8601
  source: {
    root_path: string;
    files_scanned: number;
    language: SourceLanguage;
  };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tool_bindings: ToolBinding[];
  /** Node ids declared as workflow entry points. */
  entry_points: string[];
  /** Node ids declared as terminal / finish points. */
  finish_points: string[];
  warnings: WorkflowWarning[];
  /**
   * Deterministic SHA-256 over the canonical serialisation of nodes,
   * edges, tool_bindings, entry_points, finish_points. Same graph →
   * same hash across re-extractions and machines.
   *
   * This is what `POST /api/v1/agents/register` binds into the signed
   * agent certificate. Later, if an agent's code changes shape (a new
   * tool binding, a rewired edge), the served certificate's
   * `workflow_hash` no longer matches and the gateway can reject the
   * traffic as "this identity was not attested to run THIS workflow."
   */
  content_hash: string;
}

/**
 * The shape returned by every framework parser BEFORE the orchestrator
 * stitches the WorkflowGraph together. Parsers only produce the
 * framework-specific parts; the orchestrator adds `extracted_at`,
 * `source`, and normalises node ids across files.
 */
export interface ParsedWorkflow {
  framework: Framework;
  framework_version?: string;
  language: SourceLanguage;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tool_bindings: ToolBinding[];
  entry_points: string[];
  finish_points: string[];
  warnings: WorkflowWarning[];
}

// ── Helpers exported for shared use across parsers ────────────────────

/** Slug helper: turns "customer_support-agent" / "Customer Support" /
 *  "customer.support" into a canonical id "customer_support". */
export function slugify(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// ── Deterministic UUID / hash helpers ────────────────────────────────
//
// UUID v5 needs a namespace + name. We pick a fixed AEGIS namespace
// (never regenerate this — it's part of the on-wire contract) so that
// two independent extractions of the same source produce byte-identical
// UUIDs. Names are canonical strings — kept ASCII + lowercased upstream
// so accidental whitespace doesn't shift the identity.

import { createHash } from 'crypto';

/** Fixed namespace UUID (RFC 4122 v4) for all AEGIS-internal UUID v5
 *  derivations. Generated once, never rotated. */
const AEGIS_UUID_NS = 'e8b1c1de-4c9d-5b7f-9c2a-8e0d1a3b6f47';

/** RFC 4122 UUID v5 (name-based, SHA-1). Self-contained — avoids the
 *  `uuid` package dep. */
export function uuidv5(name: string, namespace: string = AEGIS_UUID_NS): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;   // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

/** UUID for a workflow node. Anchored on (slug, file, kind) so a
 *  rename produces a new UUID (safe: policies referencing the old
 *  node uuid stop matching, ops sees "this node was replaced"). */
export function nodeUuid(slug: string, file: string | undefined, kind: NodeKind): string {
  return uuidv5(`node:${kind}:${file ?? '?'}:${slug}`);
}

/** UUID for a workflow edge. Two edges with the same (from, to, kind,
 *  condition) tuple are the same edge — this matches operator intuition
 *  (a rewire changes at least one of these). */
export function edgeUuid(from: string, to: string, kind: EdgeKind, condition?: string): string {
  return uuidv5(`edge:${kind}:${from}->${to}:${condition ?? ''}`);
}

/** UUID for a tool binding. (node_id, tool_name) is the key — a
 *  compensator attached to this uuid says "when THIS node fires THIS
 *  tool, run THIS webhook." */
export function bindingUuid(nodeId: string, toolName: string): string {
  return uuidv5(`binding:${nodeId}:${toolName}`);
}

/**
 * Deterministic content hash over the graph. Canonicalisation:
 *   1. Sort nodes by uuid
 *   2. For each node, include (uuid, kind, slug, tools_declared sorted).
 *      Excludes source_ref (file/line change on refactor, not semantic).
 *      Excludes metadata (temp / max_tokens change is not workflow shape).
 *   3. Sort edges by uuid.
 *   4. Sort tool_bindings by uuid.
 *   5. Include entry_points + finish_points as sorted arrays.
 *
 * Two agents producing the SAME workflow topology on different
 * machines get the SAME hash. A refactor that renames a Python file
 * without changing wiring does NOT change the hash (source_ref
 * excluded). A rewire DOES change it.
 */
export function graphContentHash(g: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tool_bindings: ToolBinding[];
  entry_points: string[];
  finish_points: string[];
}): string {
  const canonical = {
    nodes: [...g.nodes]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map(n => ({
        uuid: n.uuid,
        kind: n.kind,
        slug: n.id,
        tools_declared: [...(n.metadata?.tools_declared ?? [])].sort(),
      })),
    edges: [...g.edges]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map(e => ({ uuid: e.uuid, from: e.from, to: e.to, kind: e.kind, condition: e.condition ?? null })),
    bindings: [...g.tool_bindings]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map(b => ({ uuid: b.uuid, node_id: b.node_id, tool_name: b.tool_name })),
    entry_points:  [...g.entry_points].sort(),
    finish_points: [...g.finish_points].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Best-effort provider inference from a canonical tool name. */
export function inferProvider(toolName: string): string | undefined {
  const s = toolName.toLowerCase();
  const KNOWN: Array<[RegExp, string]> = [
    [/^stripe[._]/,             'stripe'],
    [/^circle[._]?usdc?/,       'circle_usdc'],
    [/^coinbase[._]/,           'coinbase'],
    [/^plaid[._]/,              'plaid'],
    [/^visa[._]/,               'visa'],
    [/^mastercard[._]/,         'mastercard'],
    [/^brex[._]/,               'brex'],
    [/^postgres|^pg[._]|^sql[._]/, 'postgres'],
    [/^mysql[._]/,              'mysql'],
    [/^s3[._]|^aws[._]s3/,      's3'],
    [/^slack[._]/,              'slack'],
    [/^sendgrid[._]|^sg[._]send/, 'sendgrid'],
    [/^twilio[._]/,             'twilio'],
    [/^fhir[._]|^epic[._]/,     'fhir'],
    [/^openai[._]|^chat_?completion/, 'openai'],
    [/^anthropic[._]|^claude[._]/, 'anthropic'],
    [/^gemini[._]|^google[._]ai/, 'gemini'],
    [/^http[._]|^fetch|^get$|^post$|^request/, 'http'],
    [/^exec|^shell|^bash|^cmd/, 'shell'],
    [/^file[._]|^fs[._]|^read_file|^write_file/, 'file'],
  ];
  for (const [re, provider] of KNOWN) {
    if (re.test(s)) return provider;
  }
  return undefined;
}
