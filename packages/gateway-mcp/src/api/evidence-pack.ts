/**
 * Evidence-pack REST endpoint.
 *
 *   GET /api/v1/evidence-pack/export
 *
 * Returns a downloadable JSON file. Honours the requester's orgId
 * (set by the auth middleware) so a multi-tenant deployment can't
 * cross-pull other orgs' audit data. Filename includes the org id
 * and the generation timestamp so auditors can drop multiple packs
 * into one folder without collisions.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { EvidencePackService } from '../services/evidence-pack';
export { EvidencePackService };
import { EuAiActEvidenceService } from '../services/eu-ai-act-evidence';
import { AuditLogService } from '../services/audit-log';
import { auditActor } from '../middleware/auth';

export class EvidencePackAPI {
  public router: Router;
  private svc: EvidencePackService;
  private eu: EuAiActEvidenceService;

  constructor(
    db: Database.Database,
    private logger: Logger,
    private auditLog: AuditLogService,
  ) {
    this.router = Router();
    this.svc = new EvidencePackService(db, logger);
    this.eu = new EuAiActEvidenceService(db, logger);

    /** GET /public-key → key_id + PEM. Auditors can fetch this
     *  out-of-band to compare against the bundled pubkey. No
     *  org scoping; the signing identity is gateway-wide. */
    this.router.get('/public-key', (_req: Request, res: Response) => {
      try {
        res.json(this.svc.getPublicKey());
      } catch (err) {
        this.logger.error({ err }, 'evidence-pack public-key fetch failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    /** POST /verify → { ok: boolean } over a pack object posted in
     *  the body. Server-side check uses the gateway's own canonical
     *  form so an auditor running against this endpoint gets the
     *  same answer as the offline CLI. */
    this.router.post('/verify', (req: Request, res: Response) => {
      try {
        const pack = req.body;
        if (!pack || typeof pack !== 'object') {
          return res.status(400).json({ error: 'pack body must be an object' });
        }
        const ok = EvidencePackService.verify(pack);
        res.json({ ok });
      } catch (err) {
        this.logger.error({ err }, 'evidence-pack verify failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.router.get('/export', (req: Request, res: Response) => {
      const orgId = (req as any).orgId ?? 'default';
      try {
        const pack = this.svc.build(orgId);

        // Exporting evidence is itself an auditable action — record it
        // so a chain-of-custody question can be answered later.
        this.auditLog.log({
          org_id: orgId,
          ...auditActor(req),
          action: 'judge.trace',
          resource_type: 'system',
          resource_id: 'evidence-pack',
          details: {
            kind: 'evidence_pack_export',
            audit_rows: pack.audit_log.length,
            agent_count: pack.integrity.total_agents,
            broken_agents: pack.integrity.broken_agents,
          },
          ip_address: req.ip,
        });

        const fname = `aegis-evidence-${orgId}-${pack.meta.generated_at.replace(/[:.]/g, '-')}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(JSON.stringify(pack, null, 2));
      } catch (err) {
        this.logger.error({ err, orgId }, 'evidence-pack export failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // ── EU AI Act Article 12-15 evidence pack ────────────────────────
    // Article-by-article evidence document with a per-article
    // compliance floor and gap list. High-risk-system obligations
    // take effect 2026-08-02. See services/eu-ai-act-evidence.ts.

    /** GET /eu-ai-act/export?window_days=90
     *  Returns a signed article-by-article evidence pack scoped to
     *  the caller's org. Auditor's downloadable artifact. */
    this.router.get('/eu-ai-act/export', (req: Request, res: Response) => {
      const orgId = (req as any).orgId ?? 'default';
      const windowDaysRaw = req.query.window_days;
      const windowDays = windowDaysRaw != null ? Number(windowDaysRaw) : undefined;
      if (windowDays != null && (!Number.isFinite(windowDays) || windowDays <= 0)) {
        return res.status(400).json({ error: 'window_days must be a positive integer' });
      }
      try {
        const pack = this.eu.build(orgId, { reportingWindowDays: windowDays });

        this.auditLog.log({
          org_id: orgId,
          ...auditActor(req),
          action: 'judge.trace',
          resource_type: 'system',
          resource_id: 'eu-ai-act-evidence-pack',
          details: {
            kind: 'eu_ai_act_evidence_pack_export',
            compliant: pack.compliant,
            window_days: pack.meta.reporting_window_days,
            gap_count: pack.articles.reduce((n, a) => n + a.gaps.length, 0),
          },
          ip_address: req.ip,
        });

        const fname = `aegis-eu-ai-act-${orgId}-${pack.meta.generated_at.replace(/[:.]/g, '-')}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.send(JSON.stringify(pack, null, 2));
      } catch (err) {
        this.logger.error({ err, orgId }, 'eu-ai-act evidence-pack export failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    /** POST /eu-ai-act/verify → { ok } over a posted pack. Same
     *  signing key as the SOC 2 evidence-pack /verify; auditors
     *  can use either endpoint interchangeably. */
    this.router.post('/eu-ai-act/verify', (req: Request, res: Response) => {
      try {
        const pack = req.body;
        if (!pack || typeof pack !== 'object') {
          return res.status(400).json({ error: 'pack body must be an object' });
        }
        const ok = EuAiActEvidenceService.verify(pack);
        res.json({ ok });
      } catch (err) {
        this.logger.error({ err }, 'eu-ai-act evidence-pack verify failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
