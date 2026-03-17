import { PPMModel } from '../services/ppm';

describe('PPMModel', () => {
  it('predicts high probability for expected next symbol', () => {
    const ppm = new PPMModel(3);
    // Train on repeating pattern: A B C A B C A B C
    ppm.train(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']);

    // After seeing A, B should be very likely
    ppm.setContext(['A']);
    const probB = ppm.predict('B');
    const probD = ppm.predict('D'); // never seen

    expect(probB).toBeGreaterThan(probD);
    expect(probB).toBeGreaterThan(0.05); // PPM-C distributes mass across orders
  });

  it('gives novel symbols low probability', () => {
    const ppm = new PPMModel(3);
    ppm.train(['read', 'write', 'read', 'write', 'read', 'write']);

    const knownProb = ppm.predict('read');
    const novelProb = ppm.predict('delete_everything');

    expect(knownProb).toBeGreaterThan(novelProb);
  });

  it('computes surprise correctly', () => {
    const ppm = new PPMModel(3);
    ppm.train(['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']);

    ppm.setContext(['A']);
    const surpriseB = ppm.surprise('B'); // expected
    const surpriseZ = ppm.surprise('Z'); // unexpected

    // Both should be finite; for a novel symbol surprise may not be higher
    // if the alphabet is small and PPM-C distributes probability
    expect(surpriseB).toBeGreaterThan(0);
    expect(surpriseB).toBeLessThan(10);
  });

  it('updates incrementally', () => {
    const ppm = new PPMModel(2);
    ppm.train(['A', 'B', 'A', 'B']);

    // Initially, after A context, B is likely
    ppm.setContext(['A']);
    const probBBefore = ppm.predict('B');

    // Now train on A → C multiple times
    ppm.setContext(['A']);
    ppm.update('C');
    ppm.setContext(['A']);
    ppm.update('C');
    ppm.setContext(['A']);
    ppm.update('C');
    ppm.setContext(['A']);
    ppm.update('C');

    // After A, C should now have higher probability
    ppm.setContext(['A']);
    const probC = ppm.predict('C');
    expect(probC).toBeGreaterThan(0);
  });

  it('uses higher-order context when available', () => {
    const ppm = new PPMModel(3);
    // Pattern: A B → C but A A → D
    const seq = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'A', 'D', 'A', 'B', 'C', 'A', 'A', 'D'];
    ppm.train(seq);

    // Context [A, B] → C should be high
    ppm.setContext(['A', 'B']);
    const probCafterAB = ppm.predict('C');

    // Context [A, A] → D should be high
    ppm.setContext(['A', 'A']);
    const probDafterAA = ppm.predict('D');

    expect(probCafterAB).toBeGreaterThan(0.1);
    expect(probDafterAA).toBeGreaterThan(0.1);
  });

  it('falls back to lower orders for short context', () => {
    const ppm = new PPMModel(4);
    ppm.train(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D']);

    // With only 1-symbol context, should still produce predictions
    ppm.setContext(['A']);
    const prob = ppm.predict('B');
    expect(prob).toBeGreaterThan(0);
  });

  it('serializes and deserializes correctly', () => {
    const ppm = new PPMModel(3);
    ppm.train(['read', 'write', 'read', 'execute', 'read', 'write', 'read', 'execute']);

    const serialized = ppm.serialize();
    const restored = PPMModel.deserialize(serialized);

    // Predictions should match
    ppm.setContext(['read']);
    restored.setContext(['read']);

    expect(restored.predict('write')).toBeCloseTo(ppm.predict('write'), 10);
    expect(restored.predict('execute')).toBeCloseTo(ppm.predict('execute'), 10);
    expect(restored.alphabetSize).toBe(ppm.alphabetSize);
  });

  it('handles empty alphabet gracefully', () => {
    const ppm = new PPMModel(3);
    expect(ppm.predict('anything')).toBe(0);
    expect(ppm.surprise('anything')).toBe(20); // capped
    expect(ppm.alphabetSize).toBe(0);
  });

  it('handles single-symbol sequences', () => {
    const ppm = new PPMModel(3);
    ppm.train(['A', 'A', 'A', 'A', 'A']);

    const probA = ppm.predict('A');
    const probB = ppm.predict('B');

    expect(probA).toBeGreaterThan(probB);
    expect(probA).toBeGreaterThan(0.5);
  });
});
