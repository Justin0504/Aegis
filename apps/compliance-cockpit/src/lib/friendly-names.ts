/**
 * Humanize developer identifiers for a non-engineering audience.
 *
 * Compliance officers, security analysts, and ops staff don't think
 * in UUIDs or snake_case tool ids — they think in "the support bot"
 * and "queried the users table". These helpers translate.
 */

/** "agent-customer-support" / "agent_customer_support" / UUID → "Customer Support" */
export function friendlyAgent(agentId: string | null | undefined, name?: string | null): string {
  // The operator's name, when the gateway has one, beats any guess from the id.
  if (name && name.trim()) return friendlyAgent(name.trim())
  if (!agentId) return 'Unknown agent'

  // UUID — keep a stable short suffix so two unnamed agents stay distinguishable
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(agentId)) {
    return `Agent ${agentId.slice(0, 4)}`
  }

  // strip prefixes "agent-" / "agent_"
  const raw = agentId.replace(/^agent[-_]/i, '')
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Decision label — turn the gateway verdict into ops language. */
export function friendlyDecision(decision: string | undefined, hasError: boolean): {
  label: string
  tone: 'allow' | 'block' | 'review' | 'error'
} {
  if (hasError) return { label: 'Error', tone: 'error' }
  switch ((decision || '').toLowerCase()) {
    case 'allow':   return { label: 'Allowed',     tone: 'allow' }
    case 'block':   return { label: 'Blocked',     tone: 'block' }
    case 'pending':
    case 'review':  return { label: 'Needs review', tone: 'review' }
    default:        return { label: 'Allowed',     tone: 'allow' }   // safe default for absent decision
  }
}

/** Risk level → casual phrasing + display priority */
export function friendlyRisk(risk: string | undefined): {
  label: string
  show: boolean
  tone: 'low' | 'medium' | 'high' | 'critical'
} | null {
  if (!risk) return null
  const r = risk.toLowerCase()
  if (r === 'critical') return { label: 'Critical risk', show: true,  tone: 'critical' }
  if (r === 'high')     return { label: 'High risk',     show: true,  tone: 'high' }
  if (r === 'medium')   return { label: 'Medium',        show: false, tone: 'medium' }
  if (r === 'low')      return { label: 'Low',           show: false, tone: 'low' }
  return null
}

/** Policy name from id ("email-allowlist") → "Email allowlist" */
export function friendlyPolicy(policyId: string | null | undefined): string {
  if (!policyId) return ''
  return policyId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}
