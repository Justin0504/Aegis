/**
 * Anomaly behavior detector — wraps the existing `AnomalyDetector` (Isolation
 * Forest + 9 legacy signals + per-agent EWMA) into the Detector contract.
 *
 * Stateful: holds references to the runtime `AnomalyDetector`, `ProfileManager`,
 * and `SlidingWindowStats` that are already wired in `server.ts`. The plugin
 * does not allocate any new state — it's a contract adapter, not a re-impl.
 *
 * Emits a single composite signal per call, severity derived from the
 * detector's own pass/flag/escalate/block decision. The 9 per-signal sub
 * findings ride along in `evidence.signals` for explainability.
 */

import { Detector, DetectorContext, Signal, Severity } from '@agentguard/core-schema';
import { AnomalyDetector } from '../../services/anomaly-detector';
import { ProfileManager } from '../../services/profile-manager';

const NAME = 'aegis.builtin.anomaly';
const VERSION = '1.0.0';

export class AnomalyDetectorPlugin implements Detector {
  readonly name = NAME;
  readonly version = VERSION;
  readonly kind = 'behavior' as const;
  // IsolationForest + 9 baseline signals (tool novelty, freq spike, arg
  // shape drift, temporal, sequence, cost spike, risk escalation, session
  // burst). Maps to baseline-drift, runaway, scope-broadening, and the
  // long-horizon parts of defense evasion.
  readonly coverage = [
    'AAT-T2001',  // Out-of-Scope Tool Invocation (tool_never_seen signal)
    'AAT-T3001',  // New-Tool Activation
    'AAT-T3002',  // Scope Broadening (arg shape drift, scope-creep)
    'AAT-T6002',  // Instruction Stickiness Across Sessions (partial — via sequence_anomaly)
    'AAT-T8001',  // Runaway Automation (session_burst, frequency_spike)
    'AAT-T8002',  // Budget / Cost Burndown (cost_spike)
    'AAT-T9003',  // Anomaly Window Probing (we run the window — primary detector here)
  ] as const;

  constructor(
    private anomaly: AnomalyDetector,
    private profiles: ProfileManager,
  ) {}

  evaluate(ctx: DetectorContext): Signal[] {
    const profile = this.profiles.getProfile(ctx.agent.id);
    if (!profile) return [];   // cold-start, no baseline yet

    const result = this.anomaly.evaluate(
      ctx.agent.id,
      ctx.tool.name,
      ctx.tool.args,
      profile,
      'LOW',
      0,
      ctx.tenant?.id,   // seed a short-history agent from its tenant's baseline
    );

    if (result.composite_score < 0.1) return [];   // noise floor

    return [{
      detector: NAME,
      version: VERSION,
      severity: severityForDecision(result.decision),
      category: `anomaly.${result.decision}`,
      message: `behavior anomaly score ${result.composite_score.toFixed(3)} (decision: ${result.decision})`,
      evidence: {
        score: result.composite_score,
        decision: result.decision,
        signals: result.signals.map(s => ({
          type: s.type,
          score: s.score,
          detail: s.detail,
        })),
      },
    }];
  }
}

function severityForDecision(d: 'pass' | 'flag' | 'escalate' | 'block'): Severity {
  switch (d) {
    case 'pass':     return 'info';
    case 'flag':     return 'warn';
    case 'escalate':
    case 'block':    return 'critical';
  }
}
