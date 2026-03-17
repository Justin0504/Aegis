/**
 * Anomaly Detector — learning-based behavior deviation scoring
 *
 * Uses three genuinely learning-based methods:
 *   1. Isolation Forest — unsupervised multivariate anomaly scoring
 *   2. PPM-C — variable-order Markov chain for sequence anomaly
 *   3. EWMA — online incremental profile updates (via behavior-profile.ts)
 *
 * The nine per-dimension scores are computed as feature extractors,
 * then fed into an Isolation Forest that learns the structure of
 * normal behavior. Falls back to weighted average when the forest
 * has insufficient training data (< minForestSamples).
 *
 * Dimensions:
 *   1. Tool novelty        — tool never seen in baseline
 *   2. Tool frequency spike — sudden increase in call rate
 *   3. Argument shape drift — different key structure than baseline
 *   4. Argument length outlier — abnormally long/short arguments
 *   5. Temporal anomaly    — calls at unusual hours
 *   6. Sequence anomaly    — unlikely tool transition (PPM-C)
 *   7. Cost spike          — estimated cost far above baseline
 *   8. Risk escalation     — sudden increase in high-risk calls
 *   9. Session burst       — call rate spike within short window
 */

import { AgentProfile } from './behavior-profile';
import { SlidingWindowStats } from './sliding-window';
import { IsolationForest, IsolationForestConfig } from './isolation-forest';
import { PPMModel } from './ppm';

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
  composite_score: number;   // 0-1, Isolation Forest or weighted fallback
  signals: AnomalySignal[];
  decision: AnomalyDecision;
  /** Which scoring method was used */
  scoring_method: 'isolation_forest' | 'weighted_fallback';
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

export interface ForestConfig {
  numTrees: number;
  sampleSize: number;
  minSamples: number;
}

export interface PPMConfig {
  maxOrder: number;
  surpriseScale: number;
}

const DEFAULT_FOREST_CONFIG: ForestConfig = {
  numTrees: 100,
  sampleSize: 256,
  minSamples: 30,
};

const DEFAULT_PPM_CONFIG: PPMConfig = {
  maxOrder: 4,
  surpriseScale: 3.0,
};

// ── Detector ────────────────────────────────────────────────────────────────

export class AnomalyDetector {
  private forests: Map<string, IsolationForest> = new Map();
  private ppmModels: Map<string, PPMModel> = new Map();
  private forestConfig: ForestConfig;
  private ppmConfig: PPMConfig;

  constructor(
    private slidingWindow: SlidingWindowStats,
    private weights: AnomalyWeights = DEFAULT_WEIGHTS,
    private thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
    forestConfig?: Partial<ForestConfig>,
    ppmConfig?: Partial<PPMConfig>,
  ) {
    this.forestConfig = { ...DEFAULT_FOREST_CONFIG, ...forestConfig };
    this.ppmConfig = { ...DEFAULT_PPM_CONFIG, ...ppmConfig };
  }

