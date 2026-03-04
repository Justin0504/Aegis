import Database from 'better-sqlite3';
import { Logger } from 'pino';

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

    -- Insert default policies
    INSERT OR IGNORE INTO policies (id, name, description, policy_schema, risk_level) VALUES
    ('sql-injection', 'SQL Injection Prevention', 'Prevents SQL injection attacks',
     '{"type":"object","properties":{"sql":{"type":"string","pattern":"^(?!.*(\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bEXEC\b)).*$"}}}',
     'HIGH'),
    ('file-access', 'File Access Control', 'Controls file system access',
     '{"type":"object","properties":{"path":{"type":"string","pattern":"^(?!.*(\\.\\.|~|/etc/|/root/)).*$"}}}',
     'MEDIUM'),
    ('network-access', 'Network Access Control', 'Controls network requests',
     '{"type":"object","properties":{"url":{"type":"string","format":"uri","pattern":"^https://"}}}',
     'MEDIUM');
  `);

  return db;
}