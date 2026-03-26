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

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    -- Traces table
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      parent_trace_id TEXT,
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
  ];

  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }

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