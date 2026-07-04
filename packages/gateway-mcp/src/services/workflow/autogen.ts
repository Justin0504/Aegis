/**
 * AutoGen (Microsoft) workflow parser — covers both AutoGen v0.2 and
 * the AutoGen-AgentChat 0.4+ rewrite. Both share the same agent-first
 * mental model:
 *
 *   AssistantAgent("name", llm_config=..., system_message=..., tools=[...])
 *   UserProxyAgent("name", code_execution_config=..., human_input_mode=...)
 *   GroupChat(agents=[a1, a2, a3], messages=[], max_round=10)
 *   RoundRobinGroupChat(participants=[a1, a2])   # 0.4+
 *   Swarm(participants=[a1, a2], termination_condition=...)
 *
 * Edges in AutoGen aren't declared statically — they're emergent from
 * whichever agent the manager selects next. We treat the group-chat
 * pattern as a fully-connected subgraph among participants + a
 * synthesised `manager` node for GroupChat / RoundRobin.
 *
 * Tool bindings — v0.2 uses `register_function` + a functions map;
 * v0.4 passes `tools=[...]` directly on AssistantAgent.
 */

import type {
  ParsedWorkflow, WorkflowNode, WorkflowEdge, ToolBinding,
  WorkflowWarning, SourceRef,
} from './types';
import { slugify, inferProvider } from './types';

interface FileEntry { path: string; text: string; }

// Variable-assigned agent constructors we recognise.
const AGENT_CTORS = [
  { name: 'AssistantAgent',    kind: 'agent' as const },
  { name: 'UserProxyAgent',    kind: 'human' as const },
  { name: 'ConversableAgent',  kind: 'agent' as const },
  { name: 'CompressibleAgent', kind: 'agent' as const },
];

// Chat-orchestrator constructors that define participant sets.
const GROUP_CTORS = ['GroupChat', 'RoundRobinGroupChat', 'SelectorGroupChat', 'Swarm'];

// kwargs
const RE_KW_NAME_POS  = /^\s*(?:"([^"]*)"|'([^']*)')/;   // first positional
const RE_KW_NAME_KW   = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const RE_KW_SYSMSG    = /\bsystem_message\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/;
const RE_KW_LLM       = /\bllm_config\s*=\s*(?:\{([\s\S]*?)\}|[A-Za-z_][\w]*)/;
const RE_KW_MODEL     = /["']model["']\s*:\s*(?:"([^"]*)"|'([^']*)')/;
const RE_KW_TOOLS     = /\btools\s*=\s*\[([\s\S]*?)\]/;
const RE_KW_PARTS     = /\b(participants|agents)\s*=\s*\[([\s\S]*?)\]/;
const RE_KW_HUMAN     = /\bhuman_input_mode\s*=\s*(?:"([^"]*)"|'([^']*)')/;

const RE_VERSION_HINT = /(?:autogen|autogen[-_]agentchat)\s*(?:==|>=|<=|~=)\s*([\d.]+)/i;

// `agent_a.register_function(function_map={"name": fn})` — v0.2 pattern.
const RE_REGISTER_FN  = /(\w+)\.register_function\s*\(\s*function_map\s*=\s*\{([\s\S]*?)\}\s*\)/g;
const RE_FN_MAP_ENTRY = /(?:"([^"]*)"|'([^']*)')\s*:\s*(\w+)/g;

// Identifier extractor for participant / tools lists.
const RE_ID_ITEM      = /([A-Za-z_][\w]*)/g;

interface AgentRecord {
  var: string;
  name: string;
  kind: 'agent' | 'human';
  llm_model?: string;
  system_message?: string;
  tools: string[];
  source_ref: SourceRef;
}

