/**
 * Agent Behavior Profile — Learning-based baseline builder
 *
 * Builds statistical profiles from historical traces per agent:
 *   - Tool usage distribution (frequency + recency)
 *   - Argument shape fingerprints (key sets, value lengths, patterns)
 *   - Temporal patterns (hour-of-day, inter-call intervals)
 *   - Risk level distribution
 *   - Cost/token baselines (mean + stddev)
 *   - Tool transition matrix (bigram probabilities)
 *
 * Profiles are rebuilt periodically and stored in SQLite for fast lookup.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { PPMModel, PPMSerialized } from './ppm';
import { IsolationForestSerialized } from './isolation-forest';
import { FeatureStats } from './feature-encoder';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolDistribution {
  [toolName: string]: {
    count: number;
    frequency: number; // fraction of total
    lastSeen: string;
  };
}

export interface ArgumentFingerprint {
  /** Average key count per tool */
  avgKeyCount: number;
  /** Known key sets (hashed as sorted key string) */
  knownKeySets: string[];
  /** Average total argument length in chars */
  avgArgLength: number;
  stdArgLength: number;
}

export interface TemporalPattern {
  /** Call count per hour bucket (0-23) */
  hourDistribution: number[];
  /** Mean inter-call interval in seconds */
  meanIntervalSec: number;
  stdIntervalSec: number;
}

export interface RiskDistribution {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
  CRITICAL: number;
}

export interface CostBaseline {
  meanCostUsd: number;
  stdCostUsd: number;
  meanTokensPerCall: number;
  stdTokensPerCall: number;
}

export interface TransitionMatrix {
  /** bigram[fromTool][toTool] = probability */
  [fromTool: string]: { [toTool: string]: number };
}

/** EWMA state for online incremental profile updates */
export interface EWMAState {
  /** Smoothing factor (default 0.05 ≈ 20-sample half-life) */
  alpha: number;
  /** EWMA of cost */
  costEwma: number;
  costEwmaVar: number;
  /** EWMA of tokens */
  tokensEwma: number;
  tokensEwmaVar: number;
  /** EWMA of arg length per tool */
  argLengthEwma: Record<string, number>;
  argLengthEwmaVar: Record<string, number>;
  /** EWMA of inter-call interval */
  intervalEwma: number;
  intervalEwmaVar: number;
  /** EWMA hourly density (24-element array) */
  hourDensity: number[];
  /** EWMA of risk fractions */
  riskEwma: RiskDistribution;
  /** EWMA of tool frequency */
  toolFreqEwma: Record<string, number>;
  /** Total observations processed */
  n: number;
  /** Timestamp of last update (ms) */
  lastUpdateMs: number;
}

export interface AgentProfile {
  agentId: string;
  traceCount: number;
  windowDays: number;
  toolDistribution: ToolDistribution;
  argumentFingerprints: { [toolName: string]: ArgumentFingerprint };
  temporalPattern: TemporalPattern;
  riskDistribution: RiskDistribution;
  costBaseline: CostBaseline;
  transitionMatrix: TransitionMatrix;
  /** Known tool set (for novelty detection) */
  knownTools: string[];
  updatedAt: string;
  /** EWMA online learning state */
  ewma?: EWMAState;
  /** Isolation Forest training samples */
  forestSamples?: number[][];
  /** Serialized Isolation Forest */
  forestState?: IsolationForestSerialized;
  /** PPM sequence model state */
  ppmState?: PPMSerialized;
  /** Per-feature normalization stats (EWMA mean/variance per dimension) */
  featureStats?: FeatureStats;
  /** Online anomaly score distribution tracker for adaptive thresholds */
  scoreTracker?: ScoreTracker;
}

/** Tracks running score distribution for adaptive thresholds */
export interface ScoreTracker {
  /** EWMA of anomaly scores */
  mean: number;
  /** EWMA of score variance */
  variance: number;
  /** Total observations */
  n: number;
}

