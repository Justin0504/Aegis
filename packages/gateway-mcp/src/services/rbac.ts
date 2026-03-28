/**
 * RBAC — Role-Based Access Control for enterprise multi-tenancy.
 *
 * Roles:
 *   - owner:   Full access, can manage users and billing
 *   - admin:   Manage policies, approvals, agents, API keys
 *   - auditor: Read-only access to all data, can export reports
 *   - viewer:  Read-only access to dashboard and traces
 *
 * API keys are org-scoped and carry their own permission scopes.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID, createHash } from 'crypto';

export type Role = 'owner' | 'admin' | 'auditor' | 'viewer';

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner:   ['*'],
  admin:   ['policies.*', 'approvals.*', 'agents.*', 'apikeys.*', 'judge.*', 'webhooks.*', 'traces.read', 'stats.read', 'anomalies.read', 'export.*'],
  auditor: ['traces.read', 'policies.read', 'approvals.read', 'agents.read', 'stats.read', 'anomalies.read', 'judge.read', 'export.*', 'audit.read'],
  viewer:  ['traces.read', 'stats.read', 'anomalies.read', 'judge.read'],
};

export interface OrgUser {
  id: string;
  org_id: string;
  email: string;
  name: string | null;
  role: Role;
  status: string;
  created_at: string;
  last_login: string | null;
}

export interface OrgApiKey {
  id: string;
  org_id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  rate_limit: number;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class RBACService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  // ── API Key management ────────────────────────────────────────────────────

  /** Create an org-scoped API key. Returns the raw key (shown once). */
  createApiKey(orgId: string, opts: {
    name?: string;
    scopes?: string[];
    rateLimit?: number;
    expiresInDays?: number;
    createdBy?: string;
  } = {}): { key: string; keyId: string; prefix: string } {
    const keyId = randomUUID();
    const rawKey = `aegis_${randomUUID().replace(/-/g, '')}`;
    const prefix = rawKey.substring(0, 12);
    const hash = hashKey(rawKey);
    const expiresAt = opts.expiresInDays
      ? new Date(Date.now() + opts.expiresInDays * 86400000).toISOString()
      : null;

    this.db.prepare(`
      INSERT INTO org_api_keys (id, org_id, key_hash, key_prefix, name, scopes, rate_limit, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      keyId, orgId, hash, prefix,
      opts.name ?? 'Default',
      JSON.stringify(opts.scopes ?? ['*']),
      opts.rateLimit ?? 1000,
      opts.createdBy ?? null,
      expiresAt,
    );

    this.logger.info({ keyId, orgId, prefix }, 'API key created');
    return { key: rawKey, keyId, prefix };
  }

  /** Validate an API key. Returns org_id + scopes if valid. */
  validateApiKey(rawKey: string): {
    valid: boolean;
    org_id?: string;
    key_id?: string;
    scopes?: string[];
    rate_limit?: number;
  } {
    const hash = hashKey(rawKey);
    const row = this.db.prepare(`
      SELECT id, org_id, scopes, rate_limit, expires_at, revoked_at
      FROM org_api_keys
      WHERE key_hash = ?
    `).get(hash) as any;

    if (!row) return { valid: false };
    if (row.revoked_at) return { valid: false };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false };

    // Update last_used_at
    this.db.prepare('UPDATE org_api_keys SET last_used_at = datetime("now") WHERE id = ?').run(row.id);

    return {
      valid: true,
      org_id: row.org_id,
      key_id: row.id,
      scopes: JSON.parse(row.scopes),
      rate_limit: row.rate_limit,
    };
  }

  revokeApiKey(keyId: string): void {
    this.db.prepare('UPDATE org_api_keys SET revoked_at = datetime("now") WHERE id = ?').run(keyId);
  }

  listApiKeys(orgId: string): OrgApiKey[] {
    return this.db.prepare(`
      SELECT id, org_id, key_prefix, name, scopes, rate_limit, created_at, expires_at, last_used_at
      FROM org_api_keys
      WHERE org_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
    `).all(orgId) as any[];
  }

  // ── User management ───────────────────────────────────────────────────────

  createUser(orgId: string, email: string, role: Role, name?: string): OrgUser {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, org_id, email, name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, orgId, email, name ?? null, role);

    return this.getUser(id)!;
  }

  getUser(userId: string): OrgUser | null {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as OrgUser | null;
  }

  getUserByEmail(orgId: string, email: string): OrgUser | null {
    return this.db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) as OrgUser | null;
  }

  listUsers(orgId: string): OrgUser[] {
    return this.db.prepare(
      'SELECT * FROM users WHERE org_id = ? AND status = ? ORDER BY created_at DESC'
    ).all(orgId, 'active') as OrgUser[];
  }

  updateUserRole(userId: string, role: Role): void {
    this.db.prepare('UPDATE users SET role = ?, updated_at = datetime("now") WHERE id = ?').run(role, userId);
  }

  deactivateUser(userId: string): void {
    this.db.prepare('UPDATE users SET status = ?, updated_at = datetime("now") WHERE id = ?').run('deactivated', userId);
  }

  // ── Permission check ──────────────────────────────────────────────────────

  hasPermission(role: Role, requiredScope: string): boolean {
    const perms = ROLE_PERMISSIONS[role];
    if (!perms) return false;
    if (perms.includes('*')) return true;

    return perms.some(p => {
      if (p === requiredScope) return true;
      // Wildcard match: 'policies.*' matches 'policies.read', 'policies.create', etc.
      if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        return requiredScope.startsWith(prefix + '.');
      }
      return false;
    });
  }

  // ── Organization management ────────────────────────────────────────────────

  createOrg(name: string, slug: string, plan: string = 'free'): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO organizations (id, name, slug, plan) VALUES (?, ?, ?, ?)
    `).run(id, name, slug, plan);
    return id;
  }

  getOrg(orgId: string): any {
    return this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  }

  listOrgs(): any[] {
    return this.db.prepare('SELECT * FROM organizations ORDER BY created_at DESC').all();
  }

  updateOrgPlan(orgId: string, plan: string): void {
    this.db.prepare('UPDATE organizations SET plan = ?, updated_at = datetime("now") WHERE id = ?').run(plan, orgId);
  }

  updateOrgSettings(orgId: string, settings: Record<string, any>): void {
    this.db.prepare('UPDATE organizations SET settings = ?, updated_at = datetime("now") WHERE id = ?')
      .run(JSON.stringify(settings), orgId);
  }
}
