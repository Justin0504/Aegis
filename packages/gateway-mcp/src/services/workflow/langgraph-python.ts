/**
 * LangGraph (Python) workflow parser.
 *
 * LangGraph's builder API has a small, near-declarative surface, so a
 * disciplined regex sweep gets us 90% of the way without a full
 * Python AST parser (which we save for edge-case v2 in tree-sitter).
 *
 * Handled today:
 *   StateGraph(...)                       — top-level graph object
 *   .add_node("name", fn)                 — node declaration
 *   .add_edge("from", "to")               — sequential edge
 *   .add_edge("from", END)                — finish edge
 *   .add_conditional_edges("from",
 *      routing_fn, { "yes": "b", "no":"c" })
 *   .set_entry_point("name")              — entry
 *   .set_finish_point("name")             — finish
 *
 * Node → function → tool bindings:
 *   Each `add_node("x", fn_x)` also gets scanned: we find the `def fn_x`
 *   body and extract the tools it invokes via known patterns like
 *   `tool.invoke(...)`, `Tool(...)`, `@tool` decorators, or a plain
 *   `<name>_tool(...)` call.
 *
 * Warnings emitted:
 *   NO_ENTRY_POINT          — no `.set_entry_point` and no START edge
 *   UNKNOWN_NODE_REFERENCE  — an edge cites a node id that was never added
 *   TOOL_NAME_DYNAMIC       — `.add_node(name_var, ...)` where the id
 *                             is a variable, not a literal
 */

import type {
  ParsedWorkflow, WorkflowNode, WorkflowEdge, ToolBinding,
  WorkflowWarning, SourceRef,
} from './types';
import { slugify, inferProvider } from './types';

interface FileEntry { path: string; text: string; }

// ── Regex primitives ──────────────────────────────────────────────────

// "..."|'...'  — captures the literal string content (no quotes).
const STR = String.raw`(?:"([^"]*)"|'([^']*)')`;
// bareword (Python identifier)
const ID  = String.raw`([A-Za-z_][\w]*)`;

const RE_ADD_NODE          = new RegExp(String.raw`(\w+)\.add_node\s*\(\s*${STR}\s*,\s*${ID}`, 'g');
const RE_ADD_NODE_DYNAMIC  = new RegExp(String.raw`(\w+)\.add_node\s*\(\s*${ID}\s*,`, 'g');
const RE_ADD_EDGE          = new RegExp(String.raw`(\w+)\.add_edge\s*\(\s*${STR}\s*,\s*(?:${STR}|(END|START))`, 'g');
const RE_ADD_COND_EDGES    = new RegExp(String.raw`(\w+)\.add_conditional_edges\s*\(\s*${STR}\s*,\s*(\w+)(?:\s*,\s*(\{[^}]*\}))?`, 'gs');
const RE_SET_ENTRY         = new RegExp(String.raw`(\w+)\.set_entry_point\s*\(\s*${STR}`, 'g');
const RE_SET_FINISH        = new RegExp(String.raw`(\w+)\.set_finish_point\s*\(\s*${STR}`, 'g');

// Framework-version marker: `langgraph==0.2.4` in requirements, or
// `langgraph.__version__` referenced in source.
const RE_VERSION_HINT      = /langgraph\s*(?:==|>=|<=|~=)\s*([\d.]+)/;

// Match a Python function def: header + body until dedent. We use a
// simple heuristic — everything between `def name(...):` and the next
// zero-indent line.
const RE_DEF               = new RegExp(String.raw`^\s*def\s+${ID}\s*\([^)]*\)\s*:\s*$`, 'gm');

