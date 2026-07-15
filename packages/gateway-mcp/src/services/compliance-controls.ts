/**
 * Compliance control definitions — maps the controls auditors care about
 * (SOC 2, ISO 27001, NIST AI RMF, EU AI Act) to the AEGIS audit evidence
 * that demonstrates them.
 *
 * v1 covers a curated subset per framework — the controls most directly
 * supported by AEGIS's audit log, detector chain, threat ontology, and
 * transparency log. Adding more controls is an append-only edit.
 *
 * The point is NOT to claim audit readiness on the customer's behalf
 * (only the auditor can do that). The point is: when the auditor asks
 * "show me evidence of CC6.1 enforcement", the customer hands them an
 * AEGIS bundle with signed audit rows, transparency-log inclusion
 * proofs, and a clearly delineated mapping. That's hours not weeks.
 */

/** Canonical built-in frameworks. The public `Framework` type widens to
 *  string to allow operator-registered customs through the same code
 *  path; APIs that need to reject unknowns combine `isBuiltinFramework`
 *  with a tenant-scoped lookup. */
export type BuiltinFramework = 'soc2' | 'iso27001' | 'nist-ai-rmf' | 'eu-ai-act';
export type Framework = BuiltinFramework | string;

export interface ControlEvidenceSpec {
  /** Audit actions whose presence supports this control. */
  readonly auditActions?: ReadonlyArray<string>;
  /** Detector names registered in AEGIS that act as this control. */
  readonly detectors?: ReadonlyArray<string>;
  /** Threat-ontology nodes whose coverage demonstrates this control. */
  readonly ontology?: ReadonlyArray<string>;
  /** Audit + transparency-log facts the bundle should surface. */
  readonly artifacts?: ReadonlyArray<'transparency-root' | 'audit-row-count' | 'evidence-pack-hash'>;
}

export interface ComplianceControl {
  readonly framework: Framework;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly evidenceSpec: ControlEvidenceSpec;
}

// ── SOC 2 (Trust Services Criteria) ───────────────────────────────────────

const SOC2: ComplianceControl[] = [
  {
    framework: 'soc2', id: 'CC6.1',
    title: 'Logical and Physical Access Controls — Logical access provisioning',
    summary: 'Demonstrates that access to systems is provisioned, modified, and revoked through controlled processes with full audit attribution.',
    evidenceSpec: {
      auditActions: ['user.create', 'user.update', 'user.delete', 'user.invite', 'apikey.create', 'apikey.revoke', 'apikey.regenerate'],
      artifacts: ['audit-row-count', 'transparency-root'],
    },
  },
  {
    framework: 'soc2', id: 'CC6.6',
    title: 'Boundary protection — external interaction',
    summary: 'Pre-execution checks at the agent-to-tool boundary block unauthorized action and produce an audit row per decision.',
    evidenceSpec: {
      detectors: ['aegis.builtin.classifier', 'aegis.builtin.tool-scope'],
      ontology: ['AAT-T2001', 'AAT-T2003', 'AAT-T2004', 'AAT-T2005'],
      auditActions: ['proxy.llm_call'],
    },
  },
  {
    framework: 'soc2', id: 'CC6.7',
    title: 'Restricted access — credential protection',
    summary: 'PII and secret detectors block leakage of credentials, tokens, and PEM material through tool arguments.',
    evidenceSpec: {
      detectors: ['aegis.builtin.pii'],
      ontology: ['AAT-T4001', 'AAT-T4003', 'AAT-T4004', 'AAT-T4005'],
    },
  },
  {
    framework: 'soc2', id: 'CC7.1',
    title: 'System Operations — anomaly detection',
    summary: 'Behavioral baseline + budget guard surface anomalous activity (tool novelty, frequency spike, cost burndown).',
    evidenceSpec: {
      detectors: ['aegis.builtin.anomaly', 'aegis.builtin.budget'],
      ontology: ['AAT-T3001', 'AAT-T8001', 'AAT-T8002', 'AAT-T9003'],
    },
  },
  {
    framework: 'soc2', id: 'CC7.2',
    title: 'System Operations — monitoring and logging',
    summary: 'Append-only audit log + RFC 6962 transparency log + offline-verifiable signed roots.',
    evidenceSpec: {
      artifacts: ['transparency-root', 'audit-row-count', 'evidence-pack-hash'],
    },
  },
];

// ── ISO/IEC 27001:2022 (Annex A subset) ──────────────────────────────────

const ISO27001: ComplianceControl[] = [
  {
    framework: 'iso27001', id: 'A.5.15',
    title: 'Access control',
    summary: 'Role-based and identity-based access to agent infrastructure with per-action audit attribution.',
    evidenceSpec: {
      auditActions: ['user.create', 'user.update', 'user.delete', 'apikey.create', 'apikey.revoke'],
      artifacts: ['audit-row-count'],
    },
  },
  {
    framework: 'iso27001', id: 'A.8.16',
    title: 'Monitoring activities',
    summary: 'Continuous monitoring of agent activity across content, behavior, and meta detectors with severity-tiered signals.',
    evidenceSpec: {
      detectors: [
        'aegis.builtin.pii', 'aegis.builtin.classifier', 'aegis.builtin.anomaly',
        'aegis.builtin.discovery', 'aegis.builtin.exfil', 'aegis.builtin.lateral',
        'aegis.builtin.cross-agent', 'aegis.builtin.memory-poison',
      ],
      artifacts: ['transparency-root', 'audit-row-count'],
    },
  },
  {
    framework: 'iso27001', id: 'A.8.24',
    title: 'Cryptography',
    summary: 'Ed25519 signing of evidence packs and transparency-log roots; per-tenant key isolation.',
    evidenceSpec: {
      artifacts: ['transparency-root', 'evidence-pack-hash'],
    },
  },
  {
    framework: 'iso27001', id: 'A.8.28',
    title: 'Secure coding — agent-side',
    summary: 'AEGIS pre-execution checks reject SQL injection, shell injection, SSRF, and unsafe network targets in tool arguments.',
    evidenceSpec: {
      detectors: ['aegis.builtin.classifier'],
      ontology: ['AAT-T2003', 'AAT-T2004', 'AAT-T2005'],
    },
  },
];

