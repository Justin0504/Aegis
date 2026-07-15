/**
 * LLM Egress Proxy handler — runs detector chain + per-tenant DSL over
 * every LLM exchange that passes through. Provider-neutral: the adapter
 * is responsible for shape; the handler is responsible for security
 * policy.
 *
 * Decision model (per pending tool_call), strictest wins:
 *   detector:  critical  → block this tool call (response is mangled)
 *              warn      → log + audit, pass through
 *              info      → log only
 *   DSL:       block     → block (same treatment as detector critical)
 *              pending   → block in proxy path (inline HTTP cannot hold
 *                          for human approval); audit tags the decision
 *                          as `dsl_pending_treated_as_block` so operators
 *                          reviewing the trail see WHY it was blocked
 *                          — not silently upgraded.
 *              allow     → no override
 *
 * The DSL context mirrors the /api/v1/check payload so a rule written
 * once fires the same on both surfaces. Workflow anchors (Phase 1.3)
 * are read from `X-AEGIS-Workflow-Node-Id` / `-Binding-Id` headers so
 * SDK callers using `workflow_scope()` get node-scoped policy targeting
 * without changing the API surface.
 */

import { Request, Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

import { Severity, Signal } from '@agentguard/core-schema';
import { DetectorRegistry } from '../detectors/registry';
import { AuditLogService } from '../services/audit-log';
import { calculateCost } from '../services/cost';
import { AgentRegistryService } from '../services/agent-registry';
import { AgentIdCardService } from '../services/agent-id-card';
import { CrossAgentCorrelatorService } from '../services/cross-agent-correlator';
import { TaintTrackerService } from '../services/taint-tracker';
import { DslPolicyService } from '../services/policy-dsl';
import type { MatchResult } from '../policies/dsl/evaluator';
import {
  NeutralToolCall,
  ProxyAdapter,
} from './adapter';

const PROXY_PATH_RE = /^\/(openai|anthropic|mistral|gemini)(\/.*)$/;
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export interface ProxyHandlerDeps {
  db: Database.Database;
  logger: Logger;
  detectors: DetectorRegistry;
  audit: AuditLogService;
  adapters: ReadonlyArray<ProxyAdapter>;
  /** Optional — if provided, every proxy call touches the agent registry
   *  and gets blocked when the agent is suspended/deprecated or missing
   *  its required secret. Backward-compatible: missing agentRegistry =
   *  no identity enforcement. */
  agentRegistry?: AgentRegistryService;
  /** Optional — when provided, the proxy accepts X-AEGIS-Agent-Token
   *  (AEGIS Agent ID v1 JWT) as an alternative to the legacy
   *  X-AEGIS-Agent-Secret. Valid JWT → strong attribution. The agent_id
   *  resolved comes from the JWT's sub claim, not the X-AEGIS-Agent-Id
   *  header — so a stolen agent_id can't be paired with a JWT for a
   *  different agent. */
  agentIdCards?: AgentIdCardService;
  /** Optional — when provided, every proxy evaluation observes
   *  signals so the cross-agent detector can spot multi-agent
   *  inheritance on subsequent calls in the same session. */
  crossAgent?: CrossAgentCorrelatorService;
  /** Optional — when provided, sensitive-content touches in this
   *  call's signals get recorded so subsequent outbound calls within
   *  the taint window trigger the T5001 exfil signal. */
  taintTracker?: TaintTrackerService;
  /** Optional — per-tenant DSL evaluator. When provided, every pending
   *  tool call is evaluated against the tenant DSL AFTER the detector
   *  chain runs, and the strictest decision wins. Same evaluator +
   *  context shape as `/api/v1/check` so a single policy fires on both
   *  paths. Missing dslPolicy = detector-only decisions (v1 behavior). */
  dslPolicy?: DslPolicyService;
}

interface AuthOk {
  orgId: string;
  keyName?: string;
  keyPrefix?: string;
}

export class ProxyHandler {
  private readonly byProvider: Map<string, ProxyAdapter>;

  constructor(private deps: ProxyHandlerDeps) {
    this.byProvider = new Map(deps.adapters.map(a => [a.provider, a]));
  }

  /** Express handler — mounted via app.all('/api/v1/proxy/*'). */
  handle = async (req: Request, res: Response): Promise<void> => {
    const path = req.path.replace(/^\/api\/v1\/llm-proxy/, '');
    const m = PROXY_PATH_RE.exec(path);
    if (!m) {
      // Reflecting the user-supplied path back in the error body is
      // gratuitous info-disclosure (aids reconnaissance + hands attackers
      // their own canonicalised path) — keep the full path in the audit
      // log instead so operators still have it for triage.
      this.deps.logger.info({ path }, 'UNKNOWN_PROVIDER on llm-proxy route');
      res.status(404).json({ error: { code: 'UNKNOWN_PROVIDER' } });
      return;
    }
    const provider = m[1];
    const tail = m[2];
    const adapter = this.byProvider.get(provider);
    if (!adapter) {
      res.status(404).json({ error: { code: 'PROVIDER_NOT_ENABLED', provider } });
      return;
    }

    const auth = this.checkAuth(req);
    if (!auth) {
      res.status(401).json({ error: { code: 'AEGIS_AUTH_MISSING', message: 'Missing or invalid X-AEGIS-Key header' } });
      return;
    }

    // Adapter-side preflight (streaming reject, etc.)
    const reject = adapter.preflightReject(req.body);
    if (reject) {
      res.status(400).json({ error: { code: 'PROXY_PREFLIGHT_REJECT', message: reject } });
      return;
    }

    const headers = lowerCaseHeaders(req.headers);
    let ctx = adapter.extractAegisContext(headers, req.body);

    // ── JWT identity (AEGIS Agent ID v1) ─────────────────────────────
    // If the caller presented an X-AEGIS-Agent-Token, verify it and
    // resolve the agent identity from the JWT's `sub` claim — not the
    // header-claimed X-AEGIS-Agent-Id. This means a stolen agent_id
    // header can't be paired with a JWT for a different agent.
    let jwtValid = false;
    let agentTokenInfo: { kid?: string; exp?: number } | undefined;
    const presentedJwt = headers['x-aegis-agent-token'];
    if (presentedJwt && this.deps.agentIdCards) {
      const v = this.deps.agentIdCards.verify(presentedJwt);
      if (v.ok && v.claims) {
        jwtValid = true;
        // JWT sub WINS over the header agent id — fewer ways to spoof.
        ctx = { ...ctx, agentId: v.claims.sub, sessionId: ctx.sessionId };
        agentTokenInfo = { exp: v.claims.exp };
      } else {
        // Caller sent a token but it's bad — fail fast rather than fall
        // through to header-claimed identity.
        res.status(403).json({
          error: { code: 'AGENT_TOKEN_INVALID', message: v.reason ?? 'JWT verification failed' },
        });
        return;
      }
    }

    // Agent identity gate. Auto-records unknown agent_ids as 'unregistered'
    // (backward compat); blocks if the agent is suspended/deprecated or
    // requires a secret the caller didn't present. attributionStrength is
    // attached to the audit row so compliance reports can distinguish
    // first-party from drive-by traffic.
    let attributionStrength: 'strong' | 'weak' = 'weak';
    if (this.deps.agentRegistry) {
      const presentedSecret = headers['x-aegis-agent-secret'];
      const buildArtifact = headers['x-aegis-build-artifact'];
      const sourceCommit  = headers['x-aegis-source-commit'];
      const authz = this.deps.agentRegistry.authorize({
        orgId: auth.orgId,
        agentId: ctx.agentId,
        presentedSecret,
        presentedJwtValid: jwtValid,
        provenance: (buildArtifact || sourceCommit)
          ? { build_artifact: buildArtifact, source_commit: sourceCommit }
          : undefined,
      });
      if (authz?.blocked) {
        res.status(403).json({
          error: {
            code: 'AGENT_IDENTITY_BLOCKED',
            message: authz.blockReason,
            agent_status: authz.agent.status,
          },
        });
        return;
      }
      if (authz) attributionStrength = authz.attributionStrength;
    }

    // Forward upstream — BYO key model: customer's auth header passes through.
    const upstreamHeaders = adapter.upstreamHeaders(headers);
    const upstreamUrl = adapter.upstreamUrl(tail, queryStringFrom(req));
    const t0 = Date.now();
    // Upstream LLM call has to time out. Without an AbortSignal the
    // node fetch() will hold the worker forever on a hung connection
    // (Anthropic / OpenAI cold-start spikes, network partition, etc.).
    // 120 s is the practical p99 for a long generation; can be tuned
    // per-org later via tenant config.
    const upstreamTimeoutMs = Math.max(
      1_000,
      Number(process.env.AEGIS_PROXY_UPSTREAM_TIMEOUT_MS ?? 120_000),
    );
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), upstreamTimeoutMs);
    let upstreamRes: Response | globalThis.Response;
    let upstreamJson: any;
    try {
      const fetchRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
        signal: ac.signal,
      });
      upstreamRes = fetchRes;
      const text = await fetchRes.text();
      try { upstreamJson = JSON.parse(text); }
      catch { upstreamJson = { raw: text }; }
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const code = aborted ? 'PROXY_UPSTREAM_TIMEOUT' : 'PROXY_UPSTREAM_FAILED';
      const status = aborted ? 504 : 502;
      this.deps.logger.warn(
        { err: (err as Error).message, upstreamUrl, aborted, timeout_ms: upstreamTimeoutMs },
        aborted ? 'proxy upstream timed out' : 'proxy upstream call failed',
      );
      res.status(status).json({ error: { code, message: (err as Error).message } });
      return;
    } finally {
      clearTimeout(timer);
    }
    const upstreamMs = Date.now() - t0;

    // Phase 4a · workflow anchors from headers. SDK `workflow_scope()`
    // sets these; when both sides participate the DSL sees a
    // node-scoped context and rules like `workflow.node_id == "<uuid>"`
    // fire. Legacy callers omit the headers and DSL falls back to
    // tool-name matching (unchanged v1 behavior).
    const workflowAnchor = extractWorkflowAnchor(headers);

    // Run detectors over every pending tool call from the response. Tool
    // calls in the REQUEST history already executed in earlier turns —
    // they're audit material, not blockable. Earlier-turn tool RESULTS
    // ARE flowed in as untrusted conversation surface so the IPI
    // detector can scan them for embedded instructions.
    const pending = adapter.extractPendingToolCalls(upstreamJson);
    const toolResultContent = adapter.extractToolResultContent(req.body);
    const evaluations = await this.evaluatePending(
      {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        toolResultContent,
        workflow: workflowAnchor,
      },
      auth.orgId,
      pending,
    );

    const allSignals = evaluations.flatMap(e => e.signals);

    // Feed the cross-agent correlator so the NEXT call in this session
    // can spot inheritance. Pass the flattened signal list (the correlator
    // only cares about severity for now).
    if (this.deps.crossAgent) {
      this.deps.crossAgent.observe({
        orgId: auth.orgId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        signals: allSignals,
      });
    }
    // Feed the taint tracker so NEXT outbound call in this session can
    // see the temporal connection to sensitive-content access.
    if (this.deps.taintTracker) {
      this.deps.taintTracker.observe({
        orgId: auth.orgId,
        sessionId: ctx.sessionId,
        signals: allSignals,
      });
    }

    const blocked = evaluations.filter(e => e.decision === 'block');
    const directive = {
      blockedToolCallIds: blocked.map(b => b.toolCall.id),
      reason: blocked.length === 0
        ? ''
        : blocked.map(b => b.reason).filter(Boolean).slice(0, 3).join(' | '),
    };

    const mangled = directive.blockedToolCallIds.length > 0
      ? adapter.applyBlockingDirective(upstreamJson, directive)
      : upstreamJson;

    // Cost from upstream usage (if reported).
    const usage = adapter.extractUsage(upstreamJson);
    const costUsd = usage
      ? calculateCost(usage.model || ctx.model, usage.promptTokens, usage.completionTokens)
      : 0;

    // Audit row — flows through subscribers → sinks → transparency log
    // automatically (the wiring shipped with the universal sink layer).
    this.deps.audit.log({
      org_id: auth.orgId,
      user_id: undefined,
      user_email: auth.keyName,
      action: 'proxy.llm_call',
      resource_type: 'trace',
      resource_id: randomUUID(),
      ip_address: req.ip,
      details: {
        proxy: {
          provider: adapter.provider,
          path: tail,
          agent_id: ctx.agentId,
          session_id: ctx.sessionId,
          model: usage?.model || ctx.model,
          upstream_ms: upstreamMs,
          upstream_status: (upstreamRes as globalThis.Response).status,
          attribution_strength: attributionStrength,
          identity_proof: agentTokenInfo
            ? { type: 'jwt', token_exp: agentTokenInfo.exp }
            : (headers['x-aegis-agent-secret'] ? { type: 'secret' } : { type: 'header-only' }),
        },
        cost: {
          input_tokens: usage?.promptTokens ?? 0,
          output_tokens: usage?.completionTokens ?? 0,
          usd: costUsd,
        },
        tool_calls: {
          historic: adapter.extractHistoricToolCalls(req.body).map(redactArgs),
          pending: pending.map(redactArgs),
          blocked: directive.blockedToolCallIds,
        },
        signals: evaluations.flatMap(e => e.signals.map(toAuditSignal)),
        dsl: evaluations
          .filter(e => e.dsl)
          .map(e => ({
            tool_call_id: e.toolCall.id,
            decision:     e.dsl!.decision,
            rule_name:    e.dsl!.ruleName,
            reason:       e.dsl!.reason,
            treated_as:   e.dslTreatedAs,
          })),
        workflow: workflowAnchor ?? undefined,
      },
    });

    res.status((upstreamRes as globalThis.Response).status);
    // Forward upstream content type where reasonable.
    const upstreamContentType = (upstreamRes as globalThis.Response).headers.get('content-type');
    if (upstreamContentType) res.setHeader('content-type', upstreamContentType);
    res.setHeader('x-aegis-proxy', `${adapter.name}/v1`);
    if (directive.blockedToolCallIds.length > 0) {
      res.setHeader('x-aegis-blocked-tool-calls', String(directive.blockedToolCallIds.length));
    }
    res.send(typeof mangled === 'string' ? mangled : JSON.stringify(mangled));
  };

  private async evaluatePending(
    ctx: {
      agentId: string;
      sessionId?: string;
      toolResultContent?: string[];
      workflow?: { node_id?: string; binding_id?: string };
    },
    orgId: string,
    pending: NeutralToolCall[],
  ): Promise<Array<ProxyEvaluation>> {
    const out: ProxyEvaluation[] = [];
    for (const tc of pending) {
      const signals = await this.deps.detectors.evaluateAll({
        tool: { name: tc.name, args: tc.arguments },
        agent: { id: ctx.agentId },
        tenant: { id: orgId },
        session: ctx.sessionId ? { id: ctx.sessionId } : undefined,
        conversation: ctx.toolResultContent && ctx.toolResultContent.length > 0
          ? { toolResultContent: ctx.toolResultContent }
          : undefined,
      });
      const worst = signals.reduce<Signal | null>(
        (acc, s) => (acc == null || SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc.severity]) ? s : acc,
        null,
      );

      // Detector-side decision (v1 behavior).
      let decision: 'allow' | 'block' = worst && worst.severity === 'critical' ? 'block' : 'allow';
      let reason: string | undefined = worst?.message;

      // ── DSL evaluation (fail-safe: can only tighten, never loosen) ──
      // Same shape as check.ts:313 so a single rule fires on both
      // surfaces. Detector-produced classifier/anomaly aren't computed
      // in the egress path (no ML pipeline in-line yet), so those
      // context branches stay empty — the DSL correctly returns
      // no-match when a rule requires them.
      let dslMatch: MatchResult | null = null;
      let dslTreatedAs: 'block' | 'allow' | undefined;
      if (this.deps.dslPolicy) {
        try {
          dslMatch = this.deps.dslPolicy.evaluate(orgId, {
            tool: { name: tc.name, args: tc.arguments },
            agent: { id: ctx.agentId },
            tenant: { id: orgId },
            workflow: ctx.workflow?.node_id || ctx.workflow?.binding_id
              ? { node_id: ctx.workflow.node_id, binding_id: ctx.workflow.binding_id }
              : undefined,
          });
        } catch (err) {
          this.deps.logger.error(
            { orgId, err: (err as Error).message },
            'DSL evaluate() threw in proxy — treating as no-match',
          );
        }
        if (dslMatch) {
          if (dslMatch.decision === 'block') {
            decision = 'block';
            reason = `DSL:${dslMatch.ruleName}${dslMatch.reason ? ` (${dslMatch.reason})` : ''}`;
            dslTreatedAs = 'block';
          } else if (dslMatch.decision === 'pending') {
            // Proxy is inline HTTP — no place to hold for human approval.
            // Fail-safe: pending → block, but audit the exact reason so
            // operators reviewing the trail see WHY we didn't wait.
            decision = 'block';
            reason = `DSL:${dslMatch.ruleName} (pending-treated-as-block: ${dslMatch.reason ?? 'human review required'})`;
            dslTreatedAs = 'block';
          } else {
            dslTreatedAs = 'allow';
          }
        }
      }

      out.push({ toolCall: tc, signals, decision, reason, dsl: dslMatch, dslTreatedAs });
    }
    return out;
  }

  private checkAuth(req: Request): AuthOk | null {
    const key = lowerCaseHeaders(req.headers)['x-aegis-key'];
    if (!key) return null;

    // Org-scoped API key (preferred).
    if (key.startsWith('aegis_')) {
      const hash = createHash('sha256').update(key).digest('hex');
      const row = this.deps.db.prepare(
        `SELECT org_id, name, key_prefix, revoked_at, expires_at FROM org_api_keys WHERE key_hash = ?`,
      ).get(hash) as { org_id: string; name: string; key_prefix: string; revoked_at: string | null; expires_at: string | null } | undefined;
      if (row && !row.revoked_at) {
        const expired = row.expires_at && new Date(row.expires_at) < new Date();
        if (!expired) return { orgId: row.org_id, keyName: row.name, keyPrefix: row.key_prefix };
      }
      return null;
    }

    // Legacy single-key fallback (community mode).
    // Constant-time compare prevents timing-channel byte-by-byte key
    // recovery: `===` short-circuits at the first mismatched byte, so
    // an attacker could measure response timing to map prefix correctness.
    // timingSafeEqual takes O(length) on every comparison regardless of
    // where the divergence is.
    const dashRow = this.deps.db.prepare(
      `SELECT value FROM gateway_config WHERE key = 'dashboard_api_key'`,
    ).get() as { value: string } | undefined;
    if (dashRow && constantTimeStringEqual(dashRow.value, key)) {
      return { orgId: 'default', keyName: 'dashboard' };
    }
    return null;
  }
}

