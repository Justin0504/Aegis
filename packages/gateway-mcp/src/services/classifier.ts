/**
 * Tool Classifier — zero-config, works with any tool name
 *
 * Three-layer approach:
 *   1. Argument content scan  (always runs, highest signal)
 *   2. Tool name inference    (keyword matching, cached)
 *   3. User-defined overrides (highest priority, from SDK config or dashboard)
 */

export type ToolCategory =
  | 'database'
  | 'file'
  | 'network'
  | 'shell'
  | 'communication'
  | 'data'
  | 'unknown'

export interface ClassificationResult {
  category: ToolCategory
  /** Which signals triggered, useful for UI display */
  signals: string[]
  /** Content-level risks detected in arguments */
  risks: RiskSignal[]
  /** Which layer determined the category */
  source: 'content' | 'name' | 'override' | 'fallback'
}

export interface RiskSignal {
  type: 'sql_injection' | 'path_traversal' | 'shell_injection' | 'sensitive_file'
       | 'plaintext_url' | 'pii_in_args' | 'large_payload' | 'prompt_injection'
       | 'data_exfiltration'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  detail: string
}

// ── Layer 2: Tool name → category keyword maps ──────────────────────────────

const NAME_KEYWORDS: Array<{ keywords: string[]; category: ToolCategory }> = [
  {
    keywords: ['sql', 'query', 'database', 'db_', '_db', 'sqlite', 'postgres',
               'mysql', 'execute', 'select', 'insert', 'update', 'delete_row',
               'fetch_row', 'run_query', 'exec_query'],
    category: 'database',
  },
  {
    keywords: ['file', 'read_', 'write_', 'open_', 'path', 'dir', 'folder',
               'ls_', 'list_', 'mkdir', 'rm_', 'delete_file', 'move_file',
               'copy_file', 'glob', 'stat_'],
    category: 'file',
  },
  {
    keywords: ['http', 'request', 'fetch', 'url', 'api_call', 'api_get',
               'api_post', 'webhook', 'get_url', 'post_url', 'download',
               'upload', 'curl', 'web_search', 'browse', 'scrape'],
    category: 'network',
  },
  {
    keywords: ['shell', 'exec', 'bash', 'cmd', 'command', 'run_', 'subprocess',
               'terminal', 'powershell', 'spawn', 'popen'],
    category: 'shell',
  },
  {
    keywords: ['email', 'send_', 'mail', 'slack', 'notify', 'message', 'sms',
               'telegram', 'discord', 'push_notification', 'alert_'],
    category: 'communication',
  },
]

// ── Layer 1: Argument content risk patterns ─────────────────────────────────

