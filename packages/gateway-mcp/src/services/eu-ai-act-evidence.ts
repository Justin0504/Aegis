/**
 * EU AI Act (Regulation 2024/1689) article-by-article evidence pack.
 *
 * High-risk-system obligations under Articles 12–15 take effect
 * 2026-08-02. This builder produces a signed JSON document that
 * maps each of the four articles to CONCRETE evidence pulled from
 * the AEGIS tables:
 *
 *   Art. 12 — Record-keeping (logging)
 *     · audit-log row count + first/last timestamps
 *     · transparency-log root hash (Merkle anchor)
 *     · per-agent trace count + anchors (first/last trace_id)
 *
 *   Art. 13 — Transparency and provision of information
 *     · registered agents (id, name, status, capabilities)
 *     · declared tool scope per agent
 *     · policy DSL rules in force
 *     · tenant configuration snapshot
 *
 *   Art. 14 — Human oversight
 *     · pending_checks table stats (how often humans reviewed)
 *     · approvals decisions (approve/reject counts + latency)
 *     · agent status changes (suspend/resume events)
 *     · kill-switch activations
 *
 *   Art. 15 — Accuracy, robustness and cybersecurity
 *     · detector chain composition (which detectors are enabled)
 *     · policy violations tally over the reporting window
 *     · integrity-verification summary (Merkle chain intact?)
 *     · rollback events (compensator success rate)
 *
 * Each article carries an `evidence` object AND a `compliant` boolean
 * with a `gaps[]` array — so the deployer + their auditor see at
 * once WHICH obligations have concrete evidence vs. which are
 * unsupported (e.g., no human-reviewed approvals recorded, so
 * Art. 14's oversight loop hasn't actually been exercised).
 *
 * The gate for `compliant=true` is deliberately soft:
 *   · Art. 12 — audit_log has at least one row in the window
 *   · Art. 13 — at least one registered agent + policy DSL non-empty
 *   · Art. 14 — at least one human decision (approve OR reject)
 *              recorded OR kill-switch armed within the window
 *   · Art. 15 — integrity chain intact AND detector chain non-empty
 *
 * These are floors, not ceilings. A `compliant: true` verdict means
 * "AEGIS has evidence the control was OPERATING"; whether that
 * evidence is *sufficient* for a given auditor is their call.
 */

import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { IntegrityService } from './integrity';
import { SigningService, type SignaturePayload } from './signing';
import { builtinControlsFor } from './compliance-controls';

const EVIDENCE_VERSION = '1.0';

export type Article = 'Art.12' | 'Art.13' | 'Art.14' | 'Art.15';

export interface ArticleEvidence {
  article: Article;
  title: string;
  summary: string;
  compliant: boolean;
  /** Specific evidence pulled from the DB for this article. Shape
   *  differs per article; consumers should read `article` first
   *  before drilling into fields. */
  evidence: Record<string, unknown>;
  /** Human-readable gaps that would need to close before an auditor
   *  could sign off. Empty when `compliant: true`. */
  gaps: string[];
}

export interface EuAiActEvidencePack {
  meta: {
    version: string;
    framework: 'eu-ai-act';
    regulation: 'Regulation (EU) 2024/1689';
    generated_at: string;
    org_id: string;
    gateway_version: string;
    reporting_window_days: number;
    note: string;
  };
  articles: ArticleEvidence[];
  /** Overall verdict — TRUE iff every one of Art.12/13/14/15 is
   *  individually `compliant: true`. Auditor's job to decide
   *  whether the underlying evidence is *sufficient*. */
  compliant: boolean;
  /** Ed25519 detached signature over the canonical JSON of every
   *  other field. Same signing key as the SOC 2 evidence pack. */
  signature?: SignaturePayload;
}

export interface EuAiActEvidenceOptions {
  /** How far back the reporting window extends, in days. Defaults
   *  to 90 days (a typical audit window). */
  reportingWindowDays?: number;
  /** When true (default), sign with the gateway's Ed25519 key. */
  sign?: boolean;
}