/** Constant-time string equality. Returns false on length mismatch
 *  (length is not secret — the length of an API key isn't sensitive
 *  data, and pretending it is would require padding every comparison
 *  to a fixed max length, which has its own footguns). */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function lowerCaseHeaders(h: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

function queryStringFrom(req: Request): string {
  const qIdx = req.originalUrl.indexOf('?');
  return qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
}

/** Redact tool-call args before they land in the audit row. We keep the
 *  shape (key names) but blank string values longer than 64 chars and
 *  obviously-secret-looking values. The trace persistence path does the
 *  full PII redaction; here we just keep the audit row from getting
 *  enormous. */
function redactArgs(tc: NeutralToolCall): { id: string; name: string; arg_keys: string[] } {
  return {
    id: tc.id,
    name: tc.name,
    arg_keys: Object.keys(tc.arguments ?? {}),
  };
}

/**
 * Extract Phase 1.3 workflow anchors from proxy headers. SDK
 * `workflow_scope()` sets `X-AEGIS-Workflow-Node-Id` /
 * `-Binding-Id`; when absent, we return undefined so the DSL
 * evaluator sees no workflow context (legacy behavior).
 *
 * Anchors are validated as UUIDs (v5, per Phase 1.1) — a malformed
 * header is silently dropped rather than mis-attributed, so a
 * client bug can't get its call routed to another node's policy.
 */
function extractWorkflowAnchor(headers: Record<string, string>): {
  node_id?: string; binding_id?: string;
} | undefined {
  const node    = headers['x-aegis-workflow-node-id'];
  const binding = headers['x-aegis-workflow-binding-id'];
  const nodeOk    = node    && UUID_RE.test(node)    ? node    : undefined;
  const bindingOk = binding && UUID_RE.test(binding) ? binding : undefined;
  if (!nodeOk && !bindingOk) return undefined;
  return { node_id: nodeOk, binding_id: bindingOk };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProxyEvaluation {
  toolCall: NeutralToolCall;
  signals: Signal[];
  decision: 'allow' | 'block';
  reason?: string;
  /** DSL evaluator's raw match, if any. Absent when no DSL configured
   *  or no rule matched. Retained separately from `decision` so audit
   *  can see when the DSL fired but detector was already blocking
   *  (both signals attributed) and when the DSL is the sole reason
   *  for a block. */
  dsl?: MatchResult | null;
  /** How the proxy translated the DSL decision. `pending` → `block`
   *  is the load-bearing case: the audit row keeps the original DSL
   *  decision AND this translation so operators can distinguish
   *  "DSL said block" from "DSL said pending but we can't hold". */
  dslTreatedAs?: 'block' | 'allow';
}

function toAuditSignal(s: Signal): { detector: string; severity: Severity; category: string; message: string } {
  return {
    detector: s.detector,
    severity: s.severity,
    category: s.category,
    message: s.message,
  };
}
