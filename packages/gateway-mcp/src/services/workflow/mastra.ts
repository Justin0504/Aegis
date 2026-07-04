/**
 * Mastra (TypeScript) workflow parser.
 *
 * Mastra's declarative API:
 *   const research = new Agent({
 *     name: 'research',
 *     instructions: '...',
 *     model: openai('gpt-4o-mini'),
 *     tools: { webSearch, pdfExtract },
 *   })
 *
 *   const workflow = createWorkflow({
 *     id: 'trip-planner',
 *     inputSchema, outputSchema,
 *   })
 *     .step(research)
 *     .step(planner)
 *     .then(critic)
 *     .commit()
 *
 * We handle:
 *   • `new Agent({ ... })`  — nodes
 *   • `createWorkflow({...}).step(x).then(y).parallel([a, b]).commit()`
 *     — chain of edges
 *   • `.branch(cond, [ifTrue, ifFalse])` — conditional split
 *
 * Because Mastra chains are frequently multi-line and heavily
 * formatted, we tokenise on `.step(` / `.then(` / `.parallel(` /
 * `.branch(` rather than trying to consume the whole builder in one
 * regex.
 */

import type {
  ParsedWorkflow, WorkflowNode, WorkflowEdge, ToolBinding,
  WorkflowWarning, SourceRef,
} from './types';
import { slugify, inferProvider } from './types';

interface FileEntry { path: string; text: string; }