// ── Profile Builder ─────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 14;
const MIN_TRACES_FOR_PROFILE = 10;

export class BehaviorProfileService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /**
   * Build or rebuild a profile for one agent from trace history.
   * Returns null if insufficient data.
   */
  buildProfile(agentId: string, windowDays = DEFAULT_WINDOW_DAYS): AgentProfile | null {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const traces = this.db.prepare(`
      SELECT tool_call, safety_validation, timestamp, cost_usd, input_tokens, output_tokens
      FROM traces
      WHERE agent_id = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `).all(agentId, since) as any[];

    if (traces.length < MIN_TRACES_FOR_PROFILE) return null;

    // Parse tool calls
    const parsed = traces.map(t => {
      let tc: any = {};
      try { tc = typeof t.tool_call === 'string' ? JSON.parse(t.tool_call) : t.tool_call; } catch {}
      let sv: any = {};
      try { sv = typeof t.safety_validation === 'string' ? JSON.parse(t.safety_validation) : t.safety_validation; } catch {}
      return {
        toolName: tc?.tool_name ?? tc?.function ?? tc?.name ?? 'unknown',
        args: tc?.arguments ?? tc?.args ?? {},
        riskLevel: sv?.risk_level ?? 'LOW',
        timestamp: t.timestamp,
        costUsd: Number(t.cost_usd) || 0,
        tokens: (Number(t.input_tokens) || 0) + (Number(t.output_tokens) || 0),
      };
    });

    // 1. Tool distribution
    const toolCounts: Record<string, { count: number; lastSeen: string }> = {};
    for (const p of parsed) {
      if (!toolCounts[p.toolName]) toolCounts[p.toolName] = { count: 0, lastSeen: p.timestamp };
      toolCounts[p.toolName].count++;
      toolCounts[p.toolName].lastSeen = p.timestamp;
    }
    const toolDistribution: ToolDistribution = {};
    for (const [name, info] of Object.entries(toolCounts)) {
      toolDistribution[name] = {
        count: info.count,
        frequency: info.count / parsed.length,
        lastSeen: info.lastSeen,
      };
    }

    // 2. Argument fingerprints per tool
    const argsByTool: Record<string, { keySets: string[]; argLengths: number[] }> = {};
    for (const p of parsed) {
      if (!argsByTool[p.toolName]) argsByTool[p.toolName] = { keySets: [], argLengths: [] };
      const keys = typeof p.args === 'object' && p.args ? Object.keys(p.args).sort().join(',') : '';
      argsByTool[p.toolName].keySets.push(keys);
      argsByTool[p.toolName].argLengths.push(JSON.stringify(p.args).length);
    }
    const argumentFingerprints: { [toolName: string]: ArgumentFingerprint } = {};
    for (const [tool, data] of Object.entries(argsByTool)) {
      const uniqueKeySets = [...new Set(data.keySets)];
      const avgKeyCount = data.keySets.reduce((s, ks) => s + (ks ? ks.split(',').length : 0), 0) / data.keySets.length;
      const avgLen = mean(data.argLengths);
      argumentFingerprints[tool] = {
        avgKeyCount,
        knownKeySets: uniqueKeySets.slice(0, 50), // cap stored fingerprints
        avgArgLength: avgLen,
        stdArgLength: stddev(data.argLengths, avgLen),
      };
    }

    // 3. Temporal patterns
    const hours = new Array(24).fill(0);
    const intervals: number[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const ts = new Date(parsed[i].timestamp);
      hours[ts.getUTCHours()]++;
      if (i > 0) {
        const prev = new Date(parsed[i - 1].timestamp).getTime();
        const diff = (ts.getTime() - prev) / 1000;
        if (diff > 0 && diff < 86400) intervals.push(diff); // ignore gaps > 1 day
      }
    }
    const meanInt = intervals.length > 0 ? mean(intervals) : 0;
    const temporalPattern: TemporalPattern = {
      hourDistribution: hours,
      meanIntervalSec: meanInt,
      stdIntervalSec: intervals.length > 1 ? stddev(intervals, meanInt) : meanInt,
    };

    // 4. Risk distribution
    const riskDist: RiskDistribution = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const p of parsed) {
      if (p.riskLevel in riskDist) riskDist[p.riskLevel as keyof RiskDistribution]++;
    }
    // Normalize to fractions
    for (const key of Object.keys(riskDist) as (keyof RiskDistribution)[]) {
      riskDist[key] = riskDist[key] / parsed.length;
    }

    // 5. Cost baseline
    const costs = parsed.map(p => p.costUsd);
    const tokens = parsed.map(p => p.tokens);
    const meanCost = mean(costs);
    const meanTok = mean(tokens);
    const costBaseline: CostBaseline = {
      meanCostUsd: meanCost,
      stdCostUsd: stddev(costs, meanCost),
      meanTokensPerCall: meanTok,
      stdTokensPerCall: stddev(tokens, meanTok),
    };

    // 6. Transition matrix (tool bigrams)
    const transitionCounts: Record<string, Record<string, number>> = {};
    const fromTotals: Record<string, number> = {};
    for (let i = 1; i < parsed.length; i++) {
      const from = parsed[i - 1].toolName;
      const to = parsed[i].toolName;
      if (!transitionCounts[from]) transitionCounts[from] = {};
      transitionCounts[from][to] = (transitionCounts[from][to] || 0) + 1;
      fromTotals[from] = (fromTotals[from] || 0) + 1;
    }
    const transitionMatrix: TransitionMatrix = {};
    for (const [from, tos] of Object.entries(transitionCounts)) {
      transitionMatrix[from] = {};
      for (const [to, count] of Object.entries(tos)) {
        transitionMatrix[from][to] = count / fromTotals[from];
      }
    }

    // 7. PPM sequence model (variable-order Markov chain)
    const toolSequence = parsed.map(p => p.toolName);
    const ppmModel = new PPMModel(4);
    ppmModel.train(toolSequence);

    const profile: AgentProfile = {
      agentId,
      traceCount: parsed.length,
      windowDays,
      toolDistribution,
      argumentFingerprints,
      temporalPattern,
      riskDistribution: riskDist,
      costBaseline,
      transitionMatrix,
      knownTools: Object.keys(toolDistribution),
      updatedAt: new Date().toISOString(),
      ppmState: ppmModel.serialize(),
    };

    // Persist to DB
    this.saveProfile(profile);
    return profile;
  }

  /**
   * Incrementally update a profile with a single new observation.
   * Uses EWMA to blend new data without full SQL rebuild.
   */
  updateIncremental(
    profile: AgentProfile,
    obs: {
      toolName: string;
      args: Record<string, unknown>;
      riskLevel: string;
      costUsd: number;
      tokens: number;
      timestampMs: number;
    },
  ): AgentProfile {
    // Initialize EWMA state from batch-computed values if missing
    if (!profile.ewma) {
      profile.ewma = this.initEwma(profile);
    }

    const ewma = profile.ewma;
    ewma.n++;

    // Adaptive alpha: larger learning rate early, converges to configured alpha
    const alpha = Math.min(ewma.alpha, 2 / (ewma.n + 1));

    // Cost EWMA
    const costDelta = obs.costUsd - ewma.costEwma;
    ewma.costEwma += alpha * costDelta;
    ewma.costEwmaVar = (1 - alpha) * ewma.costEwmaVar + alpha * costDelta * costDelta;

    // Tokens EWMA
    const tokenDelta = obs.tokens - ewma.tokensEwma;
    ewma.tokensEwma += alpha * tokenDelta;
    ewma.tokensEwmaVar = (1 - alpha) * ewma.tokensEwmaVar + alpha * tokenDelta * tokenDelta;

    // Arg length EWMA per tool
    const argLen = JSON.stringify(obs.args).length;
    const prevArgLen = ewma.argLengthEwma[obs.toolName] ?? argLen;
    const argDelta = argLen - prevArgLen;
    ewma.argLengthEwma[obs.toolName] = prevArgLen + alpha * argDelta;
    ewma.argLengthEwmaVar[obs.toolName] = (1 - alpha) * (ewma.argLengthEwmaVar[obs.toolName] ?? 0) + alpha * argDelta * argDelta;

    // Inter-call interval
    if (ewma.lastUpdateMs > 0) {
      const interval = (obs.timestampMs - ewma.lastUpdateMs) / 1000;
      if (interval > 0 && interval < 86400) {
        const intDelta = interval - ewma.intervalEwma;
        ewma.intervalEwma += alpha * intDelta;
        ewma.intervalEwmaVar = (1 - alpha) * ewma.intervalEwmaVar + alpha * intDelta * intDelta;
      }
    }

    // Hour density: boost current hour, decay all
    const hour = new Date(obs.timestampMs).getUTCHours();
    for (let h = 0; h < 24; h++) {
      ewma.hourDensity[h] *= (1 - alpha);
    }
    ewma.hourDensity[hour] += alpha;

    // Tool frequency: boost current tool, decay all
    for (const t of Object.keys(ewma.toolFreqEwma)) {
      ewma.toolFreqEwma[t] *= (1 - alpha);
    }
    ewma.toolFreqEwma[obs.toolName] = (ewma.toolFreqEwma[obs.toolName] ?? 0) + alpha;

    // Risk distribution
    const riskKeys: (keyof RiskDistribution)[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    for (const k of riskKeys) {
      ewma.riskEwma[k] *= (1 - alpha);
    }
    if (obs.riskLevel in ewma.riskEwma) {
      ewma.riskEwma[obs.riskLevel as keyof RiskDistribution] += alpha;
    }

    ewma.lastUpdateMs = obs.timestampMs;

    // Sync EWMA back to profile fields
    profile.costBaseline.meanCostUsd = ewma.costEwma;
    profile.costBaseline.stdCostUsd = Math.sqrt(ewma.costEwmaVar);
    profile.costBaseline.meanTokensPerCall = ewma.tokensEwma;
    profile.costBaseline.stdTokensPerCall = Math.sqrt(ewma.tokensEwmaVar);
    profile.temporalPattern.meanIntervalSec = ewma.intervalEwma;
    profile.temporalPattern.stdIntervalSec = Math.sqrt(ewma.intervalEwmaVar);

    // Normalize hour density to counts for compatibility
    const totalDensity = ewma.hourDensity.reduce((s, d) => s + d, 0) || 1;
    profile.temporalPattern.hourDistribution = ewma.hourDensity.map(d => Math.round(d / totalDensity * ewma.n));

    // Sync risk distribution
    const totalRisk = riskKeys.reduce((s, k) => s + ewma.riskEwma[k], 0) || 1;
    for (const k of riskKeys) {
      profile.riskDistribution[k] = ewma.riskEwma[k] / totalRisk;
    }

    // Update tool distribution
    if (!profile.toolDistribution[obs.toolName]) {
      profile.toolDistribution[obs.toolName] = { count: 0, frequency: 0, lastSeen: '' };
    }
    profile.toolDistribution[obs.toolName].count++;
    profile.toolDistribution[obs.toolName].lastSeen = new Date(obs.timestampMs).toISOString();

    // Sync arg fingerprint
    if (!profile.argumentFingerprints[obs.toolName]) {
      profile.argumentFingerprints[obs.toolName] = {
        avgKeyCount: 0, knownKeySets: [], avgArgLength: 0, stdArgLength: 0,
      };
    }
    const fp = profile.argumentFingerprints[obs.toolName];
    fp.avgArgLength = ewma.argLengthEwma[obs.toolName];
    fp.stdArgLength = Math.sqrt(ewma.argLengthEwmaVar[obs.toolName] ?? 0);
    const keySet = typeof obs.args === 'object' && obs.args ? Object.keys(obs.args).sort().join(',') : '';
    if (keySet && !fp.knownKeySets.includes(keySet)) {
      fp.knownKeySets.push(keySet);
      if (fp.knownKeySets.length > 50) fp.knownKeySets.shift();
    }

    // Add tool to knownTools
    if (!profile.knownTools.includes(obs.toolName)) {
      profile.knownTools.push(obs.toolName);
    }

    profile.traceCount = ewma.n;
    profile.updatedAt = new Date().toISOString();

    return profile;
  }

  /** Initialize EWMA state from existing batch-computed profile */
  private initEwma(profile: AgentProfile): EWMAState {
    const hourDensity = new Array(24).fill(0);
    const totalHours = profile.temporalPattern.hourDistribution.reduce((s, h) => s + h, 0) || 1;
    for (let h = 0; h < 24; h++) {
      hourDensity[h] = profile.temporalPattern.hourDistribution[h] / totalHours;
    }

    const toolFreqEwma: Record<string, number> = {};
    for (const [tool, dist] of Object.entries(profile.toolDistribution)) {
      toolFreqEwma[tool] = dist.frequency;
    }

    const argLengthEwma: Record<string, number> = {};
    const argLengthEwmaVar: Record<string, number> = {};
    for (const [tool, fp] of Object.entries(profile.argumentFingerprints)) {
      argLengthEwma[tool] = fp.avgArgLength;
      argLengthEwmaVar[tool] = fp.stdArgLength * fp.stdArgLength;
    }

    return {
      alpha: 0.05,
      costEwma: profile.costBaseline.meanCostUsd,
      costEwmaVar: profile.costBaseline.stdCostUsd * profile.costBaseline.stdCostUsd,
      tokensEwma: profile.costBaseline.meanTokensPerCall,
      tokensEwmaVar: profile.costBaseline.stdTokensPerCall * profile.costBaseline.stdTokensPerCall,
      argLengthEwma,
      argLengthEwmaVar,
      intervalEwma: profile.temporalPattern.meanIntervalSec,
      intervalEwmaVar: profile.temporalPattern.stdIntervalSec * profile.temporalPattern.stdIntervalSec,
      hourDensity,
      riskEwma: { ...profile.riskDistribution },
      toolFreqEwma,
      n: profile.traceCount,
      lastUpdateMs: Date.now(),
    };
  }

  /** Rebuild profiles for all agents with recent activity */
  rebuildAllProfiles(windowDays = DEFAULT_WINDOW_DAYS): number {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const agents = this.db.prepare(
      `SELECT DISTINCT agent_id FROM traces WHERE timestamp > ?`
    ).all(since) as { agent_id: string }[];

    let built = 0;
    for (const { agent_id } of agents) {
      const profile = this.buildProfile(agent_id, windowDays);
      if (profile) built++;
    }
    this.logger.info({ agents: agents.length, profiles_built: built }, 'Behavior profiles rebuilt');
    return built;
  }

  /** Get cached profile from DB */
  getProfile(agentId: string): AgentProfile | null {
    const row = this.db.prepare(
      `SELECT profile_json FROM agent_profiles WHERE agent_id = ?`
    ).get(agentId) as { profile_json: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.profile_json); } catch { return null; }
  }

  /** Save profile to DB */
  private saveProfile(profile: AgentProfile) {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_profiles (agent_id, profile_json, trace_count, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      profile.agentId,
      JSON.stringify(profile),
      profile.traceCount,
      profile.updatedAt,
    );
  }

  /** List all profiled agents */
  listProfiles(): { agent_id: string; trace_count: number; updated_at: string }[] {
    return this.db.prepare(
      `SELECT agent_id, trace_count, updated_at FROM agent_profiles ORDER BY updated_at DESC`
    ).all() as any[];
  }
}

// ── Math helpers ────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
