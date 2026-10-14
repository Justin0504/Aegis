/**
 * Alignment helper — POST a chain-of-thought + proposed action to
 * the AEGIS gateway's `/api/v1/alignment/check` endpoint, get a
 * verdict, and buffer it so the SDK's auto-instrumentation splices
 * it into the next /check call for the same agent.
 *
 * Mirrors the Python helper API.
 */

import { record } from './alignment-state.js';

export type AlignmentProvider = 'anthropic' | 'openai' | 'gemini';
export const PROVIDERS: readonly AlignmentProvider[] = [
  'anthropic',
  'openai',
  'gemini',
] as const;

export interface ProposedAction {
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export interface AlignmentVerdict {
  score: number;
  drifted?: boolean;
  signals?: string[];
  reason?: string;
  model?: string;
  [k: string]: unknown;
}

export interface CheckOptions {
  agentId: string;
  declaredGoal: string;
  proposedAction: ProposedAction;
  thoughtChain?: readonly string[];
  gatewayUrl?: string;
  apiKey?: string;
  provider?: AlignmentProvider;
  model?: string;
  timeoutMs?: number;
  /** If false, don't buffer for the next /check call. Default true. */
  recordForCheck?: boolean;
  /** Session whose context the SDK reports (default: AEGIS_SESSION_ID).
   *  With it, the gateway shows the auditor the tool output the agent
   *  read, so argument values can be checked against evidence. */
  sessionId?: string;
}

export async function check(opts: CheckOptions): Promise<AlignmentVerdict> {
  const {
    agentId,
    declaredGoal,
    proposedAction,
    thoughtChain,
    gatewayUrl = 'http://localhost:8080',
    apiKey,
    provider,
    model,
    timeoutMs = 10_000,
    recordForCheck = true,
  } = opts;
  const sessionId =
    opts.sessionId ?? (typeof process !== 'undefined' ? process.env?.AEGIS_SESSION_ID : undefined);

  if (!agentId) throw new Error('agentId is required');
  if (!declaredGoal) throw new Error('declaredGoal is required');
  if (!proposedAction || !proposedAction.tool_name) {
    throw new Error('proposedAction must include a tool_name');
  }
  if (provider && !PROVIDERS.includes(provider)) {
    throw new Error(`provider must be one of ${PROVIDERS.join(', ')}`);
  }

  const body: Record<string, unknown> = {
    agent_id: agentId,
    declared_goal: declaredGoal,
    thought_chain: Array.isArray(thoughtChain) ? [...thoughtChain] : [],
    proposed_action: {
      tool_name: proposedAction.tool_name,
      arguments: proposedAction.arguments ?? {},
    },
  };
  if (sessionId) body.session_id = sessionId;
  if (provider) body.provider = provider;
  if (model) body.model = model;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = apiKey ?? (typeof process !== 'undefined' ? process.env?.AEGIS_API_KEY : undefined);
  if (key) headers['X-API-Key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/api/v1/alignment/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `alignment check failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      );
    }
    const verdict = (await res.json()) as AlignmentVerdict;
    if (recordForCheck) {
      record(agentId, verdict as unknown as Record<string, unknown>);
    }
    return verdict;
  } finally {
    clearTimeout(timer);
  }
}

export { consume as consumeBuffer } from './alignment-state.js';