// Tool-call detection inside a function body.
const RE_TOOL_INVOKE       = /(\w+)\.invoke\s*\(/g;             // langchain-style .invoke
const RE_TOOL_RUN          = /(\w+)\.run\s*\(/g;                // .run()
const RE_TOOL_CALL         = /(\w+)_tool\s*\(/g;                // <name>_tool(...)
const RE_TOOL_DECORATED    = /@tool[\s(]/g;                     // @tool decorator (declares a callable)

// A conditional-edge routing dict — parsed as key→value string pairs
// from `{"yes": "b", "no": "c"}`. We tolerate trailing commas.
const RE_ROUTING_ENTRY     = new RegExp(String.raw`${STR}\s*:\s*${STR}`, 'g');

// ── Parser ────────────────────────────────────────────────────────────

export function parseLangGraphPython(files: FileEntry[]): ParsedWorkflow {
  const nodes  = new Map<string, WorkflowNode>();
  const edges: WorkflowEdge[] = [];
  const toolBindings: ToolBinding[] = [];
  const entryPoints  = new Set<string>();
  const finishPoints = new Set<string>();
  const warnings: WorkflowWarning[] = [];

  // First pass: collect version + any function definitions across the
  // whole file set so tool bindings can be resolved regardless of the
  // file the graph was declared in.
  const functionBodies = new Map<string, { file: string; startLine: number; body: string }>();
  let frameworkVersion: string | undefined;

  for (const f of files) {
    if (!frameworkVersion) {
      const m = RE_VERSION_HINT.exec(f.text);
      if (m) frameworkVersion = m[1];
    }
    collectFunctionBodies(f, functionBodies);
  }

  // Second pass: parse the graph-builder calls.
  for (const f of files) {
    const text = f.text;

    // Nodes — literal-name form.
    for (const m of matchAll(text, RE_ADD_NODE)) {
      const nameLiteral = m[2] ?? m[3];
      const handler     = m[4];
      if (!nameLiteral) continue;
      const id = slugify(nameLiteral);
      const source_ref = refFor(f, m.index);
      const description = docstringFor(functionBodies.get(handler)?.body);
      const declared = declaredToolsFor(functionBodies.get(handler)?.body);
      nodes.set(id, {
        id, name: nameLiteral, kind: 'agent',
        description, source_ref,
        metadata: { tools_declared: declared.length > 0 ? declared : undefined },
      });
      for (const t of declared) {
        toolBindings.push({
          node_id: id,
          tool_name: t,
          provider: inferProvider(t),
          source_ref,
        });
      }
    }

    // Nodes — dynamic (variable) form.
    for (const m of matchAll(text, RE_ADD_NODE_DYNAMIC)) {
      // Skip if this line matched the literal form already
      if (/["']/.test(text.slice(m.index, m.index + m[0].length + 12))) continue;
      warnings.push({
        severity: 'warn',
        code: 'TOOL_NAME_DYNAMIC',
        message: `Node name is a variable (${m[2]}); the graph cannot be statically resolved.`,
        source_ref: refFor(f, m.index),
      });
    }

    // Edges — sequential.
    for (const m of matchAll(text, RE_ADD_EDGE)) {
      const fromLit = m[2] ?? m[3];
      const toLit   = m[4] ?? m[5] ?? m[6];      // 6 = END|START keyword
      if (!fromLit || !toLit) continue;
      const from = slugify(fromLit);
      const isFinish = toLit === 'END';
      const isEntry  = fromLit === 'START';
      const to   = isFinish ? '__end__' : (isEntry ? slugify(toLit) : slugify(toLit));
      edges.push({
        from: isEntry ? '__start__' : from,
        to,
        kind: isEntry ? 'entry' : (isFinish ? 'finish' : 'sequential'),
        source_ref: refFor(f, m.index),
      });
      if (isEntry) entryPoints.add(to);
      if (isFinish) finishPoints.add(from);
    }

    // Edges — conditional.
    for (const m of matchAll(text, RE_ADD_COND_EDGES)) {
      const fromLit  = m[2] ?? m[3];
      const routerFn = m[4];
      const mapping  = m[5];
      if (!fromLit) continue;
      const from = slugify(fromLit);
      const ref  = refFor(f, m.index);
      if (mapping) {
        for (const em of matchAll(mapping, RE_ROUTING_ENTRY)) {
          const cond = em[1] ?? em[2];
          const dst  = em[3] ?? em[4];
          if (!dst) continue;
          edges.push({
            from, to: slugify(dst), kind: 'conditional',
            condition: `${routerFn}() == "${cond}"`,
            source_ref: ref,
          });
        }
      } else {
        // No explicit mapping — router returns node names dynamically.
        warnings.push({
          severity: 'info',
          code: 'AMBIGUOUS_ROUTING',
          message: `Conditional edges from ${fromLit} use router ${routerFn}() with no explicit mapping — targets resolved at runtime.`,
          source_ref: ref,
        });
      }
    }

    // Explicit entry / finish points.
    for (const m of matchAll(text, RE_SET_ENTRY)) {
      const lit = m[2] ?? m[3];
      if (lit) entryPoints.add(slugify(lit));
    }
    for (const m of matchAll(text, RE_SET_FINISH)) {
      const lit = m[2] ?? m[3];
      if (lit) finishPoints.add(slugify(lit));
    }
  }

  // Post-pass: sanity checks.
  if (entryPoints.size === 0) {
    warnings.push({
      severity: 'warn',
      code: 'NO_ENTRY_POINT',
      message: 'No entry point declared. The workflow will not run.',
    });
  }

  const nodeIds = new Set(nodes.keys());
  for (const e of edges) {
    // Skip synthetic __start__ / __end__ references.
    if (e.from !== '__start__' && !nodeIds.has(e.from)) {
      warnings.push({
        severity: 'warn',
        code: 'UNKNOWN_NODE_REFERENCE',
        message: `Edge references unknown node "${e.from}".`,
        source_ref: e.source_ref,
      });
    }
    if (e.to !== '__end__' && !nodeIds.has(e.to)) {
      warnings.push({
        severity: 'warn',
        code: 'UNKNOWN_NODE_REFERENCE',
        message: `Edge references unknown node "${e.to}".`,
        source_ref: e.source_ref,
      });
    }
  }

  return {
    framework: 'langgraph',
    framework_version: frameworkVersion,
    language: 'python',
    nodes: Array.from(nodes.values()),
    edges,
    tool_bindings: toolBindings,
    entry_points: Array.from(entryPoints),
    finish_points: Array.from(finishPoints),
    warnings,
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function* matchAll(text: string, re: RegExp): Generator<RegExpExecArray> {
  const clone = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = clone.exec(text)) !== null) yield m;
}

function refFor(f: FileEntry, offset: number): SourceRef {
  const before = f.text.slice(0, offset);
  const line   = before.split('\n').length;
  const col    = offset - before.lastIndexOf('\n');
  return { file: f.path, line, col };
}

function collectFunctionBodies(
  f: FileEntry,
  out: Map<string, { file: string; startLine: number; body: string }>,
): void {
  const text = f.text;
  const lines = text.split('\n');
  const defs: Array<{ name: string; startLineIdx: number; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)def\s+([A-Za-z_][\w]*)\s*\(/.exec(lines[i]);
    if (m) defs.push({ name: m[2], startLineIdx: i, indent: m[1].length });
  }
  for (const d of defs) {
    let end = lines.length;
    for (let i = d.startLineIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const indent = l.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= d.indent) { end = i; break; }
    }
    const body = lines.slice(d.startLineIdx, end).join('\n');
    // Last write wins — collisions across files are rare and the last
    // one in scan order is usually the more specific override.
    out.set(d.name, { file: f.path, startLine: d.startLineIdx + 1, body });
  }
}

function docstringFor(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const m = /^\s*def[^\n]+\n\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(body);
  const doc = (m?.[1] ?? m?.[2] ?? '').trim();
  if (!doc) return undefined;
  return doc.length > 200 ? doc.slice(0, 200) + '…' : doc;
}

/**
 * Best-effort tool-name extraction from a function body. Every match
 * is deduplicated. We prefer explicit patterns over speculation:
 *   x.invoke(...)   → captures x as a tool name
 *   x.run(...)      → captures x
 *   foo_tool(...)   → captures foo_tool
 */
function declaredToolsFor(body: string | undefined): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  for (const m of matchAll(body, RE_TOOL_INVOKE)) if (m[1]) seen.add(m[1]);
  for (const m of matchAll(body, RE_TOOL_RUN))    if (m[1]) seen.add(m[1]);
  for (const m of matchAll(body, RE_TOOL_CALL))   if (m[1]) seen.add(`${m[1]}_tool`);
  return Array.from(seen);
}
