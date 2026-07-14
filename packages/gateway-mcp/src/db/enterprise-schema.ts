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

  // ── SCIM 2.0 columns + groups (RFC 7644) ───────────────────────────────
  // external_id is the IdP-side stable identifier. It lets Okta / Azure AD
  // map their own user to our row across renames / email changes — without
  // this column we can't safely PATCH a SCIM resource.
  // given_name / family_name carry the structured-name fields IdPs send;
  // legacy `name` column stays as the display form for backwards compat.
  try { db.exec(`ALTER TABLE users ADD COLUMN external_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN given_name TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN family_name TEXT`); } catch { /* exists */ }
  // SCIM requires a per-org uniqueness guarantee on external_id (NULLs
  // are not constrained, which lets legacy non-SCIM rows coexist).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_extid ON users(org_id, external_id) WHERE external_id IS NOT NULL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      external_id TEXT,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      UNIQUE(org_id, display_name)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_scim_extid ON groups(org_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

    -- SCIM bearer tokens are issued per-org (typically one per IdP integration).
    -- Stored hashed; plaintext only emitted at create time.
    CREATE TABLE IF NOT EXISTS scim_tokens (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      revoked_at TEXT,
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_scim_tokens_org ON scim_tokens(org_id);
  `);

  // ── Sessions (SSO token store) ─────────────────────────────────────────────
  // Issued after a successful IdP callback (or local-password login if we
  // ever add one). Bearer tokens here grant access to authenticated REST
  // routes alongside the existing X-API-Key mechanism — both auth paths
  // co-exist so the SDK / CLI flow doesn't change for non-Cockpit users.
  // Tokens are stored hashed (sha256) so a DB dump doesn't leak active
  // sessions; the plaintext token is returned exactly once at issue time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      idp TEXT,                       -- 'workos' / 'okta' / 'mock' / null for local
      idp_sub TEXT,                   -- the IdP-side subject id, opaque to us
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
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

    -- ── Transparency log ────────────────────────────────────────────────────
    -- Append-only RFC 6962 Merkle log. Every audit row (and every evidence
    -- pack publication) appends here; the leaf at index N is hash(0x00||payload)
    -- where payload is the canonical JSON of the source record. Merkle root
    -- is computed on demand from leaves [0..tree_size) and signed with the
    -- gateway's Ed25519 evidence key, so customers can verify inclusion
    -- offline against a published signed root.
    CREATE TABLE IF NOT EXISTS transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tlog_source ON transparency_log(source, id);
    CREATE INDEX IF NOT EXISTS idx_tlog_org ON transparency_log(org_id, id);

    -- ── Agent registry ─────────────────────────────────────────────────────
    -- Stable, declared identity for every agent that talks to AEGIS. Until
    -- now agent_id was a free-form string anyone could pass; the registry
    -- promotes it to first-class identity with status machine, declared
    -- tool scope, per-agent budget overrides, optional secret/pubkey, and
    -- audit attribution strength.
    --
    -- Backward compat: first sighting of an unknown agent_id auto-inserts
    -- a row with status='unregistered' so existing customers don't break.
    -- Operators promote to 'active' by completing registration; suspended
    -- and deprecated agents are blocked at the middleware layer.
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      owner_email TEXT,
      declared_tools TEXT,             -- JSON array; null = no scope declared
      max_cost_daily_usd REAL,         -- null = inherit tenant budget
      environments TEXT,               -- JSON array of dev/staging/prod
      status TEXT NOT NULL DEFAULT 'unregistered',
      secret_hash TEXT,                -- SHA-256 of agent secret; null = no secret required
      public_key_pem TEXT,             -- Ed25519 pubkey if agent self-signs requests
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id, status);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // ── Org-scoped migration: add org_id to traces ─────────────────────────────
  const orgMigrations = [
    `ALTER TABLE traces ADD COLUMN org_id TEXT DEFAULT 'default'`,
    `CREATE INDEX IF NOT EXISTS idx_traces_org ON traces(org_id)`,
    // Agent registry capability + provenance extension (AEGIS Agent ID v1)
    `ALTER TABLE agents ADD COLUMN capabilities TEXT`,
    `ALTER TABLE agents ADD COLUMN provenance TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agents_spawned_by ON agents(json_extract(provenance, '$.spawned_by'))`,
    // Phase 1.2 · workflow-hash attestation binding. Nullable so
    // legacy agents that pre-date the workflow-anchored architecture
    // keep working unchanged; enforcement in authorize() is gated on
    // the row actually having a hash.
    `ALTER TABLE agents ADD COLUMN workflow_hash TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agents_workflow_hash ON agents(workflow_hash) WHERE workflow_hash IS NOT NULL`,
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