  /**
   * Evaluate a tool call against an agent's behavioral profile.
   * Uses Isolation Forest for composite scoring when trained,
   * falls back to weighted average otherwise.
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

    // 6. Sequence anomaly (PPM-C)
    signals.push(this.checkSequenceAnomaly(agentId, toolName, profile));

    // 7. Cost spike
    signals.push(this.checkCostSpike(costUsd, profile));

    // 8. Risk escalation
    signals.push(this.checkRiskEscalation(agentId, profile));

    // 9. Session burst
    signals.push(this.checkSessionBurst(agentId, profile));

    // Build feature vector from signal scores
    const featureVector = signals.map(s => s.score);

    // Composite scoring: Isolation Forest or weighted fallback
    const forest = this.getOrCreateForest(agentId, profile);
    let composite: number;
    let scoringMethod: 'isolation_forest' | 'weighted_fallback';

    if (forest.isTrained && forest.sampleCount >= this.forestConfig.minSamples) {
      // Isolation Forest scoring — data-driven, no hardcoded weights
      composite = forest.score(featureVector);
      scoringMethod = 'isolation_forest';
    } else {
      // Fallback: weighted average (cold-start)
      composite = this.weightedFallback(signals);
      scoringMethod = 'weighted_fallback';
    }

    // Incrementally train the forest on this observation
    forest.addSample(featureVector);

    // Update PPM model for next sequence prediction
    const ppm = this.getOrCreatePPM(agentId, profile);
    ppm.update(toolName);

    // Store updated forest/PPM state back to profile for persistence
    profile.forestState = forest.serialize();
    profile.ppmState = ppm.serialize();

    const decision = this.decide(composite);

    return {
      composite_score: Math.round(composite * 1000) / 1000,
      signals: signals.filter(s => s.score > 0),
      decision,
      scoring_method: scoringMethod,
    };
  }

  // ── Isolation Forest Management ───────────────────────────────────────────

  private getOrCreateForest(agentId: string, profile: AgentProfile): IsolationForest {
    let forest = this.forests.get(agentId);
    if (forest) return forest;

    // Try to restore from profile
    if (profile.forestState) {
      try {
        forest = IsolationForest.deserialize(profile.forestState);
        this.forests.set(agentId, forest);
        return forest;
      } catch { /* fall through to create new */ }
    }

    // Create new forest, optionally seeded from historical samples
    forest = new IsolationForest({
      numTrees: this.forestConfig.numTrees,
      sampleSize: this.forestConfig.sampleSize,
    });

    if (profile.forestSamples && profile.forestSamples.length > 0) {
      forest.fit(profile.forestSamples);
    }

    this.forests.set(agentId, forest);
    return forest;
  }

  // ── PPM Model Management ─────────────────────────────────────────────────

  private getOrCreatePPM(agentId: string, profile: AgentProfile): PPMModel {
    let ppm = this.ppmModels.get(agentId);
    if (ppm) return ppm;

    // Try to restore from profile
    if (profile.ppmState) {
      try {
        ppm = PPMModel.deserialize(profile.ppmState);
        this.ppmModels.set(agentId, ppm);
        return ppm;
      } catch { /* fall through */ }
    }

    // Create new PPM model
    ppm = new PPMModel(this.ppmConfig.maxOrder);
    this.ppmModels.set(agentId, ppm);
    return ppm;
  }

  // ── Individual Feature Extractors ─────────────────────────────────────────

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

    const baselinePerMin = dist.count / (profile.windowDays * 24 * 60);
    const currentPerMin = this.slidingWindow.getToolFrequency(agentId, toolName, 300);

    if (baselinePerMin === 0) {
      return this.noDataSignal(AnomalyType.TOOL_FREQUENCY_SPIKE);
    }

    const ratio = currentPerMin / baselinePerMin;
    const zscore = Math.max(0, ratio - 1);
    const score = sigmoid(zscore - 2);

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
    const score = sigmoid(zscore - 3);

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
    let score = 0;
    if (density < 0.005) score = 0.9;
    else if (density < 0.01) score = 0.7;
    else if (density < 0.02) score = 0.3;

    return {
      type: AnomalyType.TEMPORAL_ANOMALY,
      score,
      zscore: density > 0 ? (1 / 24 - density) / (1 / 24) : 10,
      detail: `hour ${hour} UTC has ${(density * 100).toFixed(1)}% of baseline traffic`,
      baseline_value: density,
      observed_value: 1,
    };
  }

  /**
   * Sequence anomaly — uses PPM-C variable-order Markov chain
   * instead of simple bigram transition matrix.
   */
  private checkSequenceAnomaly(
    agentId: string, toolName: string, profile: AgentProfile,
  ): AnomalySignal {
    const prevTool = this.slidingWindow.getLastTool(agentId);
    if (!prevTool) {
      return this.noDataSignal(AnomalyType.SEQUENCE_ANOMALY);
    }

    // Try PPM model first
    const ppm = this.getOrCreatePPM(agentId, profile);
    if (ppm.alphabetSize >= 2) {
      const prob = ppm.predict(toolName);
      const surprise = ppm.surprise(toolName);
      // Convert surprise to [0, 1] score: score = 1 - e^(-surprise/scale)
      const score = 1 - Math.exp(-surprise / this.ppmConfig.surpriseScale);

      return {
        type: AnomalyType.SEQUENCE_ANOMALY,
        score: Math.min(score, 1.0),
        zscore: surprise,
        detail: `PPM surprise=${surprise.toFixed(2)} prob=${(prob * 100).toFixed(1)}% context=[${ppm.getContext().slice(-3).join(',')}]→${toolName}`,
        baseline_value: prob,
        observed_value: surprise,
      };
    }

    // Fallback to bigram if PPM has no data yet
    const transitions = profile.transitionMatrix[prevTool];
    if (!transitions) {
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
    const score = prob === 0 ? 1.0 : Math.max(0, 1 - prob * 3);

    return {
      type: AnomalyType.SEQUENCE_ANOMALY,
      score,
      zscore: prob > 0 ? (1 - prob) / Math.max(prob, 0.01) : 10,
      detail: `bigram ${prevTool} → ${toolName}: baseline probability ${(prob * 100).toFixed(1)}%`,
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
    const recentHighRate = this.slidingWindow.getHighRiskRate(agentId, 600);

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
    const recentCount = this.slidingWindow.getCallCount(agentId, 60);
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

  // ── Scoring ─────────────────────────────────────────────────────────────

  /** Weighted average fallback for cold-start (< minSamples in forest) */
  private weightedFallback(signals: AnomalySignal[]): number {
    let weightSum = 0;
    let scoreSum = 0;
    for (const signal of signals) {
      const w = this.weights[signal.type];
      if (signal.score > 0 || signal.zscore !== 0) {
        scoreSum += signal.score * w;
        weightSum += w;
      } else {
        if (signal.detail !== 'insufficient_data') {
          weightSum += w;
        }
      }
    }
    return weightSum > 0 ? scoreSum / weightSum : 0;
  }

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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
