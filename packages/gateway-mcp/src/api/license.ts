/**
 * License API — Cockpit ↔ gateway hand-off surface.
 *
 * Endpoints:
 *   POST /api/v1/license/activate       { license_key }  → snapshot
 *   GET  /api/v1/license/status                           → snapshot
 *   POST /api/v1/license/deactivate                       → { ok: true }
 *   POST /api/v1/license/link-start                       → { nonce, url }
 *   GET  /api/v1/license/link-callback ?license_key&nonce → HTML success page
 *
 * The link-* pair implements the 360-style "Sign in with your AEGIS
 * account" flow: Cockpit calls link-start to mint a one-time nonce,
 * opens the returned marketing URL in the user's browser, the user
 * signs in on aegistraces.com with Google/GitHub/email, marketing
 * looks up their active license_key and redirects the browser back
 * to link-callback with (license_key, nonce). The callback activates
 * the license and returns a self-closing HTML page. Cockpit polls
 * /status while the browser is open — as soon as the tier flips,
 * the UI drops the "Signing in…" state.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Logger } from 'pino';
import { LicenseService } from '../services/license-service';

const LINK_NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to sign in with 2FA, short enough to matter
const LINK_HOST_DEFAULT = 'https://aegistraces.com';

export class LicenseAPI {
  public readonly router: Router;
  private readonly nonces = new Map<string, number>(); // nonce → expiresAt

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

    // Mint a one-time nonce + return the browser URL to open. Cockpit
    // then hands the URL to the OS default browser (via Tauri shell
    // plugin) and polls /status until the callback fires.
    this.router.post('/link-start', (req: Request, res: Response) => {
      const nonce = randomBytes(24).toString('base64url');
      const expires = Date.now() + LINK_NONCE_TTL_MS;
      this.nonces.set(nonce, expires);
      this.gcNonces();

      // Callback goes back to THIS gateway on 127.0.0.1 — never to
      // Cockpit — because the gateway is the process that owns the
      // license_state DB.
      const port = Number(process.env.PORT ?? 18080);
      const callback = `http://127.0.0.1:${port}/api/v1/license/link-callback`;
      const host = process.env.AEGIS_LINK_HOST ?? LINK_HOST_DEFAULT;
      const url = `${host}/desktop/link?callback=${encodeURIComponent(callback)}&nonce=${encodeURIComponent(nonce)}`;
      res.json({ nonce, url, expires_at: new Date(expires).toISOString() });
    });

    // Marketing site redirects the user's browser here after sign-in.
    // Response is a plain HTML page that says "you can close this
    // tab" and tries to close itself (works on some browsers, no-op
    // on others — the user can always close manually).
    this.router.get('/link-callback', async (req: Request, res: Response) => {
      const key = String(req.query.license_key ?? '').trim();
      const nonce = String(req.query.nonce ?? '').trim();
      const err = String(req.query.error ?? '').trim();

      if (err) return res.status(400).type('html').send(pageError(err));
      if (!key || !nonce) return res.status(400).type('html').send(pageError('missing license_key or nonce'));

      const exp = this.nonces.get(nonce);
      if (!exp || exp < Date.now()) {
        this.nonces.delete(nonce);
        return res.status(400).type('html').send(pageError('sign-in nonce expired or unknown — start again from Cockpit'));
      }
      this.nonces.delete(nonce);

      try {
        const snap = await this.license.activate(key);
        res.type('html').send(pageSuccess(snap.plan ?? snap.tier, snap.email));
      } catch (e) {
        this.logger.warn({ err: (e as Error).message }, 'link-callback activation failed');
        res.status(502).type('html').send(pageError((e as Error).message));
      }
    });
  }

  private gcNonces() {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
  }
}

const CSS = `
  :root { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, "SF Pro Text", "Segoe UI", sans-serif;
         background: hsl(42 45% 91%); color: hsl(20 15% 20%);
         display: grid; place-items: center; min-height: 100vh; }
  .card { max-width: 420px; padding: 32px; text-align: center;
          background: white; border-radius: 12px;
          box-shadow: 0 8px 24px rgba(40, 30, 20, 0.08); }
  h1 { margin: 0 0 8px; font-family: "Instrument Serif", Georgia, serif;
       font-size: 28px; font-weight: 400; }
  p  { margin: 8px 0; color: hsl(20 10% 40%); font-size: 14px; line-height: 1.5; }
  .tag { display: inline-block; margin-top: 12px; padding: 4px 10px;
         border-radius: 999px; font-size: 12px; font-weight: 500;
         text-transform: uppercase; letter-spacing: 0.05em; }
  .ok  { background: hsl(150 30% 92%); color: hsl(150 30% 30%); }
  .bad { background: hsl(0 28% 92%);   color: hsl(0 42% 35%); }
`;

function pageSuccess(plan: string, email: string | null): string {
  const safePlan = escapeHtml(plan.toUpperCase());
  const safeEmail = email ? escapeHtml(email) : 'this device';
  return `<!doctype html><html><head><meta charset="utf-8"><title>AEGIS · signed in</title>
<style>${CSS}</style></head>
<body><div class="card">
  <h1>You're signed in</h1>
  <p>${safeEmail} is now linked to this AEGIS install.</p>
  <span class="tag ok">${safePlan} tier active</span>
  <p style="margin-top:20px;font-size:12px;">You can close this tab and return to Cockpit.</p>
</div>
<script>setTimeout(function(){try{window.close()}catch(e){}}, 1500);</script>
</body></html>`;
}

function pageError(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AEGIS · sign-in failed</title>
<style>${CSS}</style></head>
<body><div class="card">
  <h1>Sign-in failed</h1>
  <p>${escapeHtml(msg)}</p>
  <span class="tag bad">Not activated</span>
  <p style="margin-top:20px;font-size:12px;">Close this tab and try again from Cockpit → Settings.</p>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as any)[c]);
}
