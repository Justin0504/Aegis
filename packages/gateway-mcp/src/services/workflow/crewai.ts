/**
 * CrewAI workflow parser.
 *
 * CrewAI's model:
 *   • `Agent(role=..., goal=..., backstory=..., tools=[t1, t2], llm=...)`
 *     Creates an agent with a bounded tool list.
 *   • `Task(description=..., agent=agent_var, tools=[...])`
 *     One unit of work assigned to a specific agent.
 *   • `Crew(agents=[a1, a2], tasks=[t1, t2], process=Process.sequential|hierarchical)`
 *     Glues agents + tasks into an executable workflow.
 *
 * Extraction strategy:
 *   1. Sweep for every `Agent(...)` — record the variable name (from
 *      the left of `=`) and its `role`, `tools`, `llm` kwargs.
 *   2. Sweep for every `Task(...)` — record its assigned agent + tools.
 *   3. Sweep for `Crew(...)` — its `process=` kwarg decides whether
 *      the tasks flow sequentially or hierarchically.
 *
 * Each Agent becomes a workflow node. Tasks become edges (task ordering
 * within a Crew defines the sequence).
 */

import type {
  ParsedWorkflow, WorkflowNode, WorkflowEdge, ToolBinding,
  WorkflowWarning, SourceRef,
} from './types';
import { slugify, inferProvider } from './types';

interface FileEntry { path: string; text: string; }

// Match `<var_name> = Agent(...)` — captures the LHS name and the
// full argument list up to the balancing paren.
const RE_AGENT_ASSIGN = /^\s*([A-Za-z_][\w]*)\s*=\s*Agent\s*\(/gm;
// Match `<var_name> = Task(...)` — same shape.
const RE_TASK_ASSIGN  = /^\s*([A-Za-z_][\w]*)\s*=\s*Task\s*\(/gm;
// Match `<var_name> = Crew(...)` OR a bare `Crew(...)` call. We handle both.
const RE_CREW_ASSIGN  = /^\s*(?:([A-Za-z_][\w]*)\s*=\s*)?Crew\s*\(/gm;

// kwarg extractors — used against the parenthesised argument slice.
const RE_KW_ROLE      = /\brole\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const RE_KW_GOAL      = /\bgoal\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const RE_KW_LLM       = /\bllm\s*=\s*([A-Za-z_][\w.]*)/;
const RE_KW_AGENT     = /\bagent\s*=\s*([A-Za-z_][\w]*)/;
const RE_KW_TOOLS     = /\btools\s*=\s*\[([^\]]*)\]/;
const RE_KW_DESC      = /\bdescription\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const RE_KW_PROCESS   = /\bprocess\s*=\s*(?:Process\.)?([A-Za-z_]+)/;
const RE_CREW_AGENTS  = /\bagents\s*=\s*\[([^\]]*)\]/;
const RE_CREW_TASKS   = /\btasks\s*=\s*\[([^\]]*)\]/;

// A tools list contains identifiers, sometimes function-call forms:
//   [search_tool, calculator_tool, SerperDevTool()]
const RE_TOOL_ITEM    = /([A-Za-z_][\w]*)\s*(?:\(\s*\))?/g;

const RE_VERSION_HINT = /crewai\s*(?:==|>=|<=|~=)\s*([\d.]+)/;

// ── Parser ────────────────────────────────────────────────────────────

interface AgentRecord {
  var: string;
  role?: string;
  goal?: string;
  llm?: string;
  tools: string[];
  source_ref: SourceRef;
}

interface TaskRecord {
  var: string;
  description?: string;
  agent_var?: string;
  tools: string[];
  source_ref: SourceRef;
  order: number;              // insertion order within the file
}

