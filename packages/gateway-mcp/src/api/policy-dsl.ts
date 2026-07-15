/**
 * Per-tenant Policy DSL CRUD.
 *
 *   GET    /api/v1/dsl                — current tenant's DSL (or null)
 *   PUT    /api/v1/dsl                — replace
 *   DELETE /api/v1/dsl                — remove
 *   POST   /api/v1/dsl/dry-run        — compile + evaluate without persisting
 *   GET    /api/v1/dsl/examples       — list builtin starter docs
 *
 * Persistence flows through TenantConfigService so:
 *   - audit log entries are written via the shared mechanism
 *   - ConfigBus emits an update → DslPolicyService recompiles automatically
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';
import { PolicyDsl, PolicyDslSchema } from '@agentguard/core-schema';
import { TenantConfigService } from '../services/tenant-config';
import { DslPolicyService } from '../services/policy-dsl';
import { BUILTIN_DSL_EXAMPLES } from '../policies/dsl/builtin-examples';
import { DslCompileError } from '../policies/dsl/ast';
import { DslContext } from '../policies/dsl/evaluator';
import { NlPolicyCompilerService } from '../services/nl-policy-compiler';
import type { WorkflowGraph } from '../services/workflow/types';

const DryRunRequestSchema = z.object({
  dsl: PolicyDslSchema,
  context: z.record(z.unknown()),
});

function ctxFromReq(req: Request) {
  // Use the auth-middleware-stamped key info as the actor identity.
  // org_api_keys.name + key_prefix → human-readable + stable id.
  const name = req.keyName;
  const prefix = req.keyPrefix;
  const formatted = name && prefix ? `${name} (${prefix})` : (name ?? prefix);
  return {
    userEmail: formatted as string | undefined,
    userId: prefix as string | undefined,
    ipAddress: req.ip,
  };
}

function resolveOrgId(req: Request, res: Response): string | null {
  const orgId = req.orgId;
  if (!orgId) {
    res.status(401).json({ error: 'No tenant context (missing X-API-Key)' });
    return null;
  }
  return orgId;
}

export class PolicyDslAPI {
  public router: Router;

  constructor(
    private tenantConfig: TenantConfigService,
    private dsl: DslPolicyService,
    private logger: Logger,
    private nl?: NlPolicyCompilerService,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.get('/examples', (_req: Request, res: Response) => {
      res.json({ examples: BUILTIN_DSL_EXAMPLES });
    });

    // POST /compile-nl — Phase 2 · natural-language → workflow-aware DSL.
    //
    // Body: { description, workflow?, name?, backend? }
    // Returns: { compiled, references, explanation, backend, warnings }
    //
    // The endpoint does NOT persist. Callers (cockpit / CLI) get the
    // compiled DSL back, show the operator, and then PUT /dsl to save.
    // This split lets the operator sanity-check the LLM's output —
    // "does this rule actually target the send_email node?" — before
    // it goes live.
    this.router.post('/compile-nl', async (req: Request, res: Response) => {
      if (!this.nl) {
        return res.status(503).json({ error: 'nl compiler not configured on this gateway' });
      }
      const schema = z.object({
        description: z.string().min(1).max(2000),
        workflow: z.any().optional(),   // WorkflowGraph — validated downstream via UUID references
        name: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
        backend: z.enum(['llm', 'heuristic']).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid compile-nl request', details: parsed.error.issues });
      }
      try {
        const out = await this.nl.compile({
          description: parsed.data.description,
          workflow:    parsed.data.workflow as WorkflowGraph | undefined,
          name:        parsed.data.name,
          backend:     parsed.data.backend,
        });
        res.json(out);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'nl-policy compile failed');
        res.status(400).json({ error: (err as Error).message });
      }
    });

    this.router.post('/dry-run', (req: Request, res: Response) => {
      const parsed = DryRunRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid dry-run request',
          details: parsed.error.issues,
        });
      }
      try {
        const result = this.dsl.dryRun(
          parsed.data.dsl,
          parsed.data.context as DslContext,
        );
        res.json({ match: result });
      } catch (err) {
        if (err instanceof DslCompileError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.router.get('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const cfg = this.tenantConfig.get(orgId);
      res.json({ dsl: cfg.dsl ?? null });
    });

    this.router.put('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      const parsed = PolicyDslSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid DSL',
          details: parsed.error.issues,
        });
      }
      // Compile up-front to surface DslCompileError before persisting.
      try {
        this.dsl.dryRun(parsed.data, {});
      } catch (err) {
        if (err instanceof DslCompileError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
      try {
        const updated = this.tenantConfig.update(
          orgId,
          { dsl: parsed.data },
          ctxFromReq(req),
        );
        res.json({ dsl: updated.dsl ?? null });
      } catch (err: any) {
        const status = (err?.status as number) ?? 500;
        res.status(status).json({ error: err.message });
      }
    });

    this.router.delete('/', (req: Request, res: Response) => {
      const orgId = resolveOrgId(req, res);
      if (!orgId) return;
      try {
        // Replace entire config with dsl removed; deep-merge would not
        // delete a field, so we read+rewrite.
        const current = this.tenantConfig.get(orgId);
        const next: PolicyDsl | undefined = undefined;
        const merged = { ...current, dsl: next };
        delete (merged as any).dsl;
        this.tenantConfig.replace(
          orgId,
          merged as any,
          ctxFromReq(req),
        );
        res.json({ ok: true });
      } catch (err: any) {
        const status = (err?.status as number) ?? 500;
        res.status(status).json({ error: err.message });
      }
    });
  }
}