const RISK_PATTERNS: Array<{
  type: RiskSignal['type']
  severity: RiskSignal['severity']
  test: (values: string[], args: unknown) => string | null
}> = [
  // ── SQL Injection ──────────────────────────────────────────────────────────
  {
    type: 'sql_injection',
    severity: 'HIGH',
    test: (vals) => {
      const SQL_INJECT = /\b(OR|AND)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?|--|;.*DROP|UNION\s+SELECT|'\s*OR\s+'1'\s*=\s*'1/i
      const found = vals.find(v => SQL_INJECT.test(v))
      return found ? `SQL injection pattern in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'HIGH',
    test: (vals) => {
      // Blind SQL injection: time-based and benchmark attacks
      const BLIND_SQL = /\bWAITFOR\s+DELAY\b|\bpg_sleep\s*\(|\bBENCHMARK\s*\(|\bSLEEP\s*\(/i
      const found = vals.find(v => BLIND_SQL.test(v))
      return found ? `Blind SQL injection (time-based) in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'HIGH',
    test: (vals) => {
      // Comment-based bypass: /* */ used to break keywords through WAFs
      const COMMENT_BYPASS = /\/\*[^*]*\*\/\s*(?:SELECT|UNION|DROP|INSERT|DELETE|UPDATE|EXEC)\b/i
      const found = vals.find(v => COMMENT_BYPASS.test(v))
      return found ? `SQL comment bypass in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'MEDIUM',
    test: (vals) => {
      // String concatenation attacks
      const CONCAT_ATTACK = /\bCONCAT\s*\(|\bCHR\s*\(|\bCHAR\s*\(/i
      const found = vals.find(v => CONCAT_ATTACK.test(v))
      return found ? `SQL string concatenation function in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'HIGH',
    test: (vals) => {
      // Stacked queries: semicolon followed by SQL keyword
      const STACKED = /;\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|TRUNCATE)\b/i
      const found = vals.find(v => STACKED.test(v))
      return found ? `Stacked SQL query in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'MEDIUM',
    test: (vals) => {
      // Hex-encoded strings (common in SQL injection payloads)
      const HEX_PAYLOAD = /0x[0-9a-fA-F]{8,}/
      const found = vals.find(v => HEX_PAYLOAD.test(v))
      return found ? `Hex-encoded payload in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sql_injection',
    severity: 'MEDIUM',
    test: (vals) => {
      const SQL_KEYWORDS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)\b/i
      const found = vals.find(v => SQL_KEYWORDS.test(v))
      return found ? `Destructive SQL keyword in: "${found.slice(0, 60)}"` : null
    },
  },

  // ── Path Traversal ─────────────────────────────────────────────────────────
  {
    type: 'path_traversal',
    severity: 'HIGH',
    test: (vals) => {
      const found = vals.find(v =>
        v.includes('../') || v.includes('..\\') || /^~\//.test(v)
      )
      return found ? `Path traversal in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'path_traversal',
    severity: 'HIGH',
    test: (vals) => {
      // URL-encoded traversal: %2e%2e%2f or %2e%2e%5c
      const URL_ENCODED = /%2e%2e(%2f|%5c)/i
      const found = vals.find(v => URL_ENCODED.test(v))
      return found ? `URL-encoded path traversal in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'path_traversal',
    severity: 'HIGH',
    test: (vals) => {
      // Double-encoded traversal
      const DOUBLE_ENCODED = /%252e%252e/i
      const found = vals.find(v => DOUBLE_ENCODED.test(v))
      return found ? `Double-encoded path traversal in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'path_traversal',
    severity: 'MEDIUM',
    test: (vals) => {
      // Null byte injection (used to truncate file extensions)
      const found = vals.find(v => v.includes('%00') || v.includes('\x00'))
      return found ? `Null byte injection in: "${found.slice(0, 60)}"` : null
    },
  },

  // ── Sensitive File Access ──────────────────────────────────────────────────
  {
    type: 'sensitive_file',
    severity: 'CRITICAL',
    test: (vals) => {
      const SENSITIVE = [
        '/etc/passwd', '/etc/shadow', '/.ssh/', '/.aws/', '/.env', '/proc/',
        '/.kube/', '/.terraform/', '/.bashrc', '/.zshrc', '/.profile',
        '/.gitconfig', '/.npmrc', '/.docker/', '/id_rsa', '/id_ed25519',
      ]
      for (const s of SENSITIVE) {
        const found = vals.find(v => v.includes(s))
        if (found) return `Access to sensitive path: ${s}`
      }
      return null
    },
  },

  // ── Shell Injection ────────────────────────────────────────────────────────
  {
    type: 'shell_injection',
    severity: 'HIGH',
    test: (vals) => {
      const SHELL = /[;&|`]|\$\(|\|\|/
      const found = vals.find(v => SHELL.test(v))
      return found ? `Shell metacharacter in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'shell_injection',
    severity: 'HIGH',
    test: (vals) => {
      // Dangerous commands with network targets
      const DANGEROUS_CMD = /\b(curl|wget|nc|ncat)\b.*\b(https?:\/\/|ftp:\/\/|\/\/)/i
      const found = vals.find(v => DANGEROUS_CMD.test(v))
      return found ? `Dangerous command with network target in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'shell_injection',
    severity: 'HIGH',
    test: (vals) => {
      // ${IFS} word splitting bypass
      const IFS_BYPASS = /\$\{?IFS\}?/
      const found = vals.find(v => IFS_BYPASS.test(v))
      return found ? `Shell IFS bypass in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'shell_injection',
    severity: 'HIGH',
    test: (vals) => {
      // Process substitution and redirection to sensitive paths
      const PROC_SUB = /<\(|>\(|[<>]\s*\/(?:etc|proc|dev|tmp)/
      const found = vals.find(v => PROC_SUB.test(v))
      return found ? `Shell process substitution or redirect in: "${found.slice(0, 60)}"` : null
    },
  },

  // ── Plaintext URL ──────────────────────────────────────────────────────────
  {
    type: 'plaintext_url',
    severity: 'LOW',
    test: (vals) => {
      const found = vals.find(v => /^http:\/\//i.test(v))
      return found ? `Plaintext HTTP URL: "${found.slice(0, 80)}"` : null
    },
  },

  // ── Large Payload ──────────────────────────────────────────────────────────
  {
    type: 'large_payload',
    severity: 'MEDIUM',
    test: (vals, args) => {
      const total = JSON.stringify(args).length
      return total > 50_000 ? `Large payload: ${(total / 1024).toFixed(1)}KB` : null
    },
  },

  // ── Data Exfiltration (content-level) ──────────────────────────────────────
  {
    type: 'data_exfiltration',
    severity: 'HIGH',
    test: (vals) => {
      const hasUrl = vals.some(v => /^https?:\/\//i.test(v))
      const hasLargeString = vals.some(v => v.length > 5000)
      if (hasUrl && hasLargeString) return 'Possible data exfiltration: large payload with external URL'
      return null
    },
  },

  // ── Prompt Injection ───────────────────────────────────────────────────────
  {
    type: 'prompt_injection',
    severity: 'CRITICAL',
    test: (vals) => {
      const INJECT = new RegExp([
        'ignore (previous|above|all|prior|every)',
        'disregard (all|your|the|previous)',
        'you are now',
        'act as if',
        'new instructions',
        'forget (your|all|previous|everything)',
        'override (your|system|all)',
        'jailbreak',
        'do anything now',
        'DAN mode',
        'developer mode',
        'bypass (filter|safety|content|restriction)',
        'pretend (you|to be|that)',
        'roleplay as',
        'system prompt',
        'reveal (your|the|system)',
        'what (are|is) your (instructions|prompt|system)',
      ].join('|'), 'i')
      const found = vals.find(v => INJECT.test(v))
      return found ? `Prompt injection attempt: "${found.slice(0, 80)}"` : null
    },
  },
]

// ── Content → category inference ────────────────────────────────────────────

function categoryFromContent(args: unknown): ToolCategory | null {
  const vals = extractStringValues(args)
  const joined = vals.join('\n').toLowerCase()

  if (/\b(select|insert|update|delete|drop|create table|alter table)\b/.test(joined)) return 'database'
  if (/^(https?|ftp):\/\//.test(joined) || vals.some(v => /^https?:\/\//.test(v))) return 'network'
  if (vals.some(v => /^\/[a-z]|^[a-z]:\\/i.test(v) || v.includes('./'))) return 'file'
  if (/[;&|`]|\$\(/.test(joined)) return 'shell'
  return null
}

// ── Layer 2: Tool name inference ─────────────────────────────────────────────

function categoryFromName(toolName: string): ToolCategory | null {
  const lower = toolName.toLowerCase()
  for (const { keywords, category } of NAME_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return category
  }
  return null
}

// ── String value extractor ───────────────────────────────────────────────────

const SCAN_TRUNCATED = '__SCAN_TRUNCATED__'
const MAX_SCAN_DEPTH = 32
const MAX_STRING_COUNT = 10_000

function extractStringValues(obj: unknown, depth = 0, ctx = { count: 0 }): string[] {
  if (depth > MAX_SCAN_DEPTH || ctx.count > MAX_STRING_COUNT) return [SCAN_TRUNCATED]
  if (typeof obj === 'string') { ctx.count++; return [obj] }
  if (Array.isArray(obj)) return obj.flatMap(v => extractStringValues(v, depth + 1, ctx))
  if (obj && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).flatMap(v => extractStringValues(v, depth + 1, ctx))
  }
  return []
}

// ── Main classify function ────────────────────────────────────────────────────

export function classifyToolCall(
  toolName: string,
  args: unknown,
  userOverrides: Record<string, ToolCategory> = {},
): ClassificationResult {
  const signals: string[] = []

  // Layer 3: user override (highest priority)
  const override = userOverrides[toolName]
  if (override) {
    return { category: override, signals: ['user-override'], risks: [], source: 'override' }
  }

  // Layer 1: scan argument content
  const stringValues = extractStringValues(args)
  const risks: RiskSignal[] = []

  // Flag if scan was truncated (deep nesting or too many values — suspicious)
  if (stringValues.includes(SCAN_TRUNCATED)) {
    risks.push({ type: 'large_payload', severity: 'MEDIUM', detail: 'Argument nesting exceeded scan depth — partial scan (possible evasion attempt)' })
    signals.push('scan_truncated')
  }

  for (const pattern of RISK_PATTERNS) {
    const detail = pattern.test(stringValues, args)
    if (detail) {
      risks.push({ type: pattern.type, severity: pattern.severity, detail })
      signals.push(`${pattern.type}:${pattern.severity}`)
    }
  }

  const contentCategory = categoryFromContent(args)
  if (contentCategory) {
    signals.push(`content:${contentCategory}`)
    return { category: contentCategory, signals, risks, source: 'content' }
  }

  // Layer 2: tool name keyword inference
  const nameCategory = categoryFromName(toolName)
  if (nameCategory) {
    signals.push(`name:${nameCategory}`)
    return { category: nameCategory, signals, risks, source: 'name' }
  }

  return { category: 'unknown', signals, risks, source: 'fallback' }
}

/** Map category to a default risk level (used when no policy explicitly matches) */
export function defaultRiskForCategory(category: ToolCategory): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const map: Record<ToolCategory, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
    database:      'HIGH',
    file:          'MEDIUM',
    network:       'MEDIUM',
    shell:         'CRITICAL',
    communication: 'MEDIUM',
    data:          'LOW',
    unknown:       'LOW',
  }
  return map[category]
}
