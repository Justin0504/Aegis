/**
 * WorkflowAPI — extract a WorkflowGraph from uploaded source files.
 *
 *   POST /api/v1/workflow/extract
 *     { agent_id?, root_path?, files: [{path, text}, ...] }
 *   →  WorkflowGraph
 *
 * Enforced limits:
 *   - Max 200 files per request
 *   - Max 200 KB per file
 *   - Max 20 MB total payload (handled by express body-parser at the
 *     app level; this route rejects anything larger before parsing)
 *
 * Auth: same requireAuth used across the rollback API. Every extract
 * writes an audit_log row so ops can see who scanned what.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';

import { WorkflowExtractorService, type WorkflowFile } from '../services/workflow/extractor';
import { CoverageScanService } from '../services/workflow/coverage-scan';
import type { AuditLogService } from '../services/audit-log';
import type { DslPolicyService } from '../services/policy-dsl';

const FileSchema = z.object({
  path: z.string().min(1).max(400),
  text: z.string().max(200 * 1024),          // 200 KB per file
});

const BodySchema = z.object({
  agent_id:  z.string().max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  root_path: z.string().max(400).optional(),
  files:     z.array(FileSchema).min(1).max(200),
}).strict();

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}
function actorOf(req: Request) {
  return {
    user_id:    (req as any).sessionUser?.id    ?? (req as any).keyPrefix,
    user_email: (req as any).sessionUser?.email ?? (req as any).keyName,
    ip_address: req.ip,
  };
}

export class WorkflowAPI {
  router: Router;
  private coverage?: CoverageScanService;

  constructor(
    private svc: WorkflowExtractorService,
    private logger: Logger,
    private audit?: AuditLogService,
    /** Optional — when provided, /coverage becomes available and dry-
     *  runs the tenant's DSL against the extracted tool bindings. */
    dsl?: DslPolicyService,
  ) {
    this.router = Router();
    this.router.post('/extract', this.extract.bind(this));
    if (dsl) {
      this.coverage = new CoverageScanService(svc, dsl);
      this.router.post('/coverage', this.coverageScan.bind(this));
    }
  }

  private extract(req: Request, res: Response): void {
    const parsed = BodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    const { agent_id, root_path, files } = parsed.data;

    // Total-size sanity check on top of the per-file cap.
    const totalBytes = files.reduce((n, f) => n + f.text.length, 0);
    if (totalBytes > 20 * 1024 * 1024) {
      res.status(413).json({ error: 'total payload exceeds 20 MB' });
      return;
    }

    try {
      // Zod-validated at this point — every file has required path + text.
      const cleanFiles: WorkflowFile[] = files.map(f => ({ path: f.path, text: f.text }));
      const graph = this.extractGraph(cleanFiles, root_path, agent_id);

      // Audit the extraction. We log the framework, node/edge counts,
      // and file count — never the file contents.
      if (this.audit) {
        this.audit.log({
          org_id:         orgIdOf(req),
          action:         'workflow.extract' as any,   // permissive union tag
          resource_type:  'agent' as any,
          resource_id:    agent_id ?? null as any,
          user_id:        actorOf(req).user_id,
          user_email:     actorOf(req).user_email,
          ip_address:     actorOf(req).ip_address,
          details: {
            framework:      graph.framework,
            framework_version: graph.framework_version ?? null,
            files_scanned:  graph.source.files_scanned,
            nodes_count:    graph.nodes.length,
            edges_count:    graph.edges.length,
            tool_bindings_count: graph.tool_bindings.length,
            warnings_count: graph.warnings.length,
          },
        });
      }

      res.json(graph);
    } catch (err: any) {
      this.logger.error({ err: err?.message }, 'workflow extract failed');
      res.status(500).json({ error: err?.message ?? 'internal error' });
    }
  }

  /** Convenience wrapper so `extract()` and `coverageScan()` share the
   *  same graph-extraction call and audit-row shape. */
  private extractGraph(files: WorkflowFile[], root_path: string | undefined, agent_id: string | undefined) {
    return this.svc.extract({ files, root_path, agent_id });
  }

  /**
   * POST /api/v1/workflow/coverage
   *   Same body as /extract, plus the tenant's DSL is dry-run against
   *   every extracted tool binding. Returns a CoverageReport with
   *   per-node coverage %, dead-rule list, and remediation suggestions.
   */
  private coverageScan(req: Request, res: Response): void {
    if (!this.coverage) {
      res.status(503).json({ error: 'coverage service not wired (DslPolicyService missing)' });
      return;
    }
    const parsed = BodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    const { agent_id, root_path, files } = parsed.data;
    const totalBytes = files.reduce((n, f) => n + f.text.length, 0);
    if (totalBytes > 20 * 1024 * 1024) {
      res.status(413).json({ error: 'total payload exceeds 20 MB' });
      return;
    }
    try {
      const cleanFiles: WorkflowFile[] = files.map(f => ({ path: f.path, text: f.text }));
      const report = this.coverage.scan({
        orgId: orgIdOf(req),
        files: cleanFiles,
        root_path,
        agent_id,
      });
      if (this.audit) {
        this.audit.log({
          org_id:         orgIdOf(req),
          action:         'workflow.coverage' as any,
          resource_type:  'agent' as any,
          resource_id:    agent_id ?? null as any,
          user_id:        actorOf(req).user_id,
          user_email:     actorOf(req).user_email,
          ip_address:     actorOf(req).ip_address,
          details: {
            framework:            report.workflow.framework,
            files_scanned:        report.workflow.source.files_scanned,
            total_bindings:       report.summary.total_bindings,
            covered:              report.summary.covered,
            uncovered_blocker:    report.summary.uncovered_blocker,
            uncovered_warn:       report.summary.uncovered_warn,
            coverage_pct:         report.summary.coverage_pct,
            dead_rules_count:     report.summary.dead_rules.length,
            recommendations_count: report.recommendations.length,
          },
        });
      }
      res.json(report);
    } catch (err: any) {
      this.logger.error({ err: err?.message }, 'workflow coverage scan failed');
      res.status(500).json({ error: err?.message ?? 'internal error' });
    }
  }
}