export function parseAutoGen(files: FileEntry[]): ParsedWorkflow {
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
    for (const ctor of AGENT_CTORS) {
      const re = new RegExp(String.raw`^\s*([A-Za-z_][\w]*)\s*=\s*${ctor.name}\s*\(`, 'gm');
      for (const m of matchAll(f.text, re)) {
        const varName = m[1];
        const args    = balancedArgs(f.text, m.index + m[0].length - 1);
        const nameKw  = extractString(args, RE_KW_NAME_KW);
        const namePos = extractString(args, RE_KW_NAME_POS);
        const name    = nameKw ?? namePos ?? varName;
        const sysmsg  = extractString(args, RE_KW_SYSMSG);
        const model   = extractString(args, RE_KW_MODEL);
        const tools   = extractIdentifiers(args.match(RE_KW_TOOLS)?.[1]);
        const humanMode = extractString(args, RE_KW_HUMAN);
        agents.set(varName, {
          var: varName, name,
          kind: humanMode && humanMode !== 'NEVER' ? 'human' : ctor.kind,
          llm_model: model,
          system_message: sysmsg ? (sysmsg.length > 200 ? sysmsg.slice(0, 200) + '…' : sysmsg) : undefined,
          tools,
          source_ref: refFor(f, m.index),
        });
      }
    }

    // 2. Group-chat constructors → participant edges.
    // Word-boundary anchor `\b` on the ctor name prevents `GroupChat`
    // from matching inside `RoundRobinGroupChat` (double-counting).
    for (const groupCtor of GROUP_CTORS) {
      const re = new RegExp(String.raw`(?:([A-Za-z_][\w]*)\s*=\s*)?\b${groupCtor}\s*\(`, 'g');
      for (const m of matchAll(f.text, re)) {
        const args = balancedArgs(f.text, m.index + m[0].length - 1);
        const partList = args.match(RE_KW_PARTS)?.[2];
        const parts = extractIdentifiers(partList);
        const ref   = refFor(f, m.index);
        if (parts.length === 0) continue;

        if (groupCtor === 'RoundRobinGroupChat') {
          // Deterministic ring: 0→1→2→…→0
          for (let i = 0; i < parts.length; i++) {
            const a = agents.get(parts[i]);
            const b = agents.get(parts[(i + 1) % parts.length]);
            if (!a || !b) continue;
            edges.push({
              from: slugify(a.name), to: slugify(b.name),
              kind: 'sequential',
              condition: `round-robin (position ${i + 1}/${parts.length})`,
              source_ref: ref,
            });
          }
          const first = agents.get(parts[0]);
          if (first) entryPoints.add(slugify(first.name));
        } else if (groupCtor === 'Swarm') {
          // Handoff pattern — participants can transfer to any other.
          // Emit N*(N-1) edges tagged as conditional handoffs.
          for (const from of parts) {
            for (const to of parts) {
              if (from === to) continue;
              const a = agents.get(from);
              const b = agents.get(to);
              if (!a || !b) continue;
              edges.push({
                from: slugify(a.name), to: slugify(b.name),
                kind: 'conditional',
                condition: 'swarm handoff',
                source_ref: ref,
              });
            }
          }
          if (parts[0] && agents.has(parts[0])) {
            entryPoints.add(slugify(agents.get(parts[0])!.name));
          }
        } else {
          // GroupChat / SelectorGroupChat — the manager picks the next
          // speaker via LLM at runtime. Emit warning + fully-connected
          // conditional edges so downstream policy can still reason.
          warnings.push({
            severity: 'info',
            code: 'AMBIGUOUS_ROUTING',
            message: `${groupCtor} routing is LLM-selected; emitted as fully-connected conditional edges.`,
            source_ref: ref,
          });
          for (const from of parts) {
            for (const to of parts) {
              if (from === to) continue;
              const a = agents.get(from);
              const b = agents.get(to);
              if (!a || !b) continue;
              edges.push({
                from: slugify(a.name), to: slugify(b.name),
                kind: 'conditional',
                condition: `${groupCtor} manager selects speaker`,
                source_ref: ref,
              });
            }
          }
          if (parts[0] && agents.has(parts[0])) {
            entryPoints.add(slugify(agents.get(parts[0])!.name));
          }
        }
      }
    }

    // 3. v0.2 `.register_function(function_map=...)` — attaches tools.
    for (const m of matchAll(f.text, RE_REGISTER_FN)) {
      const agentVar = m[1];
      const mapBody  = m[2];
      const agent    = agents.get(agentVar);
      if (!agent) continue;
      for (const em of matchAll(mapBody, RE_FN_MAP_ENTRY)) {
        const toolName = em[1] ?? em[2];
        if (!toolName) continue;
        if (!agent.tools.includes(toolName)) agent.tools.push(toolName);
      }
    }
  }

  // Materialise nodes.
  const nodes: WorkflowNode[] = [];
  for (const a of agents.values()) {
    nodes.push({
      id: slugify(a.name), name: a.name, kind: a.kind,
      description: a.system_message,
      source_ref: a.source_ref,
      metadata: {
        llm_model: a.llm_model,
        system_prompt: a.system_message,
        tools_declared: a.tools.length > 0 ? a.tools : undefined,
      },
    });
  }

  // Tool bindings.
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
      message: 'Agents defined but no GroupChat / RoundRobin / Swarm to orchestrate them.',
    });
  }

  return {
    framework: 'autogen',
    framework_version: frameworkVersion,
    language: 'python',
    nodes, edges, tool_bindings: toolBindings,
    entry_points: Array.from(entryPoints),
    finish_points: Array.from(finishPoints),
    warnings,
  };
}

// ── helpers (duplicated intentionally — parsers are meant to be
// independently forkable) ────────────────────────────────────────────

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
  return m?.[1] ?? m?.[2];
}

function extractIdentifiers(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matchAll(raw, RE_ID_ITEM)) {
    if (m[1] && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function balancedArgs(text: string, openIdx: number): string {
  if (text[openIdx] !== '(') return '';
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      // Correct escape counting: a run of N backslashes is
      // "escaped" iff N is odd. `\\"` (two backslashes + quote) is
      // an escaped backslash followed by an unescaped quote — the
      // quote DOES close the string. The naive `text[i-1] !== '\\'`
      // check treated it as escaped and read past the closer.
      if (c === inStr) {
        let bs = 0;
        for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) inStr = null;
      }
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return text.slice(openIdx + 1);
}
