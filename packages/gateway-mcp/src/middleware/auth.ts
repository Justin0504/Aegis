import { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import pino from 'pino';

const logger = pino({ name: 'auth' });

// Routes that do NOT require authentication (SDK ingest + polling)
const OPEN_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET',  pattern: /^\/health$/ },
  { method: 'GET',  pattern: /^\/api\/v1\/health$/ },
  // SSO bootstrap — the whole point is letting an unauthenticated
  // browser kick off a login. /me + /logout still require Bearer.
  { method: 'GET',  pattern: /^\/api\/v1\/auth\/login-url$/ },
  { method: 'POST', pattern: /^\/api\/v1\/auth\/callback$/ },
  // SDK ingest paths — open by design (SDKs pin identity via x-api-key,
  // which the trace-ingest handler resolves via ingestOrgId). Restricted
  // to the two actual ingest routes so /search, /saved-queries, and
  // /stats/cost fall through to normal auth + orgId scoping.
  { method: 'POST', pattern: /^\/api\/v1\/traces\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/traces\/batch\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/check$/ },
  { method: 'GET',  pattern: /^\/api\/v1\/check\/[^/]+\/decision$/ },
  { method: 'GET',  pattern: /^\/api\/v1\/auth\/key$/ },  // bootstrap endpoint
];

function isOpenRoute(method: string, path: string): boolean {
  return OPEN_ROUTES.some(r => r.method === method && r.pattern.test(path));
}

/**
 * Compute the URL path a caller actually hit, regardless of whether
 * `requireAuth` was mounted at the app root (`req.path` is the full
 * path) or scoped to a subpath (`req.path` is stripped of the mount
 * prefix — e.g. inside `app.use('/api/v1/traces', requireAuth, ...)`
 * a request to `/api/v1/traces` shows up as `req.path === '/'`).
 * `req.originalUrl` preserves the full URL in both cases.
 */
function effectivePath(req: Request): string {
  const orig = req.originalUrl || req.url || req.path;
  const q = orig.indexOf('?');
  return q < 0 ? orig : orig.slice(0, q);
}

/** Extend Express Request to carry tenant context. */
declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      keyScopes?: string[];
      keyRateLimit?: number;
      /** Human-readable name from org_api_keys.name; populated by auth middleware. */
      keyName?: string;
      /** First 12 chars of the API key for audit-trail attribution. */
      keyPrefix?: string;
      /** Authenticated user, populated when a valid Bearer session is presented. */
      sessionUser?: {
        id: string;
        email: string;
        name: string | null;
        role: string;
        org_id: string;
      };
    }
  }
}

/**
 * Build the (user_email, user_id) pair the audit log expects.
 *
 * Preference order:
 *   1. Session user (set by the Bearer-token branch) — a real human
 *      with email + db id, populated post-SSO. This is the SOC 2
 *      gold standard.
 *   2. API key name + prefix ("default-key (aegis_a1b2c3…)") — the
 *      service-account attribution we've used since round 45. Still
 *      auditable: an auditor can revoke that key and the trail tells
 *      them which key did what.
 *   3. {} when neither is set (open routes / legacy bootstrap) —
 *      audit row stays null on those columns.
 */
export function auditActor(req: Request): { user_email?: string; user_id?: string } {
  if (req.sessionUser) {
    return { user_email: req.sessionUser.email, user_id: req.sessionUser.id };
  }
  const name = req.keyName;
  const prefix = req.keyPrefix;
  if (!name && !prefix) return {};
  const formatted = name && prefix
    ? `${name} (${prefix})`
    : (name ?? prefix);
  return {
    user_email: formatted,
    user_id: prefix,  // stable id when the name gets renamed
  };
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
    if (isOpenRoute(req.method, effectivePath(req))) return next();

    // ── Try Authorization: Bearer session token first ────────────────────
    // Sessions are the human-channel auth (post-SSO); API keys remain the
    // service-account channel. Either one passes — the Bearer path is just
    // tried first so a browser presenting both ends up with the user
    // attribution instead of the key attribution on audit rows.
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      if (token) {
        try {
          const tokenHash = createHash('sha256').update(token).digest('hex');
          const sessRow = db.prepare(
            `SELECT s.id, s.expires_at, s.revoked_at,
                    u.id as user_id, u.email, u.name, u.role, u.org_id, u.status
             FROM user_sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?`,
          ).get(tokenHash) as any;
          if (
            sessRow
            && !sessRow.revoked_at
            && new Date(sessRow.expires_at) > new Date()
            && sessRow.status === 'active'
          ) {
            req.orgId = sessRow.org_id;
            req.sessionUser = {
              id: sessRow.user_id,
              email: sessRow.email,
              name: sessRow.name ?? null,
              role: sessRow.role,
              org_id: sessRow.org_id,
            };
            // Touch last_seen — non-fatal on failure.
            try {
              db.prepare(
                `UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?`,
              ).run(sessRow.id);
            } catch { /* keep going */ }
            return next();
          }
        } catch (err) {
          logger.warn({ err, path: req.path }, 'session lookup failed');
        }
      }
      // Fall through — invalid Bearer doesn't auto-reject if there's
      // also a valid X-API-Key on the request.
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey) {
      logger.warn({ path: req.path, ip: req.ip, req_id: req.requestId }, 'Missing API key');
      return res.status(401).json({ error: { code: 'AUTH_MISSING', message: 'Missing X-API-Key header or Authorization: Bearer token' } });
    }

    // ── Try org-scoped API key first ──────────────────────────────────────
    if (apiKey.startsWith('aegis_')) {
      const hash = createHash('sha256').update(apiKey).digest('hex');
      const row = db.prepare(`
        SELECT id, org_id, name, key_prefix, scopes, rate_limit, expires_at, revoked_at
        FROM org_api_keys
        WHERE key_hash = ?
      `).get(hash) as any;

      if (row && !row.revoked_at) {
        const expired = row.expires_at && new Date(row.expires_at) < new Date();
        if (!expired) {
          req.orgId = row.org_id;
          req.keyScopes = JSON.parse(row.scopes);
          req.keyRateLimit = row.rate_limit;
          req.keyName = row.name;
          req.keyPrefix = row.key_prefix;
          // Update last_used_at
          // SINGLE quotes around 'now' — double-quoted 'now' is a
          // column reference in SQLite's strict mode and 500s.
          db.prepare(`UPDATE org_api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
          return next();
        }
      }
      logger.warn({ path: req.path, ip: req.ip, req_id: req.requestId }, 'Invalid or expired org API key');
      return res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Invalid or expired API key' } });
    }

    // ── Fall back to legacy dashboard key (backward compatible) ──────────
    const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
    if (row && apiKey === row.value) {
      req.orgId = 'default';
      req.keyScopes = ['*'];
      // Legacy dashboard key — attribute as "dashboard" so audit
      // rows show *something* instead of null.
      req.keyName = 'dashboard';
      req.keyPrefix = apiKey.slice(0, 8);
      return next();
    }

    logger.warn({ path: req.path, ip: req.ip, req_id: req.requestId }, 'Invalid API key');
    return res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Invalid API key' } });
  };
}
