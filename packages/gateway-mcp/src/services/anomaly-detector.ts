/**
 * Anomaly Detector — learning-based behavior deviation scoring
 *
 * Nine-dimensional detector that scores how much a tool call deviates
 * from the agent's historical baseline profile. Pure statistical methods,
 * no external ML dependencies, runs in-process with < 5ms latency.
 *
 * Dimensions:
 *   1. Tool novelty        — tool never seen in baseline
 *   2. Tool frequency spike — sudden increase in call rate
 *   3. Argument shape drift — different key structure than baseline
 *   4. Argument length outlier — abnormally long/short arguments
 *   5. Temporal anomaly    — calls at unusual hours
 *   6. Sequence anomaly    — unlikely tool transition (bigram)
 *   7. Cost spike          — estimated cost far above baseline
 *   8. Risk escalation     — sudden increase in high-risk calls
 *   9. Session burst       — call rate spike within short window
 */

import { AgentProfile } from './behavior-profile';
import { SlidingWindowStats } from './sliding-window';

// ── Types ───────────────────────────────────────────────────────────────────

export enum AnomalyType {
  TOOL_NEVER_SEEN      = 'tool_never_seen',
  TOOL_FREQUENCY_SPIKE = 'tool_frequency_spike',
  ARG_SHAPE_DRIFT      = 'arg_shape_drift',
  ARG_LENGTH_OUTLIER   = 'arg_length_outlier',
  TEMPORAL_ANOMALY     = 'temporal_anomaly',
  SEQUENCE_ANOMALY     = 'sequence_anomaly',
  COST_SPIKE           = 'cost_spike',
  RISK_ESCALATION      = 'risk_escalation',
  SESSION_BURST        = 'session_burst',
}

export interface AnomalySignal {
  type: AnomalyType;
  score: number;          // 0-1, higher = more anomalous
  zscore: number;         // standard deviations from mean
  detail: string;
  baseline_value: number;
  observed_value: number;
}

export type AnomalyDecision = 'pass' | 'flag' | 'escalate' | 'block';

export interface AnomalyResult {
  composite_score: number;   // 0-1, weighted aggregate
  signals: AnomalySignal[];
  decision: AnomalyDecision;
}

export interface AnomalyThresholds {
  flag: number;      // default 0.3
  escalate: number;  // default 0.6
  block: number;     // default 0.85
}

export interface AnomalyWeights {
  [AnomalyType.TOOL_NEVER_SEEN]: number;
  [AnomalyType.TOOL_FREQUENCY_SPIKE]: number;
  [AnomalyType.ARG_SHAPE_DRIFT]: number;
  [AnomalyType.ARG_LENGTH_OUTLIER]: number;
  [AnomalyType.TEMPORAL_ANOMALY]: number;
  [AnomalyType.SEQUENCE_ANOMALY]: number;
  [AnomalyType.COST_SPIKE]: number;
  [AnomalyType.RISK_ESCALATION]: number;
  [AnomalyType.SESSION_BURST]: number;
}

export const DEFAULT_WEIGHTS: AnomalyWeights = {
  [AnomalyType.TOOL_NEVER_SEEN]:      0.20,
  [AnomalyType.TOOL_FREQUENCY_SPIKE]: 0.12,
  [AnomalyType.ARG_SHAPE_DRIFT]:      0.15,
  [AnomalyType.ARG_LENGTH_OUTLIER]:   0.10,
  [AnomalyType.TEMPORAL_ANOMALY]:     0.08,
  [AnomalyType.SEQUENCE_ANOMALY]:     0.15,
  [AnomalyType.COST_SPIKE]:           0.08,
  [AnomalyType.RISK_ESCALATION]:      0.07,
  [AnomalyType.SESSION_BURST]:        0.05,
};

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  flag: 0.3,
  escalate: 0.6,
  block: 0.85,
};

// ── Detector ────────────────────────────────────────────────────────────────

