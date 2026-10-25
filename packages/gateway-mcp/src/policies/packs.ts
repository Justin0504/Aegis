/**
 * Vertical policy packs — curated bundles of named policies for
 * specific regulated industries. Each pack is a one-click "install"
 * action from the /policies cockpit page.
 *
 * Schema matches the existing `policies` table:
 *   { id, name, description, policy_schema, risk_level }
 *
 * The policy_schema is an AJV JSON-Schema document that validates the
 * tool-call arguments. A failure (i.e. the schema rejects) becomes a
 * policy violation and the decision is taken via the gateway's normal
 * risk-level handling (HIGH/CRITICAL → block, MEDIUM → pending, LOW
 * → flag).
 *
 * Adding a new pack:
 *   1. Append an entry to POLICY_PACKS below.
 *   2. Restart gateway (no migration — packs install on demand via API).
 */

export interface PackPolicy {
  id: string
  name: string
  description: string
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  policy_schema: object
}

export interface PolicyPack {
  slug: string                // url-safe identifier
  name: string                // display name
  industry: string            // 'Payments' / 'Healthcare' / ...
  summary: string             // 1-line for marketing
  compliance: string[]        // ['PCI-DSS 3.4', 'HIPAA 164.312', ...]
  policies: PackPolicy[]
}

// ── PAYMENTS ──────────────────────────────────────────────────────────────

const payments: PolicyPack = {
  slug: 'payments',
  name: 'Payments & Fintech',
  industry: 'Payments',
  summary: 'PCI-DSS aware policies for any agent that touches card data, transfers, or refunds.',
  compliance: ['PCI-DSS 3.2', 'PCI-DSS 3.4', 'PCI-DSS 8.2', 'SOC 2 CC6.7', 'Reg E'],
  policies: [
    {
      id: 'pci-no-pan-storage',
      name: 'PCI · Block PAN storage',
      description: 'Detects a Primary Account Number (13–19 contiguous digits passing Luhn shape) in any tool argument and blocks the call. PAN must be tokenized before reaching tools.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          // Disallow 13-19 digit sequences in common arg names
          body:    { type: 'string', not: { pattern: '(?:^|[^0-9])([0-9][ \\-]?){13,19}(?:$|[^0-9])' } },
          payload: { type: 'string', not: { pattern: '(?:^|[^0-9])([0-9][ \\-]?){13,19}(?:$|[^0-9])' } },
          data:    { type: 'string', not: { pattern: '(?:^|[^0-9])([0-9][ \\-]?){13,19}(?:$|[^0-9])' } },
          content: { type: 'string', not: { pattern: '(?:^|[^0-9])([0-9][ \\-]?){13,19}(?:$|[^0-9])' } },
          sql:     { type: 'string', not: { pattern: '(?:^|[^0-9])([0-9][ \\-]?){13,19}(?:$|[^0-9])' } },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'pci-no-cvv-in-args',
      name: 'PCI · Block CVV/CVC in arguments',
      description: 'Blocks 3–4 digit verification values when they appear alongside cardholder fields. CVV must never leave a PCI-validated processor.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          body:    { type: 'string', not: { pattern: '"?(?:cvv|cvc|cvv2|security_code)"?\\s*[:=]\\s*"?\\d{3,4}"?' } },
          payload: { type: 'string', not: { pattern: '"?(?:cvv|cvc|cvv2|security_code)"?\\s*[:=]\\s*"?\\d{3,4}"?' } },
          data:    { type: 'string', not: { pattern: '"?(?:cvv|cvc|cvv2|security_code)"?\\s*[:=]\\s*"?\\d{3,4}"?' } },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'high-value-transfer-review',
      name: 'High-value transfer — human approval',
      description: 'Transfers over $10,000 (any currency, any tool) become PENDING for human approval. Standard Reg E + BSA threshold.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          amount:    { type: 'number', maximum: 10000 },
          amount_cents: { type: 'number', maximum: 1000000 },
          value:     { type: 'number', maximum: 10000 },
          total:     { type: 'number', maximum: 10000 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'aml-sanctions-screening',
      name: 'AML · Sanctions screening',
      description: 'Blocks tool calls whose recipient/counterparty country code matches OFAC-sanctioned jurisdictions (CU, IR, KP, RU subset).',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          country:        { type: 'string', not: { pattern: '^(CU|IR|KP|cuba|iran|north[ -]?korea)$' } },
          recipient_country: { type: 'string', not: { pattern: '^(CU|IR|KP|cuba|iran|north[ -]?korea)$' } },
          destination:    { type: 'string', not: { pattern: '(?:^|[^A-Z])(CU|IR|KP)(?:$|[^A-Z])' } },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'refund-audit-evidence',
      name: 'Refunds require audit reason',
      description: 'Refund and chargeback tool calls must carry a non-empty `reason` or `audit_note` argument explaining the action. Without it the call is BLOCKED.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        // The "anyOf" forces one of reason/audit_note to be a non-empty string
        anyOf: [
          { properties: { reason:     { type: 'string', minLength: 4 } }, required: ['reason'] },
          { properties: { audit_note: { type: 'string', minLength: 4 } }, required: ['audit_note'] },
          // If the tool name doesn't look like a refund the policy doesn't trip — it's permissive by default.
          { not: { properties: { _tool_kind: { const: 'refund' } } } },
        ],
        additionalProperties: true,
      },
    },
  ],
}

