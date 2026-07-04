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
}

export interface ToolBinding {
  node_id: string;
  tool_name: string;         // canonical name — as it will appear in tool_call.tool_name
  provider?: string;         // e.g. "stripe", "circle_usdc", "postgres" — inferred from name
  arg_schema_hint?: string;  // stringified schema summary if detectable
  source_ref?: SourceRef;
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