export class AnomalyDetector {
  constructor(
    private slidingWindow: SlidingWindowStats,
    private weights: AnomalyWeights = DEFAULT_WEIGHTS,
    private thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /**
   * Evaluate a tool call against an agent's behavioral profile.
   * Returns composite anomaly score and per-dimension signals.
   */
  evaluate(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    profile: AgentProfile,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW',
    costUsd: number = 0,
  ): AnomalyResult {
    const signals: AnomalySignal[] = [];

    // 1. Tool novelty
    signals.push(this.checkToolNovelty(toolName, profile));

    // 2. Tool frequency spike
    signals.push(this.checkFrequencySpike(agentId, toolName, profile));

    // 3. Argument shape drift
    signals.push(this.checkArgShapeDrift(toolName, args, profile));

    // 4. Argument length outlier
    signals.push(this.checkArgLengthOutlier(toolName, args, profile));

    // 5. Temporal anomaly
    signals.push(this.checkTemporalAnomaly(profile));

    // 6. Sequence anomaly
    signals.push(this.checkSequenceAnomaly(agentId, toolName, profile));

    // 7. Cost spike
    signals.push(this.checkCostSpike(costUsd, profile));

    // 8. Risk escalation
    signals.push(this.checkRiskEscalation(agentId, profile));

    // 9. Session burst
    signals.push(this.checkSessionBurst(agentId, profile));

    // Weighted aggregation — only count dimensions with data
    let weightSum = 0;
    let scoreSum = 0;
    for (const signal of signals) {
      const w = this.weights[signal.type];
      // Skip dimensions that returned score 0 with zscore 0
      // (no data available for this dimension)
      if (signal.score > 0 || signal.zscore !== 0) {
        scoreSum += signal.score * w;
        weightSum += w;
      } else {
        // Still include weight if dimension had data but scored 0
        // (meaning it was normal). Only skip if truly no data.
        if (signal.detail !== 'insufficient_data') {
          weightSum += w;
        }
      }
    }

    const composite = weightSum > 0 ? scoreSum / weightSum : 0;
    const decision = this.decide(composite);

    return {
      composite_score: Math.round(composite * 1000) / 1000,
      signals: signals.filter(s => s.score > 0),
      decision,
    };
  }

  // ── Individual Detectors ──────────────────────────────────────────────────

  private checkToolNovelty(toolName: string, profile: AgentProfile): AnomalySignal {
    const known = profile.knownTools.includes(toolName);
    return {
      type: AnomalyType.TOOL_NEVER_SEEN,
      score: known ? 0 : 1.0,
      zscore: known ? 0 : Infinity,
      detail: known ? 'known tool' : `tool "${toolName}" never seen in baseline`,
      baseline_value: profile.knownTools.length,
      observed_value: known ? 1 : 0,
    };
  }

  private checkFrequencySpike(
    agentId: string, toolName: string, profile: AgentProfile,
  ): AnomalySignal {
    const dist = profile.toolDistribution[toolName];
    if (!dist) {
      return this.noDataSignal(AnomalyType.TOOL_FREQUENCY_SPIKE);
    }

    // Baseline: calls per minute over profile window
    const baselinePerMin = dist.count / (profile.windowDays * 24 * 60);
    // Current: calls per minute in last 5 minutes
    const currentPerMin = this.slidingWindow.getToolFrequency(agentId, toolName, 300);

    if (baselinePerMin === 0) {
      return this.noDataSignal(AnomalyType.TOOL_FREQUENCY_SPIKE);
    }

    const ratio = currentPerMin / baselinePerMin;
    const zscore = Math.max(0, ratio - 1); // how many "baseline rates" above normal
    const score = sigmoid(zscore - 2); // starts scoring at 2x baseline

    return {
      type: AnomalyType.TOOL_FREQUENCY_SPIKE,
      score,
      zscore,
      detail: `${toolName} rate ${currentPerMin.toFixed(2)}/min vs baseline ${baselinePerMin.toFixed(4)}/min (${ratio.toFixed(1)}x)`,
      baseline_value: baselinePerMin,
      observed_value: currentPerMin,
    };
  }

  private checkArgShapeDrift(
    toolName: string, args: Record<string, unknown>, profile: AgentProfile,
  ): AnomalySignal {
    const fp = profile.argumentFingerprints[toolName];
    if (!fp || fp.knownKeySets.length === 0) {
      return this.noDataSignal(AnomalyType.ARG_SHAPE_DRIFT);
    }

    const currentKeys = Object.keys(args).sort().join(',');
    // Check exact match first (fast path)
    if (fp.knownKeySets.includes(currentKeys)) {
      return {
        type: AnomalyType.ARG_SHAPE_DRIFT,
        score: 0,
        zscore: 0,
        detail: 'argument shape matches known pattern',
        baseline_value: fp.knownKeySets.length,
        observed_value: 1,
      };
    }

    // Jaccard similarity against best match
    const currentKeySet = new Set(Object.keys(args));
    let bestJaccard = 0;
    for (const ksStr of fp.knownKeySets) {
      const knownKeys = new Set(ksStr.split(',').filter(Boolean));
      const intersection = new Set([...currentKeySet].filter(k => knownKeys.has(k)));
      const union = new Set([...currentKeySet, ...knownKeys]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 1;
      if (jaccard > bestJaccard) bestJaccard = jaccard;
    }

    const score = 1 - bestJaccard;
    return {
      type: AnomalyType.ARG_SHAPE_DRIFT,
      score,
      zscore: score > 0 ? 1 / bestJaccard : 0,
      detail: `argument keys differ from baseline (jaccard=${bestJaccard.toFixed(2)})`,
      baseline_value: bestJaccard,
      observed_value: 1 - bestJaccard,
    };
  }

  private checkArgLengthOutlier(
    toolName: string, args: Record<string, unknown>, profile: AgentProfile,
  ): AnomalySignal {
    const fp = profile.argumentFingerprints[toolName];
    if (!fp || fp.stdArgLength === 0) {
      return this.noDataSignal(AnomalyType.ARG_LENGTH_OUTLIER);
    }

    const observed = JSON.stringify(args).length;
    const zscore = Math.abs(observed - fp.avgArgLength) / Math.max(fp.stdArgLength, 1);
    const score = sigmoid(zscore - 3); // starts scoring at 3 std devs

    return {
      type: AnomalyType.ARG_LENGTH_OUTLIER,
      score,
      zscore,
      detail: `arg length ${observed} vs baseline μ=${fp.avgArgLength.toFixed(0)} σ=${fp.stdArgLength.toFixed(0)} (z=${zscore.toFixed(1)})`,
      baseline_value: fp.avgArgLength,
      observed_value: observed,
    };
  }

  private checkTemporalAnomaly(profile: AgentProfile): AnomalySignal {
    const hour = new Date().getUTCHours();
    const totalCalls = profile.temporalPattern.hourDistribution.reduce((a, b) => a + b, 0);
    if (totalCalls === 0) {
      return this.noDataSignal(AnomalyType.TEMPORAL_ANOMALY);
    }

    const density = profile.temporalPattern.hourDistribution[hour] / totalCalls;

    // If this hour had < 1% of total traffic, it's unusual
    let score = 0;
    if (density < 0.005) score = 0.9;      // < 0.5% — very unusual
    else if (density < 0.01) score = 0.7;   // < 1%
    else if (density < 0.02) score = 0.3;   // < 2%
    else score = 0;

    return {
      type: AnomalyType.TEMPORAL_ANOMALY,
      score,
      zscore: density > 0 ? (1 / 24 - density) / (1 / 24) : 10,
      detail: `hour ${hour} UTC has ${(density * 100).toFixed(1)}% of baseline traffic`,
      baseline_value: density,
      observed_value: 1,
    };
  }

  private checkSequenceAnomaly(
    agentId: string, toolName: string, profile: AgentProfile,
  ): AnomalySignal {
    const prevTool = this.slidingWindow.getLastTool(agentId);
    if (!prevTool) {
      return this.noDataSignal(AnomalyType.SEQUENCE_ANOMALY);
    }

    const transitions = profile.transitionMatrix[prevTool];
    if (!transitions) {
      // Previous tool never seen in baseline transitions
      return {
        type: AnomalyType.SEQUENCE_ANOMALY,
        score: 0.8,
        zscore: 5,
        detail: `transition ${prevTool} → ${toolName}: source tool has no baseline transitions`,
        baseline_value: 0,
        observed_value: 1,
      };
    }

    const prob = transitions[toolName] ?? 0;
    const score = prob === 0 ? 1.0 : Math.max(0, 1 - prob * 3); // scale: prob=0.33 → score≈0

    return {
      type: AnomalyType.SEQUENCE_ANOMALY,
      score,
      zscore: prob > 0 ? (1 - prob) / Math.max(prob, 0.01) : 10,
      detail: `transition ${prevTool} → ${toolName}: baseline probability ${(prob * 100).toFixed(1)}%`,
      baseline_value: prob,
      observed_value: prob === 0 ? 0 : 1,
    };
  }

  private checkCostSpike(costUsd: number, profile: AgentProfile): AnomalySignal {
    const { meanCostUsd, stdCostUsd } = profile.costBaseline;
    if (meanCostUsd === 0 && stdCostUsd === 0) {
      return this.noDataSignal(AnomalyType.COST_SPIKE);
    }

    const zscore = Math.abs(costUsd - meanCostUsd) / Math.max(stdCostUsd, 0.0001);
    const score = sigmoid(zscore - 3);

    return {
      type: AnomalyType.COST_SPIKE,
      score,
      zscore,
      detail: `cost $${costUsd.toFixed(4)} vs baseline μ=$${meanCostUsd.toFixed(4)} σ=$${stdCostUsd.toFixed(4)}`,
      baseline_value: meanCostUsd,
      observed_value: costUsd,
    };
  }

  private checkRiskEscalation(agentId: string, profile: AgentProfile): AnomalySignal {
    const baselineHighRate = profile.riskDistribution.HIGH + profile.riskDistribution.CRITICAL;
    const recentHighRate = this.slidingWindow.getHighRiskRate(agentId, 600); // 10 min

    if (baselineHighRate === 0 && recentHighRate === 0) {
      return {
        type: AnomalyType.RISK_ESCALATION,
        score: 0,
        zscore: 0,
        detail: 'no high-risk calls in baseline or recent window',
        baseline_value: 0,
        observed_value: 0,
      };
    }

    // If baseline has no high-risk but we see some now
    if (baselineHighRate < 0.01 && recentHighRate > 0) {
      return {
        type: AnomalyType.RISK_ESCALATION,
        score: Math.min(recentHighRate * 2, 1.0),
        zscore: 10,
        detail: `recent high-risk rate ${(recentHighRate * 100).toFixed(0)}% vs baseline ${(baselineHighRate * 100).toFixed(1)}%`,
        baseline_value: baselineHighRate,
        observed_value: recentHighRate,
      };
    }

    const ratio = recentHighRate / Math.max(baselineHighRate, 0.001);
    const score = ratio > 3 ? Math.min((ratio - 3) / 7, 1.0) : 0;

    return {
      type: AnomalyType.RISK_ESCALATION,
      score,
      zscore: ratio,
      detail: `recent high-risk rate ${(recentHighRate * 100).toFixed(0)}% vs baseline ${(baselineHighRate * 100).toFixed(1)}% (${ratio.toFixed(1)}x)`,
      baseline_value: baselineHighRate,
      observed_value: recentHighRate,
    };
  }

  private checkSessionBurst(agentId: string, profile: AgentProfile): AnomalySignal {
    const recentCount = this.slidingWindow.getCallCount(agentId, 60); // last 1 min
    const baselinePerMin = profile.traceCount / (profile.windowDays * 24 * 60);

    if (baselinePerMin === 0) {
      return this.noDataSignal(AnomalyType.SESSION_BURST);
    }

    const ratio = recentCount / baselinePerMin;
    const zscore = Math.max(0, ratio - 1);
    const score = sigmoid(zscore - 3);

    return {
      type: AnomalyType.SESSION_BURST,
      score,
      zscore,
      detail: `${recentCount} calls/min vs baseline ${baselinePerMin.toFixed(2)}/min (${ratio.toFixed(1)}x)`,
      baseline_value: baselinePerMin,
      observed_value: recentCount,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private decide(composite: number): AnomalyDecision {
    if (composite >= this.thresholds.block) return 'block';
    if (composite >= this.thresholds.escalate) return 'escalate';
    if (composite >= this.thresholds.flag) return 'flag';
    return 'pass';
  }

  private noDataSignal(type: AnomalyType): AnomalySignal {
    return {
      type,
      score: 0,
      zscore: 0,
      detail: 'insufficient_data',
      baseline_value: 0,
      observed_value: 0,
    };
  }
}

// ── Math ────────────────────────────────────────────────────────────────────

/** Sigmoid function mapped to [0, 1], centered at x=0 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
