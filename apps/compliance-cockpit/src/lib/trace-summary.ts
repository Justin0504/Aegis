/**
 * Auto-generate human-readable summaries from tool calls.
 * No SDK changes needed — purely derived from existing trace data.
 */

const TOOL_VERBS: Record<string, string> = {
  web_search:    'Searched',
  read_file:     'Read',
  write_file:    'Wrote',
  delete_file:   'Deleted',
  execute_sql:   'Queried',
  run_query:     'Queried',
  query_database:'Queried',
  send_request:  'Requested',
  send_email:    'Emailed',
  run_cmd:       'Ran',
  execute_code:  'Executed',
  process_text:  'Processed',
  my_file_reader:'Read',
  fancy_lookup:  'Looked up',
}

/** Generate a short readable summary for a single trace */
export function traceSummary(trace: any): string {
  const tool = trace.tool_call?.tool_name || ''
  const args = trace.tool_call?.arguments || {}
  const verb = TOOL_VERBS[tool] || capitalize(tool.replace(/_/g, ' '))

  // Try to extract the most meaningful argument
  const detail = extractDetail(tool, args)
  if (detail) return `${verb} ${detail}`
  return verb
}

function extractDetail(tool: string, args: Record<string, any>): string {
  // SQL queries
  if (args.sql || args.query_string) {
    const sql = String(args.sql || args.query_string).trim()
    // Extract table name from common SQL patterns
    const tableMatch = sql.match(/(?:FROM|INTO|UPDATE|TABLE)\s+(\w+)/i)
    if (tableMatch) {
      const action = sql.match(/^(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)/i)?.[1]?.toUpperCase()
      if (action === 'SELECT') return `${tableMatch[1]} table`
      if (action === 'INSERT') return `into ${tableMatch[1]}`
      if (action === 'DELETE' || action === 'DROP') return `${tableMatch[1]} (destructive)`
      return `${tableMatch[1]}`
    }
    return truncate(sql, 40)
  }

  // File paths
  if (args.path || args.file_path || args.filename) {
    const p = String(args.path || args.file_path || args.filename)
    // Show just the filename, not full path
    const name = p.split('/').pop() || p
    return name
  }

  // Search queries
  if (args.query || args.search || args.q) {
    return `"${truncate(String(args.query || args.search || args.q), 40)}"`
  }

  // URLs
  if (args.url) {
    try {
      const u = new URL(args.url)
      return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`
    } catch {
      return truncate(args.url, 40)
    }
  }

  // Commands
  if (args.cmd || args.command) {
    return truncate(String(args.cmd || args.command), 40)
  }

  // Text processing
  if (args.text || args.content || args.body) {
    const text = String(args.text || args.content || args.body)
    return `"${truncate(text, 35)}"`
  }

  // Generic: show first string arg value
  for (const [, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 2 && v.length < 80) {
      return truncate(v, 40)
    }
  }

  return ''
}

/** Generate a summary label for a session (from its traces) */
export function sessionSummary(traces: any[]): string {
  if (traces.length === 0) return ''

  // Collect unique tool verbs in order
  const steps: string[] = []
  const seen = new Set<string>()
  for (const t of traces) {
    const tool = t.tool_call?.tool_name || 'unknown'
    const verb = TOOL_VERBS[tool] || capitalize(tool.replace(/_/g, ' '))
    if (!seen.has(verb)) {
      seen.add(verb)
      steps.push(verb)
    }
  }

  if (steps.length <= 3) return steps.join(' → ')
  return `${steps.slice(0, 3).join(' → ')} +${steps.length - 3} more`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s
  return s.slice(0, len) + '…'
}
