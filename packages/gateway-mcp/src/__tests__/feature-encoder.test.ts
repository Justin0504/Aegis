import { FeatureEncoder, FeatureStats, RawObservation, FEATURE_DIM } from '../services/feature-encoder';
import { SlidingWindowStats } from '../services/sliding-window';
import { AgentProfile } from '../services/behavior-profile';
import { PPMModel } from '../services/ppm';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentId: 'agent-001',
    traceCount: 500,
    windowDays: 14,
    toolDistribution: {
      web_search: { count: 200, frequency: 0.4, lastSeen: new Date().toISOString() },
      read_file:  { count: 150, frequency: 0.3, lastSeen: new Date().toISOString() },
      write_file: { count: 100, frequency: 0.2, lastSeen: new Date().toISOString() },
    },
    argumentFingerprints: {
      web_search: { avgKeyCount: 1, knownKeySets: ['query'], avgArgLength: 40, stdArgLength: 15 },
      read_file:  { avgKeyCount: 1, knownKeySets: ['path'], avgArgLength: 30, stdArgLength: 10 },
      write_file: { avgKeyCount: 2, knownKeySets: ['content,path'], avgArgLength: 80, stdArgLength: 30 },
    },
    temporalPattern: {
      hourDistribution: [
        5, 5, 3, 2, 1, 1, 5, 15, 30, 40, 45, 50,
        48, 45, 40, 35, 30, 25, 20, 15, 10, 8, 7, 5,
      ],
      meanIntervalSec: 120,
      stdIntervalSec: 60,
    },
    riskDistribution: { LOW: 0.85, MEDIUM: 0.10, HIGH: 0.04, CRITICAL: 0.01 },
    costBaseline: { meanCostUsd: 0.005, stdCostUsd: 0.003, meanTokensPerCall: 500, stdTokensPerCall: 200 },
    transitionMatrix: {
      web_search: { read_file: 0.5, write_file: 0.3 },
      read_file:  { web_search: 0.4, write_file: 0.4 },
    },
    knownTools: ['web_search', 'read_file', 'write_file'],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('FeatureEncoder', () => {
  let sw: SlidingWindowStats;
  let encoder: FeatureEncoder;
  let profile: AgentProfile;

  beforeEach(() => {
    sw = new SlidingWindowStats(1000, 100);
    encoder = new FeatureEncoder(sw);
    profile = makeProfile();
  });

  it('produces FEATURE_DIM-length vector', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };
    const raw = encoder.extractRaw('agent-001', obs, profile, null);
    expect(raw.length).toBe(FEATURE_DIM);
    expect(raw.every(v => typeof v === 'number' && isFinite(v))).toBe(true);
  });

  it('sets novelty=1 for unknown tool', () => {
    const obs: RawObservation = {
      toolName: 'exec_bash',
      args: { cmd: 'ls' },
      riskLevel: 'HIGH',
      costUsd: 0.01,
      timestampMs: Date.now(),
    };
    const raw = encoder.extractRaw('agent-001', obs, profile, null);
    expect(raw[0]).toBe(1); // dim 0 = tool novelty
  });

  it('sets novelty=0 for known tool', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };
    const raw = encoder.extractRaw('agent-001', obs, profile, null);
    expect(raw[0]).toBe(0); // dim 0 = tool novelty
  });

  it('encodes risk level as ordinal', () => {
    const makeObs = (risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): RawObservation => ({
      toolName: 'web_search',
      args: { query: 'test' },
      riskLevel: risk,
      costUsd: 0.005,
      timestampMs: Date.now(),
    });

    const low = encoder.extractRaw('a', makeObs('LOW'), profile, null);
    const high = encoder.extractRaw('a', makeObs('HIGH'), profile, null);
    const critical = encoder.extractRaw('a', makeObs('CRITICAL'), profile, null);

    expect(low[12]).toBe(0);     // dim 12 = risk ordinal
    expect(high[12]).toBe(2);
    expect(critical[12]).toBe(3);
  });

  it('detects jaccard distance for unusual arg keys', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test', callback_url: 'http://evil.com', exfil: true },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };
    const raw = encoder.extractRaw('agent-001', obs, profile, null);
    expect(raw[3]).toBeGreaterThan(0); // dim 3 = jaccard distance
  });

  it('computes PPM surprise when model is available', () => {
    const ppm = new PPMModel(3);
    ppm.train(['web_search', 'read_file', 'web_search', 'read_file', 'web_search', 'read_file']);

    // After pattern web_search → read_file, predicting write_file should have higher surprise
    ppm.setContext(['web_search']);
    const obs: RawObservation = {
      toolName: 'write_file',
      args: { path: '/tmp/x', content: 'hi' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };
    const raw = encoder.extractRaw('agent-001', obs, profile, ppm);
    expect(raw[9]).toBeGreaterThan(0); // dim 9 = PPM surprise
  });

  it('returns normalized features when featureStats is present', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };

    // Build up stats
    let stats: FeatureStats | undefined;
    for (let i = 0; i < 20; i++) {
      const raw = encoder.extractRaw('agent-001', obs, profile, null);
      stats = FeatureEncoder.updateFeatureStats(stats, raw);
    }

    profile.featureStats = stats;
    const encoded = encoder.encode('agent-001', obs, profile, null);

    expect(encoded.length).toBe(FEATURE_DIM);
    // Normalized features should be closer to 0 (z-scored)
    // After training on identical data, each feature should be ~0
    for (const v of encoded) {
      expect(Math.abs(v)).toBeLessThan(5); // reasonable z-score range
    }
  });

  it('returns raw features when stats.n < 10', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };

    // Only 5 samples — not enough to normalize
    let stats: FeatureStats | undefined;
    for (let i = 0; i < 5; i++) {
      const raw = encoder.extractRaw('agent-001', obs, profile, null);
      stats = FeatureEncoder.updateFeatureStats(stats, raw);
    }

    profile.featureStats = stats;
    const encoded = encoder.encode('agent-001', obs, profile, null);
    const raw = encoder.extractRaw('agent-001', obs, profile, null);

    // Should return raw (un-normalized) features
    expect(encoded).toEqual(raw);
  });

  it('encodes in under 0.5ms', () => {
    const obs: RawObservation = {
      toolName: 'web_search',
      args: { query: 'test query string' },
      riskLevel: 'LOW',
      costUsd: 0.005,
      timestampMs: Date.now(),
    };

    // Warmup
    encoder.extractRaw('agent-001', obs, profile, null);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      encoder.extractRaw('agent-001', obs, profile, null);
    }
    const elapsed = performance.now() - start;

    // 1000 encodes should be well under 500ms (< 0.5ms each)
    expect(elapsed).toBeLessThan(500);
  });
});

