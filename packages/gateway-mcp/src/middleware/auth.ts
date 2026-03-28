import { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

// Routes that do NOT require authentication (SDK ingest + polling)
const OPEN_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET',  pattern: /^\/health$/ },
  { method: 'POST', pattern: /^\/api\/v1\/traces/ },
  { method: 'POST', pattern: /^\/api\/v1\/check$/ },
  { method: 'GET',  pattern: /^\/api\/v1\/check\/[^/]+\/decision$/ },
  { method: 'GET',  pattern: /^\/api\/v1\/auth\/key$/ },  // bootstrap endpoint
];

function isOpenRoute(method: string, path: string): boolean {
  return OPEN_ROUTES.some(r => r.method === method && r.pattern.test(path));
}

/** Extend Express Request to carry tenant context. */
declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      keyScopes?: string[];
      keyRateLimit?: number;
    }
  }
}

/**
 * Enterprise-ready auth middleware.
 *
 * Authentication flow:
 *   1. Check if route is public (open routes skip auth)
 *   2. Try org-scoped API key (aegis_... prefix) via org_api_keys table
 *   3. Fall back to legacy dashboard API key (backward compatible)
 *   4. Attach org_id to request for downstream tenant scoping
 */
export function createAuthMiddleware(db: Database.Database) {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (isOpenRoute(req.method, req.path)) return next();

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing X-API-Key header' });
    }

    // ── Try org-scoped API key first ──────────────────────────────────────
    if (apiKey.startsWith('aegis_')) {
      const hash = createHash('sha256').update(apiKey).digest('hex');
      const row = db.prepare(`
        SELECT id, org_id, scopes, rate_limit, expires_at, revoked_at
        FROM org_api_keys
        WHERE key_hash = ?
      `).get(hash) as any;

      if (row && !row.revoked_at) {
        const expired = row.expires_at && new Date(row.expires_at) < new Date();
        if (!expired) {
          req.orgId = row.org_id;
          req.keyScopes = JSON.parse(row.scopes);
          req.keyRateLimit = row.rate_limit;
          // Update last_used_at
          db.prepare('UPDATE org_api_keys SET last_used_at = datetime("now") WHERE id = ?').run(row.id);
          return next();
        }
      }
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    // ── Fall back to legacy dashboard key (backward compatible) ──────────
    const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
    if (row && apiKey === row.value) {
      req.orgId = 'default';
      req.keyScopes = ['*'];
      return next();
    }

    return res.status(401).json({ error: 'Invalid API key' });
  };
}
