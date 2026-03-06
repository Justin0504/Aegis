import { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';

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

export function createAuthMiddleware(db: Database.Database) {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (isOpenRoute(req.method, req.path)) return next();

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing X-API-Key header' });
    }

    const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
    if (!row || apiKey !== row.value) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    next();
  };
}