// ── NIST AI RMF (Risk Management Framework v1.0) ─────────────────────────

const NIST_AI_RMF: ComplianceControl[] = [
  {
    framework: 'nist-ai-rmf', id: 'MAP-2.3',
    title: 'Scientific integrity and risk assessment',
    summary: 'Threat ontology v1.0.0 and coverage map provide a published, versioned taxonomy of agent-specific risks AEGIS defends against.',
    evidenceSpec: {
      ontology: [],   // coverage report attached
      artifacts: ['transparency-root'],
    },
  },
  {
    framework: 'nist-ai-rmf', id: 'MEASURE-2.7',
    title: 'AI system security and resilience evaluation',
    summary: 'Continuous detector signals across the 10 tactics of the AEGIS Agent Threat Ontology, with audit-quality attribution per decision.',
    evidenceSpec: {
      ontology: [
        'AAT-T1001', 'AAT-T2001', 'AAT-T2003', 'AAT-T3001', 'AAT-T4001',
        'AAT-T5004', 'AAT-T5005', 'AAT-T6001', 'AAT-T7001', 'AAT-T7002',
        'AAT-T7003', 'AAT-T8001', 'AAT-T8002', 'AAT-T10001', 'AAT-T10002',
      ],
    },
  },
  {
    framework: 'nist-ai-rmf', id: 'MANAGE-2.4',
    title: 'Incident response',
    summary: 'Agent suspension (status=suspended) blocks all calls at the gate; transparency-log proves the suspension event was recorded and dated.',
    evidenceSpec: {
      auditActions: ['user.update', 'proxy.llm_call'],
      artifacts: ['transparency-root', 'audit-row-count'],
    },
  },
];

// ── EU AI Act (Regulation 2024/1689) ─────────────────────────────────────

const EU_AI_ACT: ComplianceControl[] = [
  {
    framework: 'eu-ai-act', id: 'Art.12',
    title: 'Record-keeping (logging)',
    summary: 'Automatic logging of events relevant to the AI system during its operation — covered by the AEGIS append-only audit log and transparency log.',
    evidenceSpec: {
      artifacts: ['transparency-root', 'audit-row-count'],
    },
  },
  {
    framework: 'eu-ai-act', id: 'Art.13',
    title: 'Transparency and provision of information',
    summary: 'Coverage map + ontology publish the system\'s threat-detection scope with versioning so deployers can compare advertised against actual coverage.',
    evidenceSpec: {
      ontology: [],
      artifacts: ['transparency-root'],
    },
  },
  {
    framework: 'eu-ai-act', id: 'Art.14',
    title: 'Human oversight',
    summary: 'Blocking mode + pending_checks + kill-switch + approvals table together implement designed-in human oversight: high-risk tool calls hold for human decision, decisions are auditable, and any authorised operator can globally suspend an agent.',
    evidenceSpec: {
      auditActions: [
        'proxy.llm_call',   // blocked decisions land here with pending state
        'user.update',      // agent status changes (suspend/resume)
        'apikey.revoke',    // kill-switch on the calling channel
      ],
      artifacts: ['transparency-root', 'audit-row-count'],
    },
  },
  {
    framework: 'eu-ai-act', id: 'Art.15',
    title: 'Accuracy, robustness and cybersecurity',
    summary: 'Detector chain + agent identity gate + tool-scope enforcement maintain robustness against prompt injection, tool misuse, privilege escalation, and credential exposure.',
    evidenceSpec: {
      detectors: [
        'aegis.builtin.classifier', 'aegis.builtin.pii', 'aegis.builtin.tool-scope',
        'aegis.builtin.discovery', 'aegis.builtin.exfil', 'aegis.builtin.memory-poison',
      ],
      ontology: ['AAT-T1004', 'AAT-T2001', 'AAT-T3001', 'AAT-T4001', 'AAT-T5005'],
    },
  },
];

const ALL: ComplianceControl[] = [...SOC2, ...ISO27001, ...NIST_AI_RMF, ...EU_AI_ACT];

const BUILTIN_IDS: ReadonlyArray<BuiltinFramework> = ['soc2', 'iso27001', 'nist-ai-rmf', 'eu-ai-act'];

export function isBuiltinFramework(v: string): v is BuiltinFramework {
  return (BUILTIN_IDS as ReadonlyArray<string>).includes(v);
}

export function listBuiltinFrameworks(): ReadonlyArray<BuiltinFramework> {
  return BUILTIN_IDS;
}

/** @deprecated kept for back-compat with the original API surface;
 *  prefer `listBuiltinFrameworks()` + the tenant-aware
 *  `ComplianceControlSource.list()`. */
export function listFrameworks(): ReadonlyArray<Framework> {
  return BUILTIN_IDS;
}

export function builtinControlsFor(framework: BuiltinFramework): ReadonlyArray<ComplianceControl> {
  return ALL.filter(c => c.framework === framework);
}

/** @deprecated use `builtinControlsFor` for built-ins or
 *  `ComplianceControlSource.controlsFor(orgId, framework)` for the
 *  tenant-aware merge. Kept as a thin shim while callers migrate. */
export function controlsFor(framework: Framework): ReadonlyArray<ComplianceControl> {
  if (isBuiltinFramework(framework as string)) {
    return builtinControlsFor(framework as BuiltinFramework);
  }
  return [];
}
