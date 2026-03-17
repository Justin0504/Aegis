import { AnomalyDetector, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from '../services/anomaly-detector';
import { SlidingWindowStats } from '../services/sliding-window';
import { AgentProfile, ScoreTracker } from '../services/behavior-profile';

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

describe('Adaptive Thresholds', () => {
  let sw: SlidingWindowStats;
  let detector: AnomalyDetector;

  beforeEach(() => {
    sw = new SlidingWindowStats(1000, 100);
    detector = new AnomalyDetector(sw, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
  });

  it('returns global defaults when tracker has < 50 observations', () => {
    const tracker: ScoreTracker = { mean: 0.2, variance: 0.01, n: 10 };
    const thresholds = detector.adaptiveThresholds(tracker);
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('returns global defaults when tracker is undefined', () => {
    const thresholds = detector.adaptiveThresholds(undefined);
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('computes adaptive thresholds from score distribution', () => {
    // Simulate a stable agent with mean=0.15, low variance
    const tracker: ScoreTracker = { mean: 0.15, variance: 0.005, n: 100 };
    const thresholds = detector.adaptiveThresholds(tracker);

    expect(thresholds.flag).toBeGreaterThan(0.15);
    expect(thresholds.escalate).toBeGreaterThan(thresholds.flag);
    expect(thresholds.block).toBeGreaterThan(thresholds.escalate);
  });

  it('clamps thresholds to sane ranges', () => {
    // Very noisy agent with high variance
    const tracker: ScoreTracker = { mean: 0.5, variance: 0.2, n: 100 };
    const thresholds = detector.adaptiveThresholds(tracker);

    expect(thresholds.flag).toBeGreaterThanOrEqual(0.15);
    expect(thresholds.flag).toBeLessThanOrEqual(0.5);
    expect(thresholds.block).toBeLessThanOrEqual(0.95);
  });

  it('tightens thresholds for low-noise agents', () => {
    const lowNoise: ScoreTracker = { mean: 0.1, variance: 0.001, n: 200 };
    const highNoise: ScoreTracker = { mean: 0.1, variance: 0.05, n: 200 };

    const tightThresholds = detector.adaptiveThresholds(lowNoise);
    const wideThresholds = detector.adaptiveThresholds(highNoise);

    // Low-noise agent should have tighter (lower) thresholds
    expect(tightThresholds.flag).toBeLessThan(wideThresholds.flag);
  });
});

describe('Score Tracker', () => {
  it('initializes from first score', () => {
    const tracker = AnomalyDetector.updateScoreTracker(undefined, 0.3);
    expect(tracker.mean).toBe(0.3);
    expect(tracker.variance).toBe(0);
    expect(tracker.n).toBe(1);
  });

  it('converges mean toward repeated score', () => {
    let tracker: ScoreTracker | undefined;
    for (let i = 0; i < 200; i++) {
      tracker = AnomalyDetector.updateScoreTracker(tracker, 0.2);
    }
    expect(tracker!.mean).toBeCloseTo(0.2, 2);
    expect(tracker!.n).toBe(200);
  });

  it('tracks variance for varying scores', () => {
    let tracker: ScoreTracker | undefined;
    for (let i = 0; i < 200; i++) {
      const score = 0.2 + (Math.random() - 0.5) * 0.1;
      tracker = AnomalyDetector.updateScoreTracker(tracker, score);
    }
    expect(tracker!.variance).toBeGreaterThan(0);
  });
});

describe('Feedback Loop', () => {
  let sw: SlidingWindowStats;
  let detector: AnomalyDetector;

  beforeEach(() => {
    sw = new SlidingWindowStats(1000, 100);
    detector = new AnomalyDetector(sw, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
  });

  it('lowers future scores after approve feedback (false positive)', () => {
    const profile = makeProfile();

    // Evaluate an unknown tool — should score high
    const result1 = detector.evaluate(
      'agent-001', 'exec_bash', { cmd: 'ls' }, profile, 'HIGH', 0.01,
    );
    expect(result1.composite_score).toBeGreaterThan(0.2);

    // Human approves (false positive) — feed back the feature vector
    if (result1.feature_vector) {
      detector.ingestFeedback('agent-001', profile, result1.feature_vector, true);
    }

    // Score tracker should have been nudged down
    expect(profile.scoreTracker).toBeDefined();
  });

  it('nudges score tracker up after reject feedback', () => {
    const profile = makeProfile();

    // First evaluate to establish tracker
    const result1 = detector.evaluate(
      'agent-001', 'web_search', { query: 'test' }, profile, 'LOW', 0.005,
    );
    const meanBefore = profile.scoreTracker?.mean ?? 0;

    // Reject feedback — confirmed anomaly
    const featureVector = result1.feature_vector ?? new Array(16).fill(0);
    detector.ingestFeedback('agent-001', profile, featureVector, false);

    // Score tracker mean should increase
    expect(profile.scoreTracker!.mean).toBeGreaterThanOrEqual(meanBefore);
  });

  it('evaluate returns feature_vector for feedback', () => {
    const profile = makeProfile();
    const result = detector.evaluate(
      'agent-001', 'web_search', { query: 'test' }, profile, 'LOW', 0.005,
    );

    expect(result.feature_vector).toBeDefined();
    expect(result.feature_vector!.length).toBe(16);
  });

  it('updates scoring_method field', () => {
    const profile = makeProfile();

    // First call — should use weighted fallback (cold start)
    const result = detector.evaluate(
      'agent-001', 'web_search', { query: 'test' }, profile, 'LOW', 0.005,
    );
    expect(result.scoring_method).toBe('weighted_fallback');
  });
});
