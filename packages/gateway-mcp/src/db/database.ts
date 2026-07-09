import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

export function getOrCreateDashboardKey(db: Database.Database): string {
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
  if (row) return row.value;
  const key = randomUUID();
  db.prepare('INSERT INTO gateway_config (key, value) VALUES (?, ?)').run('dashboard_api_key', key);
  return key;
}

export interface TraceRecord {
  id: string;
  trace_id: string;
  parent_trace_id?: string;
  agent_id: string;
  timestamp: string;
  sequence_number: number;
  input_context: string;
  thought_chain: string;
  tool_call: string;
  observation: string;
  integrity_hash: string;
  previous_hash?: string;
  signature?: string;
  safety_validation?: string;
  approval_status?: string;
  approved_by?: string;
  environment: string;
  version: string;
  tags?: string;
  created_at: string;
}

export interface PolicyRecord {
  id: string;
  name: string;
  description: string;
  policy_schema: string;
  risk_level: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ViolationRecord {
  id: string;
  agent_id: string;
  policy_id: string;
  trace_id: string;
  violation_type: string;
  details: string;
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  trace_id: string;
  agent_id: string;
  tool_name: string;
  risk_level: string;
  status: string;
  approver?: string;
  approved_at?: string;
  rejection_reason?: string;
  created_at: string;
  expires_at: string;
}

export async function initializeDatabase(dbPath: string): Promise<Database.Database> {
  const db = new Database(dbPath);

  // ── Production SQLite pragmas ──────────────────────────────────────────────
  db.pragma('journal_mode = WAL');        // Write-Ahead Logging: concurrent reads + writes
  db.pragma('busy_timeout = 5000');       // Wait up to 5s on lock instead of failing
  db.pragma('synchronous = NORMAL');      // Safe with WAL, 2x faster than FULL
  db.pragma('cache_size = -64000');       // 64MB page cache (negative = KB)
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');       // Keep temp tables in RAM

  // Create tables
  db.exec(`
    -- Traces table
    --
    -- delegation_id / parent_delegation_id are the agent-aware
    -- observability substrate from Toledo et al. arXiv:2606.09692
    -- ("Observability for Delegated Execution in Agentic AI Systems").
    -- parent_trace_id alone is structurally underdetermined for
    -- delegation-scoped attribution: two incompatible delegation
    -- trees can produce identical parent chains. delegation_id binds
    -- the semantic delegation context at execution time so forensic
    -- queries ("all actions under delegation X") don't fall back on
    -- heuristic time-window correlation.
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      parent_trace_id TEXT,
      delegation_id TEXT,
      parent_delegation_id TEXT,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      input_context TEXT NOT NULL,
      thought_chain TEXT NOT NULL,
      tool_call TEXT NOT NULL,
      observation TEXT NOT NULL,
      integrity_hash TEXT NOT NULL,
      previous_hash TEXT,
      signature TEXT,
      safety_validation TEXT,
      approval_status TEXT,
      approved_by TEXT,
      environment TEXT NOT NULL,
      version TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_id ON traces (agent_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON traces (timestamp);
    CREATE INDEX IF NOT EXISTS idx_parent_trace ON traces (parent_trace_id);
    CREATE INDEX IF NOT EXISTS idx_approval_status ON traces (approval_status);

    -- Policies table
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      policy_schema TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Violations table
    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      violation_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (policy_id) REFERENCES policies(id),
      FOREIGN KEY (trace_id) REFERENCES traces(trace_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_violations ON violations (agent_id, created_at);

    -- Approvals table
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      trace_id TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      approver TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (trace_id) REFERENCES traces(trace_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals ON approvals (status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_agent_approvals ON approvals (agent_id, status);

    -- API keys table (for kill switch)
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT UNIQUE NOT NULL,
      key_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      revoked_at TEXT,
      revocation_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Insert default policies (OR REPLACE so broken schemas from old installs get fixed)
    INSERT OR REPLACE INTO policies (id, name, description, policy_schema, risk_level) VALUES
    ('sql-injection', 'SQL Injection Prevention', 'Blocks destructive SQL operations: DROP, DELETE, TRUNCATE, EXEC on database tool calls.',
     '{"type":"object","properties":{"sql":{"type":"string","not":{"pattern":"(DROP|DELETE|TRUNCATE|EXEC|ALTER|CREATE|INSERT)"}}},"additionalProperties":true}',
     'HIGH'),
    ('file-access', 'File Access Control', 'Prevents path traversal attacks and access to sensitive system directories.',
     '{"type":"object","properties":{"path":{"type":"string","not":{"pattern":"([.][.]/|/etc/|/root/|/proc/)"}}},"additionalProperties":true}',
     'MEDIUM'),
    ('network-access', 'Network Access Control', 'Enforces HTTPS-only outbound network requests to prevent plaintext data transmission.',
     '{"type":"object","properties":{"url":{"type":"string","pattern":"^https://"}},"additionalProperties":true}',
     'MEDIUM'),
    ('prompt-injection', 'Prompt Injection Detection', 'Detects and blocks prompt injection attempts in agent inputs that try to override system instructions.',
     '{"type":"object","properties":{"query":{"type":"string","not":{"pattern":"ignore previous|ignore above|disregard all|you are now|act as if"}},"prompt":{"type":"string","not":{"pattern":"ignore previous|ignore above|disregard all|you are now|act as if"}}},"additionalProperties":true}',
     'CRITICAL'),
    ('data-exfiltration', 'Data Exfiltration Prevention', 'Blocks tool calls that attempt to send large volumes of data to external endpoints.',
     '{"type":"object","properties":{"body":{"type":"string","maxLength":10000},"data":{"type":"string","maxLength":10000},"content":{"type":"string","maxLength":10000}},"additionalProperties":true}',
     'HIGH'),
    ('source-map-leak', 'Source Map Leak Prevention', 'Blocks publishing operations when source map files (.map) may be included. Source maps contain raw source code, internal constants, system prompts, and secrets.',
     '{"type":"object","properties":{"cmd":{"type":"string","not":{"pattern":"npm publish|yarn publish|pnpm publish"}},"command":{"type":"string","not":{"pattern":"npm publish|yarn publish|pnpm publish"}}},"additionalProperties":true}',
     'HIGH'),
    ('supply-chain', 'Supply Chain Security', 'Requires human approval for all package publish, container push, and deployment operations to prevent accidental leaks of secrets, source maps, or internal code.',
     '{"type":"object","properties":{"command":{"type":"string","not":{"pattern":"npm publish|docker push|twine upload|cargo publish|helm install|kubectl apply|terraform apply"}}},"additionalProperties":true}',
     'HIGH');
  `);

  // ── Migrations: add columns to existing DBs (SQLite ignores IF NOT EXISTS for ALTER) ──
  const migrations = [
    // Token cost tracking (P1.A)
    `ALTER TABLE traces ADD COLUMN model TEXT`,
    `ALTER TABLE traces ADD COLUMN input_tokens INTEGER DEFAULT 0`,
    `ALTER TABLE traces ADD COLUMN output_tokens INTEGER DEFAULT 0`,
    `ALTER TABLE traces ADD COLUMN cost_usd REAL DEFAULT 0`,
    // Evaluation / scoring (P1.B)
    `ALTER TABLE traces ADD COLUMN score INTEGER`,
    `ALTER TABLE traces ADD COLUMN score_label TEXT`,
    `ALTER TABLE traces ADD COLUMN feedback TEXT`,
    `ALTER TABLE traces ADD COLUMN scored_by TEXT`,
    `ALTER TABLE traces ADD COLUMN scored_at TEXT`,
    // Session tracking (P1.C)
    `ALTER TABLE traces ADD COLUMN session_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_session_id ON traces (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_model ON traces (model)`,
    `ALTER TABLE traces ADD COLUMN pii_detected INTEGER DEFAULT 0`,
    // Tool classifier (Step 1 — category + risk signals)
    `ALTER TABLE traces ADD COLUMN tool_category TEXT`,
    `ALTER TABLE traces ADD COLUMN risk_signals TEXT`,
    // Blocking mode (Step 3 — pending check)
    `ALTER TABLE traces ADD COLUMN blocked INTEGER DEFAULT 0`,
    `ALTER TABLE traces ADD COLUMN block_reason TEXT`,
    // Anomaly detection
    `ALTER TABLE traces ADD COLUMN anomaly_score REAL DEFAULT 0`,
    `ALTER TABLE traces ADD COLUMN anomaly_signals TEXT`,
    // v0.4: post-redaction content hash for single-row tamper detection.
    // SDK's integrity_hash is computed pre-redaction so the gateway can't
    // independently verify it; this column is SHA-256 of the canonical
    // serialization of the four content fields *as stored*, computed at
    // INSERT time. IntegrityService recomputes it at verify time and
    // flags any mismatch as content_tamper.
    `ALTER TABLE traces ADD COLUMN content_hash TEXT`,
    // Delegation lineage. These are declared in the CREATE TABLE above,
    // but SQLite's `CREATE TABLE IF NOT EXISTS` is a no-op on pre-existing
    // tables, so any DB created before this column was added stays without
    // it and the CREATE INDEX at the bottom of the schema block explodes.
    // ALTER-add here is idempotent (wrapped in try/catch below).
    `ALTER TABLE traces ADD COLUMN delegation_id TEXT`,
    `ALTER TABLE traces ADD COLUMN parent_delegation_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_delegation ON traces (delegation_id)`,
    // ── B2B multi-tenant: policies per org ───────────────────────────
    // Existing rows are the 7 platform-default policies; they get
    // org_id='*' which the engine treats as "applies to every tenant
    // unless they explicitly override by (org_id=<theirs>, name=...)".
    //
    // The 'default' org_id (non-asterisk) is for SINGLE-tenant
    // deployments where the gateway sees `req.orgId === 'default'`
    // everywhere — the engine still matches because '*' wildcards
    // through. The wildcard semantics give us zero-config behaviour
    // for solo deploys AND tenant-isolated policies for SaaS use,
    // from the same schema. (See PolicyEngine.loadOrgPolicies.)
    `ALTER TABLE policies ADD COLUMN org_id TEXT NOT NULL DEFAULT '*'`,
    `CREATE INDEX IF NOT EXISTS idx_policies_org ON policies (org_id, enabled)`,
    // ── Generated columns for indexable JSON paths (Round 4b · search perf) ──
    // The DSL search compiler was emitting json_extract(tool_call, '$.tool_name')
    // and json_extract(safety_validation, '$.risk_level') inline. SQLite's
    // planner cannot use an index across the extract, so every filter on
    // these dropped to a full-table scan (25k rows → p95 690ms at 50 VUs
    // per PERFORMANCE.md). Virtual generated columns give the planner a
    // handle it CAN index — same JSON path, no storage cost, evaluated on
    // the fly at read time. STORED would save read time but doubles write
    // cost and forces a full backfill on migration; VIRTUAL is the right
    // tradeoff for an audit-log workload where writes dominate.
    `ALTER TABLE traces ADD COLUMN tool_name_v TEXT
        GENERATED ALWAYS AS (json_extract(tool_call, '$.tool_name')) VIRTUAL`,
    `ALTER TABLE traces ADD COLUMN risk_level_v TEXT
        GENERATED ALWAYS AS (json_extract(safety_validation, '$.risk_level')) VIRTUAL`,
    // Composite indexes leading with the extracted field + timestamp DESC.
    // Matches the DSL compiler's ORDER BY traces.timestamp DESC — the
    // planner walks the index in reverse without a TEMP B-TREE sort.
    `CREATE INDEX IF NOT EXISTS idx_tool_name_ts  ON traces (tool_name_v, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_risk_level_ts ON traces (risk_level_v, timestamp DESC)`,
  ];

  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }

