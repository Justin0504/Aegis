/**
 * WorkflowExtractorService — the orchestrator that glues the four
 * framework parsers into one entry point.
 *
 * Contract:
 *   extract({ files, root_path? }) → WorkflowGraph
 *
 * Steps:
 *   1. Detect framework per file. Group files by framework.
 *      (A monorepo can contain a LangGraph agent AND a Mastra one —
 *      we return the highest-confidence one and warn on the other.)
 *   2. Dispatch to the framework-specific parser.
 *   3. Stitch the ParsedWorkflow into a full WorkflowGraph with
 *      `extracted_at`, `source`, and de-dup passes.
 *
 * Files are provided in-memory rather than by path — the gateway
 * runs in a container without repo access, and the SDK / cockpit
 * uploads code via the API. Total upload cap is enforced at the
 * route layer.
 */

import type {
  WorkflowGraph, Framework, ParsedWorkflow, WorkflowWarning,
} from './types';
import { detectFramework } from './detect';
import { parseLangGraphPython } from './langgraph-python';
import { parseCrewAI }          from './crewai';
import { parseAutoGen }         from './autogen';
import { parseMastra }          from './mastra';

export interface WorkflowFile {
  path: string;                  // repo-relative
  text: string;                  // raw source
}

export interface ExtractOpts {
  files: WorkflowFile[];
  root_path?: string;            // display-only, e.g. "acme-pay-agent/"
  agent_id?: string;             // optional binding to a registered agent
}

export class WorkflowExtractorService {
  extract(opts: ExtractOpts): WorkflowGraph {
    const { files, root_path = '/', agent_id } = opts;
    const now = new Date().toISOString();

    if (files.length === 0) {
      return this.emptyGraph({ agent_id, root_path, now, warnings: [{
        severity: 'warn',
        code: 'FRAMEWORK_DETECT_LOW_CONFIDENCE',
        message: 'No source files provided.',
      }]});
    }

    // 1. Per-file detection. Group by framework.
    const groups = new Map<Framework, WorkflowFile[]>();
    const confidenceByFramework = new Map<Framework, number>();
    const languagesSeen = new Set<string>();

    for (const f of files) {
      const det = detectFramework(f.path, f.text);
      if (det.framework === 'unknown') continue;
      languagesSeen.add(det.language);
      const list = groups.get(det.framework) ?? [];
      list.push(f);
      groups.set(det.framework, list);
      const prev = confidenceByFramework.get(det.framework) ?? 0;
      confidenceByFramework.set(det.framework, Math.max(prev, det.confidence));
    }

    const preExtractWarnings: WorkflowWarning[] = [];

    if (groups.size === 0) {
      return this.emptyGraph({
        agent_id, root_path, now,
        warnings: [{
          severity: 'warn',
          code: 'FRAMEWORK_DETECT_LOW_CONFIDENCE',
          message: `No supported framework detected in ${files.length} file(s). Supported: langgraph, crewai, autogen, mastra.`,
        }],
      });
    }

    if (groups.size > 1) {
      const list = Array.from(groups.keys()).join(', ');
      preExtractWarnings.push({
        severity: 'info',
        code: 'MULTI_FRAMEWORK_DETECTED',
        message: `Multiple frameworks detected (${list}). Parsing the highest-confidence one and emitting its graph.`,
      });
    }

    // Highest-confidence framework wins.
    const [winner] = Array.from(groups.keys()).sort(
      (a, b) => (confidenceByFramework.get(b) ?? 0) - (confidenceByFramework.get(a) ?? 0),
    );
    const winnerFiles = groups.get(winner)!;

    // 2. Dispatch.
    let parsed: ParsedWorkflow;
    switch (winner) {
      case 'langgraph':
        parsed = parseLangGraphPython(winnerFiles);
        break;
      case 'crewai':
        parsed = parseCrewAI(winnerFiles);
        break;
      case 'autogen':
        parsed = parseAutoGen(winnerFiles);
        break;
      case 'mastra':
        parsed = parseMastra(winnerFiles);
        break;
      default:
        return this.emptyGraph({
          agent_id, root_path, now,
          warnings: [{
            severity: 'warn',
            code: 'FRAMEWORK_DETECT_LOW_CONFIDENCE',
            message: `Unsupported framework: ${winner}.`,
          }],
        });
    }

    // 3. Post-processing: unreachable node + cycle detection.
    const postWarnings = this.postProcess(parsed);

    // Version fallback — some pins live in requirements.txt /
    // package.json / pyproject.toml, files the parser never saw
    // because detectFramework() skipped them. Scan every file for the
    // corresponding pin marker before giving up.
    const version = parsed.framework_version ?? this.scanVersionAcrossAllFiles(winner, files);

    return {
      agent_id,
      framework: parsed.framework,
      framework_version: version,
      extracted_at: now,
      source: {
        root_path,
        files_scanned: winnerFiles.length,
        language: parsed.language,
      },
      nodes:          parsed.nodes,
      edges:          parsed.edges,
      tool_bindings:  parsed.tool_bindings,
      entry_points:   parsed.entry_points,
      finish_points:  parsed.finish_points,
      warnings: [...preExtractWarnings, ...parsed.warnings, ...postWarnings],
    };
  }