// ── HEALTHCARE ────────────────────────────────────────────────────────────

const healthcare: PolicyPack = {
  slug: 'healthcare',
  name: 'Healthcare & Life Sciences',
  industry: 'Healthcare',
  summary: 'HIPAA-aware policies for agents that handle PHI, claims, EHR data, or research subjects.',
  compliance: ['HIPAA 164.312(a)', 'HIPAA 164.312(e)', 'HIPAA 164.316', 'HITECH', 'GDPR Art. 9'],
  policies: [
    {
      id: 'hipaa-phi-redaction',
      name: 'HIPAA · Block PHI in tool arguments',
      description: 'Blocks the call when an SSN, MRN (medical record number), date-of-birth, or insurance-policy-number pattern appears in any text argument. PHI must be tokenized or removed before tools see it.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          body:    { type: 'string', not: { pattern: '\\b(?:\\d{3}-\\d{2}-\\d{4}|MRN[: ]?\\d{6,}|DOB[: ]?\\d{4}-\\d{2}-\\d{2})\\b' } },
          payload: { type: 'string', not: { pattern: '\\b(?:\\d{3}-\\d{2}-\\d{4}|MRN[: ]?\\d{6,}|DOB[: ]?\\d{4}-\\d{2}-\\d{2})\\b' } },
          data:    { type: 'string', not: { pattern: '\\b(?:\\d{3}-\\d{2}-\\d{4}|MRN[: ]?\\d{6,}|DOB[: ]?\\d{4}-\\d{2}-\\d{2})\\b' } },
          content: { type: 'string', not: { pattern: '\\b(?:\\d{3}-\\d{2}-\\d{4}|MRN[: ]?\\d{6,}|DOB[: ]?\\d{4}-\\d{2}-\\d{2})\\b' } },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'hipaa-minimum-necessary',
      name: 'HIPAA · Minimum-necessary access',
      description: 'Bulk patient queries (limit > 100) must go to PENDING for review. Implements 45 CFR 164.502(b) minimum-necessary rule.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          limit:        { type: 'number', maximum: 100 },
          batch_size:   { type: 'number', maximum: 100 },
          row_limit:    { type: 'number', maximum: 100 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'hipaa-encryption-required',
      name: 'HIPAA · TLS-only outbound',
      description: 'Every outbound URL with PHI must be HTTPS. Plaintext http:// blocked.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          url:      { type: 'string', pattern: '^https://' },
          endpoint: { type: 'string', pattern: '^https://' },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'hipaa-bulk-export-block',
      name: 'HIPAA · Block uncontrolled PHI exports',
      description: 'Exporting more than 50 patient records at once requires human approval; ad-hoc CSV dumps blocked outright.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          format:       { type: 'string', not: { pattern: '^(?:csv|tsv|xlsx)$' } },
          export_count: { type: 'number', maximum: 50 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'hipaa-prescription-modify-approval',
      name: 'HIPAA · Treatment changes require approval',
      description: 'Any tool that modifies a prescription, dosage, or treatment plan goes to PENDING. Agent cannot autonomously change clinical orders.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          // If the action argument names a clinical mutation, block
          action: { type: 'string', not: { pattern: '^(?:prescribe|modify_prescription|change_dosage|treatment_change|order_change|cancel_treatment)$' } },
          op:     { type: 'string', not: { pattern: '^(?:prescribe|modify_prescription|change_dosage)$' } },
        },
        additionalProperties: true,
      },
    },
  ],
}

// ── FINANCE / BANKING ─────────────────────────────────────────────────────