// Agent constructor:  const x = new Agent({ ... })
const RE_AGENT_NEW    = /^\s*(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*new\s+Agent\s*\(\s*\{/gm;
// Workflow entry:     createWorkflow({ id: '...' })
const RE_WORKFLOW     = /createWorkflow\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
// Step invocations within a builder chain.
const RE_STEP         = /\.\s*step\s*\(\s*([A-Za-z_][\w]*)\s*\)/g;
const RE_THEN         = /\.\s*then\s*\(\s*([A-Za-z_][\w]*)\s*\)/g;
const RE_PARALLEL     = /\.\s*parallel\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
const RE_BRANCH       = /\.\s*branch\s*\(\s*([\s\S]*?)\s*,\s*\[([\s\S]*?)\]\s*\)/g;

// Object-literal kwargs inside an Agent({}) body.
const RE_KW_NAME_LIT  = /\bname\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;
const RE_KW_INSTR     = /\binstructions\s*:\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|`([\s\S]*?)`)/;
const RE_KW_MODEL     = /\bmodel\s*:\s*(?:(?:openai|anthropic|google)\s*\(\s*['"]([^'"]+)['"])/;
const RE_KW_TOOLS     = /\btools\s*:\s*\{([\s\S]*?)\}/;
const RE_TOOLS_ITEM   = /([A-Za-z_][\w]*)\s*(?:,|\}|$|:)/g;

// Workflow id
const RE_WF_ID        = /\bid\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

const RE_VERSION_HINT = /"@mastra\/(?:core|[\w-]+)"\s*:\s*"[\^~]?([\d.]+)/;

interface AgentRecord {
  var: string;
  name: string;
  instructions?: string;
  llm_model?: string;
  tools: string[];
  source_ref: SourceRef;
}

export function parseMastra(files: FileEntry[]): ParsedWorkflow {
  const agents: Map<string, AgentRecord> = new Map();
  const edges: WorkflowEdge[] = [];
  const warnings: WorkflowWarning[] = [];
  const entryPoints  = new Set<string>();
  const finishPoints = new Set<string>();
  let frameworkVersion: string | undefined;

  for (const f of files) {
    if (!frameworkVersion) {
      const m = RE_VERSION_HINT.exec(f.text);
      if (m) frameworkVersion = m[1];
    }

    // 1. Agents.
    for (const m of matchAll(f.text, RE_AGENT_NEW)) {
      const varName = m[1];
      const body = balancedBraces(f.text, m.index + m[0].length - 1);
      const nameLit = extractString(body, RE_KW_NAME_LIT) ?? varName;
      const instructions = extractString(body, RE_KW_INSTR);
      const model = body.match(RE_KW_MODEL)?.[1];
      const tools = extractIdentifiers(body.match(RE_KW_TOOLS)?.[1]);
      agents.set(varName, {
        var: varName, name: nameLit,
        instructions: instructions
          ? (instructions.length > 200 ? instructions.slice(0, 200) + '…' : instructions)
          : undefined,
        llm_model: model, tools,
        source_ref: refFor(f, m.index),
      });
    }

    // 2. Workflows.
    for (const m of matchAll(f.text, RE_WORKFLOW)) {
      const wfBody = m[1];
      const wfId   = extractString(wfBody, RE_WF_ID);

      // The chain begins right after `createWorkflow({...})` and goes
      // until the balancing `.commit()` (or end of statement). We
      // find the tail after the RE_WORKFLOW match end.
      const tailStart = m.index + m[0].length;
      const tail = extractChainTail(f.text, tailStart);

      const chain = walkChain(tail);
      let previous: string[] = [];             // fan-in support
      let stepIdx = 0;
      const ref = refFor(f, m.index);

      for (const call of chain) {
        if (call.kind === 'step' || call.kind === 'then') {
          const agentVar = call.args[0];
          const agent    = agents.get(agentVar);
          if (!agent) {
            warnings.push({
              severity: 'warn',
              code: 'UNKNOWN_NODE_REFERENCE',
              message: `Workflow "${wfId ?? '?'}" step references unknown agent variable "${agentVar}".`,
              source_ref: ref,
            });
            continue;
          }
          const currentId = slugify(agent.name);
          if (previous.length === 0) {
            entryPoints.add(currentId);
          } else {
            for (const prev of previous) {
              edges.push({
                from: prev, to: currentId,
                kind: 'sequential',
                condition: `step ${stepIdx + 1} (${call.kind})`,
                source_ref: ref,
              });
            }
          }
          previous = [currentId];
          stepIdx++;
        } else if (call.kind === 'parallel') {
          const targets = call.args
            .map(v => agents.get(v))
            .filter(Boolean)
            .map(a => slugify(a!.name));
          for (const t of targets) {
            if (previous.length === 0) {
              entryPoints.add(t);
            } else {
              for (const prev of previous) {
                edges.push({
                  from: prev, to: t,
                  kind: 'parallel',
                  condition: `parallel fan-out (step ${stepIdx + 1})`,
                  source_ref: ref,
                });
              }
            }
          }
          previous = targets;
          stepIdx++;
        } else if (call.kind === 'branch') {
          const [cond, ...targets] = call.args;
          const resolved = targets.map(v => agents.get(v)).filter(Boolean).map(a => slugify(a!.name));
          for (const t of resolved) {
            for (const prev of previous) {
              edges.push({
                from: prev, to: t,
                kind: 'conditional',
                condition: `branch(${cond ?? '?'})`,
                source_ref: ref,
              });
            }
          }
          previous = resolved;
          stepIdx++;
        }
      }

      for (const finish of previous) finishPoints.add(finish);
    }
  }

  const nodes: WorkflowNode[] = Array.from(agents.values()).map(a => ({
    id: slugify(a.name), name: a.name, kind: 'agent',
    description: a.instructions,
    source_ref: a.source_ref,
    metadata: {
      llm_model: a.llm_model,
      system_prompt: a.instructions,
      tools_declared: a.tools.length > 0 ? a.tools : undefined,
    },
  }));

  const toolBindings: ToolBinding[] = [];
  for (const a of agents.values()) {
    const id = slugify(a.name);
    for (const t of a.tools) {
      toolBindings.push({
        node_id: id, tool_name: t,
        provider: inferProvider(t),
        source_ref: a.source_ref,
      });
    }
  }

  if (nodes.length > 0 && entryPoints.size === 0) {
    warnings.push({
      severity: 'warn',
      code: 'NO_ENTRY_POINT',
      message: 'Agents defined but no createWorkflow(...) chain to orchestrate them.',
    });
  }

  return {
    framework: 'mastra',
    framework_version: frameworkVersion,
    language: 'typescript',
    nodes, edges, tool_bindings: toolBindings,
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

function extractString(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function extractIdentifiers(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matchAll(raw, RE_TOOLS_ITEM)) {
    if (m[1] && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function balancedBraces(text: string, openIdx: number): string {
  if (text[openIdx] !== '{') return '';
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === inStr && text[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return text.slice(openIdx + 1);
}

/** Extract everything from `start` up to the terminating `.commit()`
 *  or the end of the statement (`;` at brace-depth 0). */
function extractChainTail(text: string, start: number): string {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === inStr && text[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (depth < 0) return text.slice(start, i);
    if (depth === 0 && c === ';') return text.slice(start, i);
    if (depth === 0 && text.slice(i, i + 9) === '.commit()') return text.slice(start, i + 9);
  }
  return text.slice(start);
}

type ChainCall =
  | { kind: 'step' | 'then'; args: [string] }
  | { kind: 'parallel'; args: string[] }
  | { kind: 'branch'; args: string[] };

/** Tokenise a Mastra chain into an ordered list of step/then/parallel/
 *  branch calls. Order matters. */
function walkChain(tail: string): ChainCall[] {
  const calls: Array<{ kind: ChainCall['kind']; offset: number; args: string[] }> = [];

  for (const m of matchAll(tail, RE_STEP)) {
    calls.push({ kind: 'step', offset: m.index, args: [m[1]] });
  }
  for (const m of matchAll(tail, RE_THEN)) {
    calls.push({ kind: 'then', offset: m.index, args: [m[1]] });
  }
  for (const m of matchAll(tail, RE_PARALLEL)) {
    calls.push({ kind: 'parallel', offset: m.index, args: extractIdentifiers(m[1]) });
  }
  for (const m of matchAll(tail, RE_BRANCH)) {
    const cond = m[1].trim();
    const targets = extractIdentifiers(m[2]);
    calls.push({ kind: 'branch', offset: m.index, args: [cond, ...targets] });
  }

  calls.sort((a, b) => a.offset - b.offset);
  return calls as ChainCall[];
}
