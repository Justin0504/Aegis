/**
 * License API — Cockpit ↔ gateway hand-off surface.
 *
 * Endpoints:
 *   POST /api/v1/license/activate   { license_key }  → snapshot
 *   GET  /api/v1/license/status                       → snapshot
 *   POST /api/v1/license/deactivate                   → { ok: true }
 *
 * Every endpoint returns the same LicenseSnapshot shape so the
 * Cockpit's useGatewayLicense hook can render its chip + upsell
 * copy from a single source of truth.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import { LicenseService } from '../services/license-service';

export class LicenseAPI {
  public readonly router: Router;

  constructor(private license: LicenseService, private logger: Logger) {
    this.router = Router();
    this.setup();
  }

  private setup() {
    this.router.get('/status', (_req: Request, res: Response) => {
      res.json(this.license.snapshot());
    });

    this.router.post('/activate', async (req: Request, res: Response) => {
      const key = String(req.body?.license_key ?? '').trim();
      if (!key) return res.status(400).json({ error: 'license_key required' });
      try {
        const snap = await this.license.activate(key);
        res.json(snap);
      } catch (err) {
        const msg = (err as Error).message;
        const status = /must start with AEGIS-/i.test(msg) ? 400 : 502;
        this.logger.warn({ err: msg }, 'license activate failed');
        res.status(status).json({ error: msg });
      }
    });

    this.router.post('/deactivate', (_req: Request, res: Response) => {
      this.license.deactivate();
      res.json({ ok: true });
    });
  }
}