  // ── post-processing ────────────────────────────────────────────────

  private postProcess(w: ParsedWorkflow): WorkflowWarning[] {
    const warns: WorkflowWarning[] = [];
    if (w.nodes.length === 0) return warns;

    const nodeIds = new Set(w.nodes.map(n => n.id));

    // Adjacency: only edges between real nodes are counted for the
    // reachability sweep (synthetic __start__/__end__ excluded).
    const adj = new Map<string, Set<string>>();
    for (const n of nodeIds) adj.set(n, new Set());
    for (const e of w.edges) {
      if (nodeIds.has(e.from) && nodeIds.has(e.to)) adj.get(e.from)!.add(e.to);
    }

    // Reachability from any entry point.
    const reachable = new Set<string>();
    const stack: string[] = [...w.entry_points].filter(id => nodeIds.has(id));
    while (stack.length) {
      const n = stack.pop()!;
      if (reachable.has(n)) continue;
      reachable.add(n);
      for (const dst of adj.get(n) ?? []) stack.push(dst);
    }
    for (const id of nodeIds) {
      if (!reachable.has(id) && w.entry_points.length > 0) {
        warns.push({
          severity: 'warn',
          code: 'UNREACHABLE_NODE',
          message: `Node "${id}" is not reachable from any declared entry point.`,
          source_ref: w.nodes.find(n => n.id === id)?.source_ref,
        });
      }
    }

    // Cycle detection (DFS grey/black).
    const colour = new Map<string, 0 | 1 | 2>();     // 0=white 1=grey 2=black
    for (const id of nodeIds) colour.set(id, 0);
    let cycleReported = false;
    const dfs = (u: string, path: string[]): boolean => {
      colour.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        if (colour.get(v) === 1) {
          if (!cycleReported) {
            warns.push({
              severity: 'info',
              code: 'CYCLE_DETECTED',
              message: `Cycle detected: ${[...path, u, v].join(' → ')}. Legal in LangGraph / CrewAI but requires termination logic.`,
            });
            cycleReported = true;
          }
          return true;
        }
        if (colour.get(v) === 0) {
          if (dfs(v, [...path, u])) return true;
        }
      }
      colour.set(u, 2);
      return false;
    };
    for (const id of nodeIds) {
      if (colour.get(id) === 0) dfs(id, []);
      if (cycleReported) break;
    }

    return warns;
  }

  /** Look for a framework version pin across ALL uploaded files,
   *  not just those the parser scanned. Handles requirements.txt,
   *  pyproject.toml, package.json, etc. */
  private scanVersionAcrossAllFiles(fw: Framework, files: WorkflowFile[]): string | undefined {
    const patterns: Record<Framework, RegExp[]> = {
      langgraph: [
        /\blanggraph\s*(?:==|>=|<=|~=)\s*([\d.]+)/i,
        /"@langchain\/langgraph"\s*:\s*"[\^~]?([\d.]+)/,
      ],
      crewai: [
        /\bcrewai\s*(?:==|>=|<=|~=)\s*([\d.]+)/i,
      ],
      autogen: [
        /\b(?:autogen|autogen[-_]agentchat|pyautogen)\s*(?:==|>=|<=|~=)\s*([\d.]+)/i,
      ],
      mastra: [
        /"@mastra\/(?:core|[\w-]+)"\s*:\s*"[\^~]?([\d.]+)/,
      ],
      unknown: [],
    };
    const res = patterns[fw] ?? [];
    for (const f of files) {
      for (const re of res) {
        const m = f.text.match(re);
        if (m) return m[1];
      }
    }
    return undefined;
  }

  private emptyGraph(args: {
    agent_id?: string;
    root_path: string;
    now: string;
    warnings: WorkflowWarning[];
  }): WorkflowGraph {
    return {
      agent_id: args.agent_id,
      framework: 'unknown',
      extracted_at: args.now,
      source: { root_path: args.root_path, files_scanned: 0, language: 'mixed' },
      nodes: [], edges: [], tool_bindings: [],
      entry_points: [], finish_points: [],
      warnings: args.warnings,
    };
  }
}
