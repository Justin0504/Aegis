/**
 * Enterprise schema — multi-tenancy, RBAC, audit log, retention, usage metering.
 *
 * Called once during database initialization to create enterprise tables
 * and run migrations for existing installations.
 */

import Database from 'better-sqlite3';

export function initializeEnterpriseSchema(db: Database.Database): void {
  // ── Organizations (tenants) ────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Users + RBAC ───────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      password_hash TEXT,
      last_login TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      UNIQUE(org_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  // ── Org-scoped API keys (replace single shared key) ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_api_keys (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Default',
      scopes TEXT NOT NULL DEFAULT '["*"]',
      rate_limit INTEGER DEFAULT 1000,
      created_by TEXT,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_org_keys_org ON org_api_keys(org_id);
    CREATE INDEX IF NOT EXISTS idx_org_keys_hash ON org_api_keys(key_hash);
  `);

  // ── Admin audit log ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT,
      user_id TEXT,
      user_email TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org ON admin_audit_log(org_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit_log(created_at);
  `);

  // ── Data retention policies ────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_policies (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      resource_type TEXT NOT NULL,
      retention_days INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_purge_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );
  `);

  // ── Usage metering ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      period TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, period, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_org_period ON usage_records(org_id, period);
  `);

  // ── SLA metrics ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sla_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT,
      period TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      p50_ms REAL DEFAULT 0,
      p95_ms REAL DEFAULT 0,
      p99_ms REAL DEFAULT 0,
      avg_ms REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, period, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_sla_period ON sla_metrics(period);
  `);

  // ── Org-scoped migration: add org_id to traces ─────────────────────────────
  const orgMigrations = [
    `ALTER TABLE traces ADD COLUMN org_id TEXT DEFAULT 'default'`,
    `CREATE INDEX IF NOT EXISTS idx_traces_org ON traces(org_id)`,
  ];

  for (const sql of orgMigrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // ── Seed default organization ──────────────────────────────────────────────
  const existingOrg = db.prepare('SELECT id FROM organizations WHERE id = ?').get('default');
  if (!existingOrg) {
    db.prepare(`
      INSERT INTO organizations (id, name, slug, plan) VALUES (?, ?, ?, ?)
    `).run('default', 'Default Organization', 'default', 'enterprise');
  }

  // ── Seed default retention policies ────────────────────────────────────────
  const existingRetention = db.prepare('SELECT id FROM retention_policies WHERE id = ?').get('default-traces');
  if (!existingRetention) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO retention_policies (id, org_id, resource_type, retention_days)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run('default-traces', null, 'traces', 90);
    stmt.run('default-violations', null, 'violations', 180);
    stmt.run('default-audit-log', null, 'admin_audit_log', 365);
    stmt.run('default-anomaly-events', null, 'anomaly_events', 90);
    stmt.run('default-judge-verdicts', null, 'judge_verdicts', 180);
  }
}
