/**
 * Compensation registry — per-tenant declarations of how each tool's
 * actions can be undone.
 *
 * Lives in tenant config so customers can edit it in the Cockpit
 * without a code deploy. Three declaration shapes are supported:
 *
 *  1. `webhook` — POST to a customer-owned URL with the rollback
 *     payload. The customer's own service does the inverse action
 *     (e.g. their DB API exposes /undo_insert). Most common.
 *
 *  2. `inline` — a small templated SQL or HTTP command stored inline.
 *     Used for the simple cases (DELETE-by-id, file restore). The
 *     gateway executes it directly via the same proxy adapter that
 *     ran the original.
 *
 *  3. `none` — explicit "we know we can't undo this; if rollback is
 *     requested, emit a correction-only audit row but don't pretend
 *     to have rolled back." Required for irreversible tools whose
 *     handlers exist for correction (e.g. send retraction email).
 *
 * The registry is the SOURCE OF TRUTH for what AEGIS will actually
 * execute on rollback. RollbackService never invents a compensator;
 * if none is registered for a compensable tool, rollback fails with
 * `no_compensator_registered` and the operator gets a clear pointer
 * to the missing config.
 */

import { Logger } from 'pino';

export type CompensatorKind = 'webhook' | 'inline' | 'none';

/**
 * Operator-facing hint about how expensive it is to run this compensator.
 * Surfaced in the rollback preview API so a human approver can decide
 * whether to require an extra sign-off (see PAUSED_FOR_APPROVAL saga
 * state). Ordinal magnitude is the load-bearing field; `amount` /
 * `currency` are hints for the cockpit UI.
 *
 * Basel BCBS-239 §4 asks for "materiality-graded change events" —
 * this field is how AEGIS answers that for automated rollbacks.
 */
export interface CostEstimate {
  /** Ordinal magnitude the cockpit sorts on. `catastrophic` should
   *  force human approval regardless of other policy signals. */
  magnitude: 'trivial' | 'low' | 'medium' | 'high' | 'catastrophic';
  /** Free-form unit label — 'USD', 'PHI-records', 'API-req', 'seconds'.
   *  Purely a UI hint; not interpreted. */
  currency?: string;
  /** Numeric estimate in `currency` units when known. */
  amount?: number;
  /** Human-facing note surfaced in the approval queue. */
  note?: string;
}

export interface CompensatorWebhook {
  kind: 'webhook';
  /** Operator-owned URL the gateway POSTs to with `{trace, hint}`. */
  url: string;
  /** Optional auth header (e.g. "Bearer ..."). Forwarded verbatim. */
  authorization?: string;
  /** Hard timeout per attempt in ms. Default 5000. */
  timeout_ms?: number;
  /** How many retries on 5xx / network error. Default 2 (3 total tries). */
  retries?: number;
  /** Optional cost hint — see CostEstimate. When magnitude is 'high'
   *  or 'catastrophic', the RollbackService pauses the saga for human
   *  approval before firing. */
  cost_estimate?: CostEstimate;
}

export interface CompensatorInline {
  kind: 'inline';
  /** Templated command. AEGIS substitutes `{{trace.tool_call.arguments.<key>}}`
   *  placeholders before sending. The string is opaque to AEGIS —
   *  whoever consumes it (proxy adapter for HTTP tools, SQL for db
   *  tools) is responsible for interpretation. */
  template: string;
  /** Which proxy adapter / executor this template targets. */
  target: 'http' | 'sql' | 'shell';
  cost_estimate?: CostEstimate;
}

export interface CompensatorNone {
  kind: 'none';
  /** Audit row text explaining why this tool can't be undone. */
  note: string;
  cost_estimate?: CostEstimate;
}

/** Magnitudes that force `PAUSED_FOR_APPROVAL` before execution. */
export const HIGH_COST_MAGNITUDES: ReadonlyArray<CostEstimate['magnitude']> =
  ['high', 'catastrophic'];

export type CompensatorDecl = CompensatorWebhook | CompensatorInline | CompensatorNone;

export interface CompensationConfig {
  /** Map of tool_name → compensator declaration. */
  compensators: Record<string, CompensatorDecl>;
}

export interface CompensationLookupResult {
  /** Compensator declaration, or null if none registered. */
  compensator: CompensatorDecl | null;
  /** True if the tool is registered but explicitly `kind:'none'`. */
  explicitlyUnrollable: boolean;
}

/**
 * Lightweight per-tenant lookup wrapper. State lives in tenant_config,
 * loaded by TenantConfigService and passed in via setConfig.
 */
export class CompensationRegistry {
  private byTenant: Map<string, CompensationConfig> = new Map();

  constructor(private readonly logger: Logger) {}

  /** Replace the compensation config for one tenant. Called by
   *  ConfigBus subscriber whenever tenant_config.rollback changes. */
  setConfig(orgId: string, config: CompensationConfig | null): void {
    if (!config) {
      this.byTenant.delete(orgId);
      this.logger.debug({ orgId }, 'compensation config cleared');
      return;
    }
    this.byTenant.set(orgId, config);
    this.logger.debug({ orgId, count: Object.keys(config.compensators ?? {}).length }, 'compensation config loaded');
  }

  /** Look up the compensator for a (tenant, tool) pair. */
  lookup(orgId: string, toolName: string): CompensationLookupResult {
    const cfg = this.byTenant.get(orgId);
    const compensator = cfg?.compensators?.[toolName] ?? null;
    return {
      compensator,
      explicitlyUnrollable: !!compensator && compensator.kind === 'none',
    };
  }

  /** Substitute `{{trace.tool_call.arguments.<key>}}` references in
   *  an inline template against a concrete trace. Unknown paths leave
   *  the placeholder verbatim — the executor will surface that as a
   *  template-failure if it actually needs the value. */
  static renderTemplate(template: string, trace: Record<string, any>): string {
    return template.replace(/\{\{\s*([\w.[\]'"]+)\s*\}\}/g, (_match, path) => {
      const v = resolvePath(trace, path);
      return v === undefined ? `{{${path}}}` : String(v);
    });
  }
}

function resolvePath(obj: any, path: string): unknown {
  const parts = path.split('.').map(s => s.trim()).filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