describe('FeatureEncoder.updateFeatureStats', () => {
  it('initializes from first sample', () => {
    const raw = [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const stats = FeatureEncoder.updateFeatureStats(undefined, raw);

    expect(stats.n).toBe(1);
    expect(stats.mean).toEqual(raw);
    expect(stats.variance.every(v => v === 0)).toBe(true);
  });

  it('converges mean toward repeated value', () => {
    let stats: FeatureStats | undefined;
    const value = new Array(FEATURE_DIM).fill(5);

    for (let i = 0; i < 100; i++) {
      stats = FeatureEncoder.updateFeatureStats(stats, value);
    }

    // Mean should be ~5 for all dims
    for (let i = 0; i < FEATURE_DIM; i++) {
      expect(stats!.mean[i]).toBeCloseTo(5, 1);
    }
    expect(stats!.n).toBe(100);
  });

  it('tracks variance for varying input', () => {
    let stats: FeatureStats | undefined;

    for (let i = 0; i < 200; i++) {
      const value = new Array(FEATURE_DIM).fill(0).map(() => Math.random() * 10);
      stats = FeatureEncoder.updateFeatureStats(stats, value);
    }

    // Variance should be > 0 for random input
    expect(stats!.variance.some(v => v > 0)).toBe(true);
    expect(stats!.n).toBe(200);
  });
});