export function parseCrewAI(files: FileEntry[]): ParsedWorkflow {
  const agents: Map<string, AgentRecord> = new Map();
  const tasks:  Map<string, TaskRecord>  = new Map();
  const edges: WorkflowEdge[] = [];
  const warnings: WorkflowWarning[] = [];
  const entryPoints  = new Set<string>();
  const finishPoints = new Set<string>();
  let frameworkVersion: string | undefined;
  let taskOrder = 0;

  for (const f of files) {
    if (!frameworkVersion) {
      const m = RE_VERSION_HINT.exec(f.text);
      if (m) frameworkVersion = m[1];
    }

    // Agents
    for (const m of matchAll(f.text, RE_AGENT_ASSIGN)) {
      const varName = m[1];
      const argsStr = balancedArgs(f.text, m.index + m[0].length - 1);
      const role  = extractString(argsStr, RE_KW_ROLE);
      const goal  = extractString(argsStr, RE_KW_GOAL);
      const llm   = argsStr.match(RE_KW_LLM)?.[1];
      const tools = extractTools(argsStr.match(RE_KW_TOOLS)?.[1]);
      agents.set(varName, {
        var: varName, role, goal, llm, tools,
        source_ref: refFor(f, m.index),
      });
    }

    // Tasks
    for (const m of matchAll(f.text, RE_TASK_ASSIGN)) {
      const varName = m[1];
      const argsStr = balancedArgs(f.text, m.index + m[0].length - 1);
      const description = extractString(argsStr, RE_KW_DESC);
      const agentVar    = argsStr.match(RE_KW_AGENT)?.[1];
      const tools       = extractTools(argsStr.match(RE_KW_TOOLS)?.[1]);
      tasks.set(varName, {
        var: varName, description, agent_var: agentVar, tools,
        source_ref: refFor(f, m.index),
        order: taskOrder++,
      });
    }

    // Crews — wire agents and tasks together.
    for (const m of matchAll(f.text, RE_CREW_ASSIGN)) {
      const argsStr = balancedArgs(f.text, m.index + m[0].length - 1);
      const process = argsStr.match(RE_KW_PROCESS)?.[1] ?? 'sequential';
      const taskListMatch  = argsStr.match(RE_CREW_TASKS);
      const agentListMatch = argsStr.match(RE_CREW_AGENTS);
      const ref = refFor(f, m.index);

      const taskNames  = extractTools(taskListMatch?.[1]);
      const agentNames = extractTools(agentListMatch?.[1]);

      // Entry: the first task's agent is the entry point.
      const firstTask = taskNames.map(n => tasks.get(n)).filter(Boolean)[0] as TaskRecord | undefined;
      if (firstTask?.agent_var && agents.has(firstTask.agent_var)) {
        entryPoints.add(slugify(agents.get(firstTask.agent_var)!.role ?? firstTask.agent_var));
      }

      // Sequential process: tasks fire in list order, agent-to-agent edges.
      if (process.toLowerCase().startsWith('seq')) {
        for (let i = 0; i < taskNames.length - 1; i++) {
          const a = tasks.get(taskNames[i]);
          const b = tasks.get(taskNames[i + 1]);
          if (!a?.agent_var || !b?.agent_var) continue;
          const agentA = agents.get(a.agent_var);
          const agentB = agents.get(b.agent_var);
          if (!agentA || !agentB) continue;
          edges.push({
            from: slugify(agentA.role ?? agentA.var),
            to:   slugify(agentB.role ?? agentB.var),
            kind: 'sequential',
            condition: a.description ? `after: ${truncate(a.description)}` : undefined,
            source_ref: ref,
          });
        }
        // Last task's agent is a finish point.
        const lastTask = tasks.get(taskNames[taskNames.length - 1]);
        if (lastTask?.agent_var) {
          const agent = agents.get(lastTask.agent_var);
          if (agent) finishPoints.add(slugify(agent.role ?? agent.var));
        }
      } else if (process.toLowerCase().startsWith('hier')) {
        // Hierarchical: manager delegates. Emit fan-out edges from the
        // first agent to every other agent in the list.
        const [manager, ...workers] = agentNames.map(n => agents.get(n)).filter(Boolean) as AgentRecord[];
        if (manager) {
          const managerId = slugify(manager.role ?? manager.var);
          entryPoints.add(managerId);
          for (const w of workers) {
            edges.push({
              from: managerId,
              to:   slugify(w.role ?? w.var),
              kind: 'parallel',
              condition: `delegated by ${manager.role ?? manager.var}`,
              source_ref: ref,
            });
          }
        }
      } else {
        warnings.push({
          severity: 'info',
          code: 'AMBIGUOUS_ROUTING',
          message: `Crew process="${process}" is not recognised; edges inferred from task order.`,
          source_ref: ref,
        });
      }
    }
  }

  // Materialise nodes from agents.
  const nodes: WorkflowNode[] = [];
  for (const a of agents.values()) {
    const id = slugify(a.role ?? a.var);
    nodes.push({
      id, name: a.role ?? a.var, kind: 'agent',
      description: a.goal, source_ref: a.source_ref,
      metadata: {
        llm_model: a.llm,
        role: a.role,
        tools_declared: a.tools.length > 0 ? a.tools : undefined,
      },
    });
  }

  // Tool bindings — one per (agent × tool). Task-level tool overrides
  // are merged in.
  const toolBindings: ToolBinding[] = [];
  for (const a of agents.values()) {
    const id = slugify(a.role ?? a.var);
    for (const t of a.tools) {
      toolBindings.push({
        node_id: id, tool_name: t,
        provider: inferProvider(t),
        source_ref: a.source_ref,
      });
    }
  }
  for (const t of tasks.values()) {
    if (!t.agent_var || !agents.has(t.agent_var)) continue;
    const agent = agents.get(t.agent_var)!;
    const id = slugify(agent.role ?? agent.var);
    for (const tool of t.tools) {
      toolBindings.push({
        node_id: id, tool_name: tool,
        provider: inferProvider(tool),
        source_ref: t.source_ref,
      });
    }
  }

  if (nodes.length > 0 && entryPoints.size === 0) {
    warnings.push({
      severity: 'warn',
      code: 'NO_ENTRY_POINT',
      message: 'No Crew(...) found — agents defined but no orchestration.',
    });
  }

  return {
    framework: 'crewai',
    framework_version: frameworkVersion,
    language: 'python',
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
  return m?.[1] ?? m?.[2];
}

function extractTools(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const m of matchAll(raw, RE_TOOL_ITEM)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Return the balanced-paren substring starting at `openIdx` (points at "(").
 *  Skips content inside quoted strings so a `)` inside a description
 *  literal doesn't close the outer call, and handles Python's `\\"`
 *  (odd-run-of-backslashes = escaped quote). */
function balancedArgs(text: string, openIdx: number): string {
  if (text[openIdx] !== '(') return '';
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
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
