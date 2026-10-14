/**
 * Alignment auditor REST endpoint.
 *
 *   POST /api/v1/alignment/check
 *   body: AlignmentInput + optional { provider, model, api_key }
 *
 * Provider configuration falls back to env vars (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY) when the body doesn't include one
 * — matches the convention used by the existing LLM judge.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import Database from 'better-sqlite3';
import {
  AlignmentChecker,
  AlignmentConfig,
  AlignmentProvider,
} from '../services/alignment-checker';
import { AuditLogService } from '../services/audit-log';
import { auditActor } from '../middleware/auth';
import { ContextLedgerStore } from '../services/context-ledger-store';

const RequestSchema = z.object({
  agent_id: z.string().min(1).max(128),
  declared_goal: z.string().min(1).max(4096),
  thought_chain: z.array(z.string().max(2048)).max(64).default([]),
  proposed_action: z.object({
    tool_name: z.string().min(1).max(128),
    arguments: z.record(z.unknown()),
  }),
  // The session whose context ledger holds what the agent read; when
  // given, its recent tool output is shown to the judge as evidence.
  session_id: z.string().min(1).max(256).optional(),
  // Optional overrides
  provider: z.enum(['anthropic', 'openai', 'gemini', 'local']).optional(),
  model: z.string().max(80).optional(),
  api_key: z.string().min(8).max(512).optional(),
});

export function resolveConfig(
  body: z.infer<typeof RequestSchema>,
  env: NodeJS.ProcessEnv = process.env,
): AlignmentConfig | { error: string } {
  // Same order as services/llm-clients.ts: a configured local endpoint
  // first, cloud keys after, and no cloud call at all under AEGIS_OFFLINE.
  const localUrl = env.AEGIS_LOCAL_LLM_URL?.trim();
  const localModel = env.AEGIS_LOCAL_LLM_MODEL?.trim();
  const offline = ['1', 'true', 'yes'].includes(String(env.AEGIS_OFFLINE ?? '').toLowerCase());
  if ((body.provider === 'local' || !body.provider) && localUrl && localModel) {
    return {
      provider: 'local',
      apiKey: env.AEGIS_LOCAL_LLM_KEY ?? '',
      baseUrl: localUrl,
      model: body.model ?? localModel,
      timeoutMs: Number(env.AEGIS_LOCAL_LLM_TIMEOUT_MS) || 60_000,
    };
  }
  if (offline) {
    return { error: 'AEGIS_OFFLINE is set and no local model is configured (AEGIS_LOCAL_LLM_URL + AEGIS_LOCAL_LLM_MODEL).' };
  }
  const provider: AlignmentProvider =
    body.provider ??
    (env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : env.OPENAI_API_KEY
        ? 'openai'
        : env.GEMINI_API_KEY
          ? 'gemini'
          : 'anthropic');

  const envKey =
    provider === 'anthropic'
      ? env.ANTHROPIC_API_KEY
      : provider === 'openai'
        ? env.OPENAI_API_KEY
        : env.GEMINI_API_KEY;

  const apiKey = body.api_key ?? envKey;
  if (!apiKey) {
    return {
      error: `No API key for provider '${provider}'. Set ${provider.toUpperCase()}_API_KEY or pass api_key in the request body.`,
    };
  }
  return {
    provider,
    apiKey,
    model: body.model,
  };
}

export class AlignmentAPI {
  public router: Router;

  constructor(
    private logger: Logger,
    private auditLog: AuditLogService,
    private db: Database.Database,
    private contextLedgers?: ContextLedgerStore,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.post('/check', async (req: Request, res: Response) => {
      const parsed = RequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid request', details: parsed.error.issues });
      }
      const cfgOrErr = resolveConfig(parsed.data);
      if ('error' in cfgOrErr) {
        return res.status(400).json({ error: cfgOrErr.error });
      }

      const checker = new AlignmentChecker(cfgOrErr, this.logger);
      try {
        // Zod ran with .min(1) / required fields, so the parsed object
        // satisfies AlignmentInput at runtime; TS doesn't carry that
        // refinement so we cast.
        const observations = this.contextLedgers?.observations(
          (req as any).orgId ?? 'default',
          parsed.data.session_id,
        ) ?? [];
        const result = await checker.check({ ...(parsed.data as any), observations });

        // Audit log every check — alignment scores are evidence that
        // belongs in the compliance trail. auditActor stamps the
        // API key name/prefix so SOC 2 reviewers see *who* called.
        this.auditLog.log({
          org_id: (req as any).orgId,
          ...auditActor(req),
          action: 'judge.trace',
          resource_type: 'agent',
          resource_id: parsed.data.agent_id,
          details: {
            kind: 'alignment',
            score: result.score,
            drifted: result.drifted,
            signals: result.signals,
            model: result.model,
          },
          ip_address: req.ip,
        });

        return res.json(result);
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(
          { agent_id: parsed.data.agent_id, err: msg },
          'alignment check failed',
        );
        return res.status(502).json({ error: msg });
      }
    });

    /**
     * GET /api/v1/alignment/recent?limit=20
     *
     * Returns the most recent alignment checks scoped to the current
     * org. Pulls from `admin_audit_log` where action='judge.trace' and
     * the details blob's `kind` field is 'alignment' — same surface
     * the POST endpoint writes to.
     */
    this.router.get('/recent', (req: Request, res: Response) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const orgId = (req as any).orgId ?? 'default';
      try {
        const rows = this.db
          .prepare(
            `SELECT id, org_id, user_email, action, resource_id, details, created_at
             FROM admin_audit_log
             WHERE action = 'judge.trace'
               AND org_id = ?
               AND json_extract(details, '$.kind') = 'alignment'
             ORDER BY id DESC
             LIMIT ?`,
          )
          .all(orgId, limit) as Array<{
            id: number;
            org_id: string | null;
            user_email: string | null;
            resource_id: string | null;
            details: string;
            created_at: string;
          }>;

        const items = rows
          .map((r) => {
            try {
              const d = JSON.parse(r.details) as {
                kind?: string;
                score?: number;
                drifted?: boolean;
                signals?: string[];
                model?: string;
                reason?: string;
              };
              return {
                id: r.id,
                agent_id: r.resource_id,
                created_at: r.created_at,
                score: typeof d.score === 'number' ? d.score : null,
                drifted: Boolean(d.drifted),
                signals: Array.isArray(d.signals) ? d.signals : [],
                model: d.model ?? null,
                reason: d.reason ?? null,
                user_email: r.user_email,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        res.json({ items, limit });
      } catch (err) {
        this.logger.error({ err }, 'alignment recent query failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
