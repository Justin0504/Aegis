/**
 * Framework detection — decides which parser to hand a file (or a
 * whole directory) to.
 *
 * We deliberately DON'T rely on `requirements.txt` / `package.json`
 * alone: teams vendor deps, mix frameworks, or bundle multiple agent
 * definitions in one repo. We inspect the actual import statements
 * plus a few high-signal API markers.
 *
 * Precedence when multiple frameworks appear in the same file:
 *   langgraph > crewai > autogen > mastra
 * (langgraph wins because its API is unambiguous; crewai second because
 * it defines the strongest first-class `Agent` abstraction.)
 */

import type { Framework, SourceLanguage } from './types';

// Import fingerprints — matched via case-insensitive regex against the
// full file text. `hint` is the API-surface marker that boosts
// confidence beyond just "the import is there".
interface Fingerprint {
  framework: Framework;
  language: SourceLanguage;
  importPatterns: RegExp[];
  apiPatterns: RegExp[];        // usage patterns that confirm active use
}

const FINGERPRINTS: Fingerprint[] = [
  {
    framework: 'langgraph',
    language: 'python',
    importPatterns: [
      /^\s*from\s+langgraph[.\s]/m,
      /^\s*import\s+langgraph/m,
    ],
    apiPatterns: [
      /StateGraph\s*\(/,
      /\.add_node\s*\(/,
      /\.add_edge\s*\(/,
      /\.add_conditional_edges\s*\(/,
      /\.set_entry_point\s*\(/,
    ],
  },
  {
    framework: 'langgraph',
    language: 'typescript',
    importPatterns: [
      /from\s+["']@langchain\/langgraph["']/,
      /from\s+["']@langchain\/langgraph\/[^"']+["']/,
    ],
    apiPatterns: [
      /new\s+StateGraph\s*\(/,
      /\.addNode\s*\(/,
      /\.addEdge\s*\(/,
      /\.addConditionalEdges\s*\(/,
    ],
  },
  {
    framework: 'crewai',
    language: 'python',
    importPatterns: [
      /^\s*from\s+crewai[.\s]/m,
      /^\s*import\s+crewai/m,
    ],
    apiPatterns: [
      /Crew\s*\(/,
      /Agent\s*\(\s*role\s*=/,
      /Task\s*\(\s*description\s*=/,
    ],
  },
  {
    framework: 'autogen',
    language: 'python',
    importPatterns: [
      /^\s*from\s+autogen[.\s]/m,
      /^\s*import\s+autogen/m,
      /^\s*from\s+autogen_agentchat[.\s]/m,   // AutoGen 0.4+
    ],
    apiPatterns: [
      /AssistantAgent\s*\(/,
      /UserProxyAgent\s*\(/,
      /GroupChat\s*\(/,
      /RoundRobinGroupChat\s*\(/,
    ],
  },
  {
    framework: 'mastra',
    language: 'typescript',
    importPatterns: [
      /from\s+["']@mastra\/core["']/,
      /from\s+["']@mastra\/[^"']+["']/,
    ],
    apiPatterns: [
      /new\s+Mastra\s*\(/,
      /new\s+Agent\s*\(/,
      /\.workflow\s*\(/,
      /createWorkflow\s*\(/,
    ],
  },
];

export interface DetectionResult {
  framework: Framework;
  language: SourceLanguage;
  /** 0.0–1.0 — 1.0 means both imports and API usage confirmed. */
  confidence: number;
  /** Other frameworks that also matched but scored lower; useful for
   *  the MULTI_FRAMEWORK_DETECTED warning. */
  runners_up: Array<{ framework: Framework; confidence: number }>;
}

/**
 * Detect the framework used inside a single file.
 *
 * @param filename — used only for language fallback (`.py` → python).
 * @param text     — the full file content.
 */
export function detectFramework(
  filename: string,
  text: string,
): DetectionResult {
  const scores = new Map<string, { fp: Fingerprint; imports: number; api: number }>();

  for (const fp of FINGERPRINTS) {
    const key = `${fp.framework}:${fp.language}`;
    const importHits = fp.importPatterns.filter(r => r.test(text)).length;
    const apiHits    = fp.apiPatterns.filter(r => r.test(text)).length;
    if (importHits === 0 && apiHits === 0) continue;
    scores.set(key, { fp, imports: importHits, api: apiHits });
  }

  if (scores.size === 0) {
    return {
      framework: 'unknown',
      language: languageFromFilename(filename),
      confidence: 0,
      runners_up: [],
    };
  }

  // Confidence = 0.5 for any import hit + up to 0.5 for API usage.
  // Cap at 1.0. Requires at least one signal.
  const ranked = Array.from(scores.entries())
    .map(([key, s]) => {
      const importScore = Math.min(1, s.imports) * 0.5;
      const apiScore    = Math.min(1, s.api / 2) * 0.5;
      return { key, fp: s.fp, confidence: importScore + apiScore };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const [winner, ...rest] = ranked;
  return {
    framework: winner.fp.framework,
    language: winner.fp.language,
    confidence: winner.confidence,
    runners_up: rest.map(r => ({ framework: r.fp.framework, confidence: r.confidence })),
  };
}

function languageFromFilename(name: string): SourceLanguage {
  if (name.endsWith('.py'))                     return 'python';
  if (/\.(ts|tsx)$/.test(name))                 return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(name))         return 'javascript';
  return 'mixed';
}