  // ── Full-text search over traces (Round 3 · Trace query DSL) ─────
  // FTS5 external-content table shadowing `traces`. Indexed columns
  // are the ones users actually free-text-search: the prompt, the
  // tool name, the tool arguments blob, and the observation output.
  //
  // Triggers keep the index in sync on INSERT/UPDATE/DELETE. Backfill
  // runs once on schema creation (idempotent because FTS5 dedupes on
  // rowid). The `content_rowid = 'id'` link means FTS rows share the
  // traces.id primary key — a JOIN on `traces_fts.rowid = traces.id`
  // works out of the box.
  //
  // Cost: ~30-40% storage overhead on top of the traces table, but
  // that's the price for MATCH being O(log n) instead of the current
  // O(n) LIKE scans. Tokenizer is unicode61 with case-folding — same
  // choice Signal uses for their message search.
  const initFts = () => {
    try {
      // Contentless FTS5 table. `content=""` because our indexed
      // columns (tool_name, prompt, arguments, observation) don't
      // exist as first-class columns on `traces` — they live inside
      // JSON blobs (tool_call, input_context, observation). An
      // external-content link would require FTS5 to find columns
      // with those names in the base table, which fails at query
      // time. Contentless mode makes the triggers below the sole
      // source of truth for the index.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
          tool_name,
          prompt,
          arguments,
          observation,
          content='',
          tokenize = 'unicode61'
        );
      `);
      // Triggers — sync on write. We extract the searchable strings
      // from the JSON blobs at trigger time so the FTS columns hold
      // clean text (not the raw JSON, which would tokenize into a
      // mess of braces and quotes).
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS traces_fts_ai AFTER INSERT ON traces BEGIN
          INSERT INTO traces_fts(rowid, tool_name, prompt, arguments, observation)
          VALUES (
            new.id,
            COALESCE(json_extract(new.tool_call,     '$.tool_name'), ''),
            COALESCE(json_extract(new.input_context, '$.prompt'),    ''),
            COALESCE(json_extract(new.tool_call,     '$.arguments'), ''),
            COALESCE(json_extract(new.observation,   '$.raw_output'),'')
          );
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS traces_fts_ad AFTER DELETE ON traces BEGIN
          INSERT INTO traces_fts(traces_fts, rowid, tool_name, prompt, arguments, observation)
          VALUES ('delete', old.id, '', '', '', '');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS traces_fts_au AFTER UPDATE ON traces BEGIN
          INSERT INTO traces_fts(traces_fts, rowid, tool_name, prompt, arguments, observation)
          VALUES ('delete', old.id, '', '', '', '');
          INSERT INTO traces_fts(rowid, tool_name, prompt, arguments, observation)
          VALUES (
            new.id,
            COALESCE(json_extract(new.tool_call,     '$.tool_name'), ''),
            COALESCE(json_extract(new.input_context, '$.prompt'),    ''),
            COALESCE(json_extract(new.tool_call,     '$.arguments'), ''),
            COALESCE(json_extract(new.observation,   '$.raw_output'),'')
          );
        END;
      `);
      // Backfill: on first run against a DB that predates the FTS
      // table, copy every existing trace into the index. On
      // subsequent runs this is a no-op — INSERT OR IGNORE would be
      // cleaner but external-content FTS doesn't support IGNORE, so
      // we gate on "is traces_fts empty?"
      const ftsCount = db.prepare(`SELECT COUNT(*) as n FROM traces_fts`).get() as { n: number };
      const traceCount = db.prepare(`SELECT COUNT(*) as n FROM traces`).get() as { n: number };
      if (ftsCount.n === 0 && traceCount.n > 0) {
        db.exec(`
          INSERT INTO traces_fts(rowid, tool_name, prompt, arguments, observation)
          SELECT
            id,
            COALESCE(json_extract(tool_call,     '$.tool_name'), ''),
            COALESCE(json_extract(input_context, '$.prompt'),    ''),
            COALESCE(json_extract(tool_call,     '$.arguments'), ''),
            COALESCE(json_extract(observation,   '$.raw_output'),'')
          FROM traces;
        `);
      }
    } catch (e) {
      // FTS5 is compiled into better-sqlite3 by default, but a
      // hand-built libsqlite might not have it. Log and continue —
      // /traces/search will fall back to a degraded LIKE-based path.
      // eslint-disable-next-line no-console
      console.warn('[traces_fts] initialisation failed — search will use LIKE fallback:', (e as Error).message);
    }
  };
  initFts();

  // saved_queries — per-org named DSL queries. Cockpit uses these to
  // populate the "Saved" dropdown in the trace search bar. Cheap
  // table, no indices needed beyond org_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_queries (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL DEFAULT '*',
      name        TEXT NOT NULL,
      dsl         TEXT NOT NULL,
      created_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_run_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saved_queries_org ON saved_queries (org_id, name);
  `);

  // Ensure gateway_config table exists (for dashboard API key)
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // Agent profiles table (used by ProfileManager and BehaviorProfile)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      trace_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Anomaly events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS anomaly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      trace_id TEXT,
      check_id TEXT,
      composite_score REAL NOT NULL,
      decision TEXT NOT NULL,
      signals TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_anomaly_agent ON anomaly_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_anomaly_score ON anomaly_events(composite_score);
    CREATE INDEX IF NOT EXISTS idx_anomaly_decision ON anomaly_events(decision);
  `);

  // Anomaly feedback table — stores feature vectors for human feedback loop
  db.exec(`
    CREATE TABLE IF NOT EXISTS anomaly_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      composite_score REAL NOT NULL,
      feature_vector TEXT NOT NULL,
      model_decision TEXT NOT NULL,
      human_decision TEXT,
      decided_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_check ON anomaly_feedback(check_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_agent ON anomaly_feedback(agent_id);
  `);

  // LLM-as-a-Judge verdicts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS judge_verdicts (
      trace_id TEXT PRIMARY KEY,
      overall_score INTEGER NOT NULL,
      overall_label TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      summary TEXT NOT NULL,
      model_used TEXT NOT NULL,
      latency_ms REAL,
      judged_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_judge_score ON judge_verdicts(overall_score);
    CREATE INDEX IF NOT EXISTS idx_judge_model ON judge_verdicts(model_used);
  `);

  return db;
}