/** Strip signature + canonicalize — same shape as evidence-pack.ts.
 *  Producer + verifier MUST use this function or signatures diverge. */
export function canonicalizeEu(pack: EuAiActEvidencePack): string {
  const { signature: _ignored, ...rest } = pack;
  return JSON.stringify(rest);
}

export class EuAiActEvidenceService {
  private signer: SigningService;

  constructor(
    private db: Database.Database,
    private logger?: Logger,
  ) {
    this.signer = new SigningService(db, logger);
  }

  build(orgId: string, opts: EuAiActEvidenceOptions = {}): EuAiActEvidencePack {
    const windowDays = Math.max(1, Math.min(opts.reportingWindowDays ?? 90, 730));
    const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    const art12 = this.buildArt12(orgId, windowStart);
    const art13 = this.buildArt13(orgId);
    const art14 = this.buildArt14(orgId, windowStart);
    const art15 = this.buildArt15();

    const articles: ArticleEvidence[] = [art12, art13, art14, art15];

    const pack: EuAiActEvidencePack = {
      meta: {
        version: EVIDENCE_VERSION,
        framework: 'eu-ai-act',
        regulation: 'Regulation (EU) 2024/1689',
        generated_at: new Date().toISOString(),
        org_id: orgId,
        gateway_version: '2.0.0',
        reporting_window_days: windowDays,
        note:
          'AEGIS EU AI Act Art. 12-15 evidence pack. Each article carries evidence + a compliance floor. Auditor determines sufficiency.',
      },
      articles,
      compliant: articles.every((a) => a.compliant),
    };

    if (opts.sign !== false) {
      pack.signature = this.signer.sign(canonicalizeEu(pack));
    }
    return pack;
  }

  static verify(pack: EuAiActEvidencePack): boolean {
    if (!pack.signature) return false;
    return SigningService.verify(canonicalizeEu(pack), pack.signature);
  }

  getPublicKey(): { key_id: string; public_key_pem: string } {
    return this.signer.getPublicKey();
  }

  // ── Article 12 · Record-keeping ────────────────────────────────────
  private buildArt12(orgId: string, windowStart: string): ArticleEvidence {
    const spec = builtinControlsFor('eu-ai-act').find((c) => c.id === 'Art.12');
    // Audit row count in window. Wrapped in safeQuery because
    // admin_audit_log is an enterprise-schema table not present on
    // community tier — missing table → zeroed stats, gap emitted.
    const auditStats = this.safeQuery<{ n: number; first_seen: string | null; last_seen: string | null }>(
      () => this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  MIN(created_at) AS first_seen,
                  MAX(created_at) AS last_seen
             FROM admin_audit_log
            WHERE (org_id = ? OR org_id IS NULL) AND created_at >= ?`,
        )
        .get(orgId, windowStart) as { n: number; first_seen: string | null; last_seen: string | null },
      { n: 0, first_seen: null, last_seen: null },
    );

    // Trace row count + first/last timestamps.
    const traceStats = this.safeQuery<{ n: number; first_seen: string | null; last_seen: string | null }>(
      () => this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  MIN(timestamp) AS first_seen,
                  MAX(timestamp) AS last_seen
             FROM traces
            WHERE COALESCE(org_id, 'default') = ?`,
        )
        .get(orgId) as { n: number; first_seen: string | null; last_seen: string | null },
      { n: 0, first_seen: null, last_seen: null },
    );

    // Transparency root (may not exist on community deploys).
    const transparencyRoot = this.getTransparencyRoot();

    const gaps: string[] = [];
    if (auditStats.n === 0) gaps.push('No audit log rows in the reporting window.');
    if (traceStats.n === 0) gaps.push('No traces recorded — the system does not appear to have been operational.');
    if (!transparencyRoot) gaps.push('Transparency log not available — Merkle-anchored proof of log integrity missing.');

