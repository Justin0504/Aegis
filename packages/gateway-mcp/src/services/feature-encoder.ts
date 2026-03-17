/**
 * Feature Encoder — converts raw tool call data into a normalized
 * numeric feature vector for the Isolation Forest.
 *
 * Instead of hand-coding sigmoid(zscore - K) heuristics, this encoder:
 *   1. Extracts raw numeric features from the observation + profile
 *   2. Normalizes each feature via per-agent EWMA mean/variance
 *   3. Outputs a fixed-width vector the IF can learn from directly
 *
 * 16 dimensions across 6 feature groups:
 *   Tool identity (3):  novelty, frequency_ratio, recency_rank
 *   Arguments (3):      jaccard_distance, length_zscore, key_count_ratio
 *   Temporal (3):       hour_deviation, interval_zscore, burst_ratio
 *   Sequence (2):       ppm_surprise, bigram_prob
 *   Cost/Risk (3):      cost_zscore, risk_ordinal, high_risk_rate_ratio
 *   Burst (2):          call_rate_ratio, tool_rate_ratio
 *
 * Pure TypeScript, zero dependencies, < 0.1ms per encode.
 */

import { AgentProfile } from './behavior-profile';
import { SlidingWindowStats } from './sliding-window';
import { PPMModel } from './ppm';

export const FEATURE_DIM = 16;

export interface RawObservation {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  costUsd: number;
  timestampMs: number;
}

/** Per-agent online normalization state */
export interface FeatureStats {
  mean: number[];
  variance: number[];
  n: number;
}