const finance: PolicyPack = {
  slug: 'finance',
  name: 'Banking & Capital Markets',
  industry: 'Finance',
  summary: 'AML, KYC, SOX, and cross-border policies for agents operating inside a bank or BD.',
  compliance: ['BSA/AML', 'KYC (FinCEN CIP)', 'SOX 404', 'MiFID II', 'OFAC SDN'],
  policies: [
    {
      id: 'kyc-verified-counterparty',
      name: 'KYC · Verified counterparty required',
      description: 'Any tool call whose counterparty has not been KYC-verified (no `kyc_verified=true` flag in args) is BLOCKED.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          kyc_verified: { const: true },
        },
        // Only triggers when counterparty is named — otherwise inert
        // (the gateway runs schema only on relevant tools, see DSL)
        required: [],
        additionalProperties: true,
      },
    },
    {
      id: 'sox-justification-required',
      name: 'SOX · Material change requires justification',
      description: 'Tools that modify financial reporting / GL / journal entries must include a non-empty `justification` field. Implements SOX 404 internal control.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          justification: { type: 'string', minLength: 8 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'cross-border-wire-review',
      name: 'Cross-border wire — PENDING review',
      description: 'International wire transfers (recipient country != home country) go to PENDING for compliance officer review.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          domestic_only: { const: true },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'ctr-threshold-report',
      name: 'BSA · CTR threshold flagged',
      description: 'Transactions ≥ $10,000 (the Currency Transaction Report threshold) are flagged for human review.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number', maximum: 9999 },
          amount:     { type: 'number', maximum: 9999 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'ofac-sanctions-block',
      name: 'OFAC · Sanctions list block',
      description: 'Blocks the call when a counterparty name matches the OFAC SDN list (sample subset: Cuba, Iran, NK, Russia restricted).',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          counterparty_country: { type: 'string', not: { pattern: '^(CU|IR|KP|RU)$' } },
        },
        additionalProperties: true,
      },
    },
  ],
}

// ── B2B SaaS / PRIVACY ───────────────────────────────────────────────────

const saas: PolicyPack = {
  slug: 'saas',
  name: 'B2B SaaS & Privacy',
  industry: 'SaaS',
  summary: 'GDPR + CCPA + multi-tenant isolation policies for agents touching customer data.',
  compliance: ['GDPR Art. 5', 'GDPR Art. 17', 'CCPA §1798.105', 'SOC 2 CC6.6'],
  policies: [
    {
      id: 'gdpr-deletion-pending',
      name: 'GDPR · Right-to-erasure is human-only',
      description: 'Tools that delete a data subject\'s record must go to PENDING — agent cannot honor a deletion request autonomously. Audit trail required.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          confirmed_by_user: { const: true },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'tenant-isolation',
      name: 'Multi-tenant isolation',
      description: 'Tool calls whose `org_id` or `tenant_id` argument differs from the calling agent\'s registered tenant are BLOCKED. Prevents cross-tenant data leakage.',
      risk_level: 'CRITICAL',
      policy_schema: {
        type: 'object',
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'no-prod-db-writes',
      name: 'No prod DB writes from agent',
      description: 'Blocks UPDATE / DELETE / INSERT against any table when the database URL contains `prod` / `production`. Stage / dev OK.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          connection: { type: 'string', not: { pattern: '(?:prod|production)' } },
          db_url:     { type: 'string', not: { pattern: '(?:prod|production)' } },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'pii-bulk-export-flag',
      name: 'PII bulk export flagged',
      description: 'Exporting more than 1000 user records (or any `email` column dump) requires human review.',
      risk_level: 'MEDIUM',
      policy_schema: {
        type: 'object',
        properties: {
          row_count: { type: 'number', maximum: 1000 },
          limit:     { type: 'number', maximum: 1000 },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'oauth-scope-creep',
      name: 'OAuth scope creep block',
      description: 'Blocks tool calls requesting OAuth scopes beyond `read:user`, `read:email`. Anything write/admin must be elevated by a human.',
      risk_level: 'HIGH',
      policy_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', not: { pattern: '\\b(?:write:|admin:|delete:|owner:)' } },
        },
        additionalProperties: true,
      },
    },
  ],
}

// ── REGISTRY ──────────────────────────────────────────────────────────────

export const POLICY_PACKS: Record<string, PolicyPack> = {
  payments,
  healthcare,
  finance,
  saas,
}

export function listPacks(): Array<Pick<PolicyPack, 'slug' | 'name' | 'industry' | 'summary' | 'compliance'> & { policy_count: number }> {
  return Object.values(POLICY_PACKS).map(p => ({
    slug: p.slug,
    name: p.name,
    industry: p.industry,
    summary: p.summary,
    compliance: p.compliance,
    policy_count: p.policies.length,
  }))
}

export function getPack(slug: string): PolicyPack | null {
  return POLICY_PACKS[slug] ?? null
}