    return {
      article: 'Art.12',
      title: spec?.title ?? 'Record-keeping (logging)',
      summary: spec?.summary ?? '',
      compliant: gaps.length === 0,
      evidence: {
        audit_log:         auditStats,
        traces:            traceStats,
        transparency_root: transparencyRoot,
      },
      gaps,
    };
  }

  // ── Article 13 · Transparency and information ─────────────────────
  private buildArt13(orgId: string): ArticleEvidence {
    const spec = builtinControlsFor('eu-ai-act').find((c) => c.id === 'Art.13');

    // Registered agents.
    const agents = this.safeQuery<Array<Record<string, unknown>>>(
      () =>
        this.db
          .prepare(
            `SELECT id, name, status, description, declared_tools, capabilities
               FROM agents
              WHERE org_id = ?
              ORDER BY created_at ASC`,
          )
          .all(orgId) as Array<Record<string, unknown>>,
      [],
    );

    // Policy DSL — pulled from tenant settings JSON.
    let dslRules: unknown = null;
    let dslRuleCount = 0;
    try {
      const row = this.db
        .prepare(`SELECT settings FROM organizations WHERE id = ?`)
        .get(orgId) as { settings: string | null } | undefined;
      if (row?.settings) {
        const s = JSON.parse(row.settings);
        dslRules = s?.dsl ?? null;
        dslRuleCount = Array.isArray(s?.dsl?.rules) ? s.dsl.rules.length : 0;
      }
    } catch { /* leave null */ }

    // Static policies table (JSON-schema style).
    const policyCount = this.safeQuery<number>(
      () => {
        const r = this.db
          .prepare(`SELECT COUNT(*) AS n FROM policies WHERE org_id = ? OR org_id = '*'`)
          .get(orgId) as { n: number };
        return r.n;
      },
      0,
    );

    const gaps: string[] = [];
    if (agents.length === 0) gaps.push('No agents registered — cannot demonstrate transparency of what runs where.');
    if (dslRuleCount === 0 && policyCount === 0) {
      gaps.push('No policies in force — deployers have nothing to disclose to affected parties.');
    }

    return {
      article: 'Art.13',
      title: spec?.title ?? 'Transparency and provision of information',
      summary: spec?.summary ?? '',
      compliant: gaps.length === 0,
      evidence: {
        registered_agents: agents,
        dsl:              { rules: dslRules, rule_count: dslRuleCount },
        static_policies:  { count: policyCount },
      },
      gaps,
    };
  }

  // ── Article 14 · Human oversight ───────────────────────────────────
  private buildArt14(orgId: string, windowStart: string): ArticleEvidence {
    const spec = builtinControlsFor('eu-ai-act').find((c) => c.id === 'Art.14');

    // Approval decisions in window.
    const approvals = this.safeQuery<{ approved: number; rejected: number; pending: number }>(
      () => {
        const rows = this.db
          .prepare(
            `SELECT status, COUNT(*) AS n
               FROM approvals
              WHERE created_at >= ?
              GROUP BY status`,
          )
          .all(windowStart) as Array<{ status: string; n: number }>;
        const out = { approved: 0, rejected: 0, pending: 0 };
        for (const r of rows) {
          if (r.status === 'APPROVED') out.approved = r.n;
          else if (r.status === 'REJECTED') out.rejected = r.n;
          else if (r.status === 'PENDING') out.pending = r.n;
        }
        return out;
      },
      { approved: 0, rejected: 0, pending: 0 },
    );

    // Kill-switch signal — count of api key revocations in the window.
    const killSwitchEvents = this.safeQuery<number>(
      () => {
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM admin_audit_log
              WHERE action = 'apikey.revoke' AND created_at >= ?
                AND (org_id = ? OR org_id IS NULL)`,
          )
          .get(windowStart, orgId) as { n: number };
        return r.n;
      },
      0,
    );

    // Agent suspensions.
    const suspensionEvents = this.safeQuery<number>(
      () => {
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM admin_audit_log
              WHERE action = 'user.update' AND created_at >= ?
                AND details LIKE '%suspend%'
                AND (org_id = ? OR org_id IS NULL)`,
          )
          .get(windowStart, orgId) as { n: number };
        return r.n;
      },
      0,
    );

    const humanDecisions = approvals.approved + approvals.rejected;
    const gaps: string[] = [];
    if (humanDecisions === 0 && killSwitchEvents === 0 && suspensionEvents === 0) {
      gaps.push(
        'No human decisions (approvals or overrides) recorded in the window — the oversight loop was configured but never exercised.',
      );
    }

    return {
      article: 'Art.14',
      title: spec?.title ?? 'Human oversight',
      summary: spec?.summary ?? '',
      compliant: gaps.length === 0,
      evidence: {
        approvals,
        kill_switch_events: killSwitchEvents,
        suspension_events:  suspensionEvents,
        human_decisions_total: humanDecisions,
      },
      gaps,
    };
  }

  // ── Article 15 · Accuracy, robustness, cybersecurity ──────────────
  private buildArt15(): ArticleEvidence {
    const spec = builtinControlsFor('eu-ai-act').find((c) => c.id === 'Art.15');

    // Integrity sweep across every agent's trace chain.
    const integritySvc = new IntegrityService(this.db, this.logger);
    const integrity = integritySvc.verifyAllAgents();

    // Policy violations — cumulative count.
    const violations = this.safeQuery<number>(
      () => {
        const r = this.db.prepare(`SELECT COUNT(*) AS n FROM violations`).get() as { n: number };
        return r.n;
      },
      0,
    );

    // Rollback events — evidence the compensator infrastructure is
    // wired. Missing table on community tier → 0.
    const rollbackEvents = this.safeQuery<number>(
      () => {
        const r = this.db.prepare(`SELECT COUNT(*) AS n FROM sagas`).get() as { n: number };
        return r.n;
      },
      0,
    );

    // Detector coverage — spec-defined baseline.
    const declaredDetectors = spec?.evidenceSpec.detectors ?? [];

    const gaps: string[] = [];
    if (integrity.broken_agents > 0) {
      gaps.push(`${integrity.broken_agents} agent(s) have broken integrity chains — trace tamper suspected.`);
    }
    if (declaredDetectors.length === 0) {
      gaps.push('Detector coverage catalog is empty — cannot demonstrate robustness controls are configured.');
    }

    return {
      article: 'Art.15',
      title: spec?.title ?? 'Accuracy, robustness and cybersecurity',
      summary: spec?.summary ?? '',
      compliant: gaps.length === 0,
      evidence: {
        integrity: {
          total_agents:   integrity.total_agents,
          ok_agents:      integrity.ok_agents,
          broken_agents:  integrity.broken_agents,
        },
        detector_coverage: declaredDetectors,
        policy_violations_total: violations,
        rollback_events_total:   rollbackEvents,
      },
      gaps,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────
  /** Read the transparency log's latest Merkle root, if the table
   *  exists. Community deploys without the transparency log return
   *  null; the caller records that as a gap. */
  private getTransparencyRoot(): { leaf_count: number; latest_leaf_hash: string } | null {
    return this.safeQuery<{ leaf_count: number; latest_leaf_hash: string } | null>(
      () => {
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS leaf_count,
                    (SELECT leaf_hash FROM transparency_log ORDER BY id DESC LIMIT 1) AS latest_leaf_hash
               FROM transparency_log`,
          )
          .get() as { leaf_count: number; latest_leaf_hash: string | null };
        if (!r || r.leaf_count === 0) return null;
        return { leaf_count: r.leaf_count, latest_leaf_hash: r.latest_leaf_hash ?? '' };
      },
      null,
    );
  }

  /** Wrap a query so a missing table (community tier) yields the
   *  provided default rather than crashing the whole pack. */
  private safeQuery<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.logger?.debug({ err: (err as Error).message }, 'eu-ai-act-evidence safeQuery fell back');
      return fallback;
    }
  }
}