const RISK_ORDINAL: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export class FeatureEncoder {
  constructor(
    private slidingWindow: SlidingWindowStats,
  ) {}

  /**
   * Encode a raw observation into a 16-dim normalized feature vector.
   * If featureStats is absent (cold start), returns raw un-normalized features.
   */
  encode(
    agentId: string,
    obs: RawObservation,
    profile: AgentProfile,
    ppm: PPMModel | null,
  ): number[] {
    const raw = this.extractRaw(agentId, obs, profile, ppm);

    // Online normalization using per-agent stats
    const stats = profile.featureStats;
    if (!stats || stats.n < 10) {
      return raw; // Not enough data to normalize — return raw
    }

    const normalized = new Array(FEATURE_DIM);
    for (let i = 0; i < FEATURE_DIM; i++) {
      const std = Math.sqrt(stats.variance[i] + 1e-8);
      normalized[i] = (raw[i] - stats.mean[i]) / std;
    }
    return normalized;
  }

  /**
   * Extract raw (un-normalized) features from observation + profile.
   */
  extractRaw(
    agentId: string,
    obs: RawObservation,
    profile: AgentProfile,
    ppm: PPMModel | null,
  ): number[] {
    const features = new Array(FEATURE_DIM).fill(0);

    // ── Tool identity (dims 0-2) ─────────────────────────────────────
    // 0: tool novelty (binary)
    features[0] = profile.knownTools.includes(obs.toolName) ? 0 : 1;

    // 1: tool frequency ratio (observed recent / baseline)
    const dist = profile.toolDistribution[obs.toolName];
    if (dist && dist.count > 0) {
      const baselinePerMin = dist.count / (profile.windowDays * 24 * 60);
      const currentPerMin = this.slidingWindow.getToolFrequency(agentId, obs.toolName, 300);
      features[1] = baselinePerMin > 0 ? currentPerMin / baselinePerMin : 0;
    }

    // 2: tool recency rank (0 = most recent tool, normalized by tool count)
    if (profile.knownTools.length > 0) {
      const sorted = Object.entries(profile.toolDistribution)
        .sort((a, b) => (b[1].lastSeen || '').localeCompare(a[1].lastSeen || ''));
      const rank = sorted.findIndex(([name]) => name === obs.toolName);
      features[2] = rank >= 0 ? rank / Math.max(profile.knownTools.length, 1) : 1;
    }

    // ── Arguments (dims 3-5) ─────────────────────────────────────────
    const fp = profile.argumentFingerprints[obs.toolName];

    // 3: Jaccard distance (1 - similarity)
    if (fp && fp.knownKeySets.length > 0) {
      const currentKeys = new Set(Object.keys(obs.args));
      let bestJaccard = 0;
      for (const ksStr of fp.knownKeySets) {
        const knownKeys = new Set(ksStr.split(',').filter(Boolean));
        const intersection = new Set([...currentKeys].filter(k => knownKeys.has(k)));
        const union = new Set([...currentKeys, ...knownKeys]);
        const jaccard = union.size > 0 ? intersection.size / union.size : 1;
        if (jaccard > bestJaccard) bestJaccard = jaccard;
      }
      features[3] = 1 - bestJaccard;
    }

    // 4: argument length z-score (raw, not sigmoided)
    if (fp && fp.stdArgLength > 0) {
      const argLen = JSON.stringify(obs.args).length;
      features[4] = Math.abs(argLen - fp.avgArgLength) / fp.stdArgLength;
    }

    // 5: key count ratio (current / baseline avg)
    if (fp && fp.avgKeyCount > 0) {
      features[5] = Object.keys(obs.args).length / fp.avgKeyCount;
    }

    // ── Temporal (dims 6-8) ──────────────────────────────────────────
    // 6: hour deviation (density of current hour vs uniform 1/24)
    const hour = new Date(obs.timestampMs).getUTCHours();
    const totalCalls = profile.temporalPattern.hourDistribution.reduce((s, h) => s + h, 0);
    if (totalCalls > 0) {
      const density = profile.temporalPattern.hourDistribution[hour] / totalCalls;
      const uniform = 1 / 24;
      features[6] = Math.abs(density - uniform) / uniform; // 0 = perfectly normal
    }

    // 7: inter-call interval z-score
    if (profile.temporalPattern.meanIntervalSec > 0 && profile.temporalPattern.stdIntervalSec > 0) {
      const lastCall = profile.ewma?.lastUpdateMs ?? obs.timestampMs;
      const interval = (obs.timestampMs - lastCall) / 1000;
      if (interval > 0 && interval < 86400) {
        features[7] = Math.abs(interval - profile.temporalPattern.meanIntervalSec)
          / Math.max(profile.temporalPattern.stdIntervalSec, 1);
      }
    }

    // 8: burst ratio (calls in last 60s / baseline per minute)
    const baselinePerMin = profile.traceCount / (profile.windowDays * 24 * 60);
    if (baselinePerMin > 0) {
      const recentCount = this.slidingWindow.getCallCount(agentId, 60);
      features[8] = recentCount / baselinePerMin;
    }

    // ── Sequence (dims 9-10) ─────────────────────────────────────────
    // 9: PPM surprise (raw nats)
    if (ppm && ppm.alphabetSize >= 2) {
      features[9] = ppm.surprise(obs.toolName);
    }

    // 10: bigram transition probability (raw, 0 = never seen)
    const prevTool = this.slidingWindow.getLastTool(agentId);
    if (prevTool && profile.transitionMatrix[prevTool]) {
      features[10] = 1 - (profile.transitionMatrix[prevTool][obs.toolName] ?? 0);
    }

    // ── Cost/Risk (dims 11-13) ───────────────────────────────────────
    // 11: cost z-score (raw)
    if (profile.costBaseline.stdCostUsd > 0) {
      features[11] = Math.abs(obs.costUsd - profile.costBaseline.meanCostUsd)
        / profile.costBaseline.stdCostUsd;
    }

    // 12: risk ordinal (0-3)
    features[12] = RISK_ORDINAL[obs.riskLevel] ?? 0;

    // 13: recent high-risk rate ratio vs baseline
    const baselineHighRate = profile.riskDistribution.HIGH + profile.riskDistribution.CRITICAL;
    const recentHighRate = this.slidingWindow.getHighRiskRate(agentId, 600);
    if (baselineHighRate > 0) {
      features[13] = recentHighRate / baselineHighRate;
    } else if (recentHighRate > 0) {
      features[13] = 10; // baseline has no high risk but we see some now
    }

    // ── Burst (dims 14-15) ───────────────────────────────────────────
    // 14: overall call rate ratio
    features[14] = features[8]; // same as dim 8 (burst ratio)

    // 15: tool-specific rate ratio
    features[15] = features[1]; // same as dim 1 (frequency ratio)

    return features;
  }

  /**
   * Update per-agent feature normalization stats (EWMA).
   */
  static updateFeatureStats(
    stats: FeatureStats | undefined,
    rawFeatures: number[],
    alpha = 0.05,
  ): FeatureStats {
    if (!stats) {
      return {
        mean: rawFeatures.slice(),
        variance: new Array(FEATURE_DIM).fill(0),
        n: 1,
      };
    }

    const effectiveAlpha = Math.min(alpha, 2 / (stats.n + 1));
    const mean = new Array(FEATURE_DIM);
    const variance = new Array(FEATURE_DIM);

    for (let i = 0; i < FEATURE_DIM; i++) {
      const delta = rawFeatures[i] - stats.mean[i];
      mean[i] = stats.mean[i] + effectiveAlpha * delta;
      variance[i] = (1 - effectiveAlpha) * stats.variance[i] + effectiveAlpha * delta * delta;
    }

    return { mean, variance, n: stats.n + 1 };
  }
}
