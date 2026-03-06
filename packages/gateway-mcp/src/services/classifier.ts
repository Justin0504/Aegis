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
    severity: 'MEDIUM',
    test: (vals) => {
      const SQL_KEYWORDS = /\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)\b/i
      const found = vals.find(v => SQL_KEYWORDS.test(v))
      return found ? `Destructive SQL keyword in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'path_traversal',
    severity: 'HIGH',
    test: (vals) => {
      const found = vals.find(v => v.includes('../') || v.includes('..\\') || /^~\//.test(v))
      return found ? `Path traversal in: "${found.slice(0, 60)}"` : null
    },
  },
  {
    type: 'sensitive_file',
    severity: 'CRITICAL',
    test: (vals) => {
      const SENSITIVE = ['/etc/passwd', '/etc/shadow', '/.ssh/', '/.aws/', '/.env', '/proc/']
      for (const s of SENSITIVE) {
        const found = vals.find(v => v.includes(s))
        if (found) return `Access to sensitive path: ${s}`
      }
      return null
    },
  },
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
    type: 'plaintext_url',
    severity: 'LOW',
    test: (vals) => {
      const found = vals.find(v => /^http:\/\//i.test(v))
      return found ? `Plaintext HTTP URL: "${found.slice(0, 80)}"` : null
    },
  },
  {
    type: 'large_payload',
    severity: 'MEDIUM',
    test: (vals, args) => {
      const total = JSON.stringify(args).length
      return total > 50_000 ? `Large payload: ${(total / 1024).toFixed(1)}KB` : null
    },
  },
  {
    type: 'prompt_injection',
    severity: 'CRITICAL',
    test: (vals) => {
      const INJECT = /ignore (previous|above|all)|disregard|you are now|act as if|new instructions/i
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

function extractStringValues(obj: unknown, depth = 0): string[] {
  if (depth > 8) return []
  if (typeof obj === 'string') return [obj]
  if (Array.isArray(obj)) return obj.flatMap(v => extractStringValues(v, depth + 1))
  if (obj && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).flatMap(v => extractStringValues(v, depth + 1))
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
