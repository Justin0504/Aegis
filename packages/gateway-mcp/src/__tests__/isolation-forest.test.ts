import { IsolationForest } from '../services/isolation-forest';

describe('IsolationForest', () => {
  it('scores normal points lower than outliers', () => {
    // Generate cluster of normal points around [0.5, 0.5]
    const data: number[][] = [];
    for (let i = 0; i < 200; i++) {
      data.push([
        0.5 + (Math.random() - 0.5) * 0.2,
        0.5 + (Math.random() - 0.5) * 0.2,
      ]);
    }

    const forest = new IsolationForest({ numTrees: 50, sampleSize: 100 });
    forest.fit(data);

    // Normal point near center of cluster
    const normalScore = forest.score([0.5, 0.5]);
    // Outlier far from cluster
    const outlierScore = forest.score([5.0, 5.0]);

    expect(outlierScore).toBeGreaterThan(normalScore);
    expect(normalScore).toBeLessThan(0.6);
    expect(outlierScore).toBeGreaterThan(0.6);
  });

  it('handles single-dimension data', () => {
    const data = Array.from({ length: 100 }, (_, i) => [i / 100]);
    const forest = new IsolationForest({ numTrees: 30, sampleSize: 64 });
    forest.fit(data);

    const normalScore = forest.score([0.5]);
    const outlierScore = forest.score([10.0]);
    expect(outlierScore).toBeGreaterThan(normalScore);
  });

  it('returns 0.5 when not trained', () => {
    const forest = new IsolationForest();
    expect(forest.score([1, 2, 3])).toBe(0.5);
    expect(forest.isTrained).toBe(false);
  });

  it('incrementally learns via addSample', () => {
    const forest = new IsolationForest({ numTrees: 30, sampleSize: 64, reservoirSize: 256 });

    // Add normal samples one by one
    for (let i = 0; i < 100; i++) {
      forest.addSample([Math.random() * 0.3, Math.random() * 0.3]);
    }

    expect(forest.isTrained).toBe(true);

    // Normal point should score lower than far outlier
    const normalScore = forest.score([0.15, 0.15]);
    const outlierScore = forest.score([10.0, 10.0]);
    expect(outlierScore).toBeGreaterThan(normalScore);
  });

  it('serializes and deserializes correctly', () => {
    const data: number[][] = [];
    for (let i = 0; i < 100; i++) {
      data.push([Math.random(), Math.random(), Math.random()]);
    }

    const forest = new IsolationForest({ numTrees: 20, sampleSize: 50 });
    forest.fit(data);

    const serialized = forest.serialize();
    const restored = IsolationForest.deserialize(serialized);

    const testPoint = [0.5, 0.5, 0.5];
    const testOutlier = [10, 10, 10];

    // Restored forest should produce same scores
    expect(restored.score(testPoint)).toBeCloseTo(forest.score(testPoint), 5);
    expect(restored.score(testOutlier)).toBeCloseTo(forest.score(testOutlier), 5);
    expect(restored.isTrained).toBe(true);
    expect(restored.sampleCount).toBe(forest.sampleCount);
  });

  it('handles 9-dimensional feature vectors (anomaly detector use case)', () => {
    const data: number[][] = [];
    // Simulate normal behavior: mostly zeros with occasional small values
    for (let i = 0; i < 200; i++) {
      data.push(Array.from({ length: 9 }, () => Math.random() * 0.1));
    }

    const forest = new IsolationForest({ numTrees: 100, sampleSize: 128 });
    forest.fit(data);

    // Normal: all low scores
    const normalScore = forest.score([0.05, 0.02, 0.03, 0.01, 0.04, 0.02, 0.01, 0.03, 0.02]);
    // Anomaly: multiple high scores
    const anomalyScore = forest.score([1.0, 0.8, 0.9, 0.7, 0.0, 0.95, 0.6, 0.8, 0.5]);

    expect(anomalyScore).toBeGreaterThan(normalScore);
  });

  it('scores in under 5ms for 100 trees', () => {
    const data: number[][] = [];
    for (let i = 0; i < 256; i++) {
      data.push(Array.from({ length: 9 }, () => Math.random()));
    }

    const forest = new IsolationForest({ numTrees: 100, sampleSize: 256 });
    forest.fit(data);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      forest.score([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    }
    const elapsed = performance.now() - start;

    // 100 scores should complete in well under 100ms (< 1ms each)
    expect(elapsed).toBeLessThan(100);
  });
});
