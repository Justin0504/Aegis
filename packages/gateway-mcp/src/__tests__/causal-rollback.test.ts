import { topologicalRollbackOrder, parseDepends, TraceForRollback } from '../services/causal-rollback';

function t(id: string, parent: string | null, ts: string): TraceForRollback {
  return { trace_id: id, parent_trace_id: parent, timestamp: ts };
}

describe('topologicalRollbackOrder — causal DAG chain rollback', () => {
  test('single linear chain reverses naturally', () => {
    // 1 → 2 → 3 (child depth 2). Rollback: 3, 2, 1.
    const traces = [
      t('1', null, '2026-07-01T10:00:00Z'),
      t('2', '1',  '2026-07-01T10:00:01Z'),
      t('3', '2',  '2026-07-01T10:00:02Z'),
    ];
    expect(topologicalRollbackOrder(traces)).toEqual(['3', '2', '1']);
  });

  test('siblings roll back newest-first, then parent', () => {
    //     1
    //    / \
    //   2   3     <- siblings, no ordering between them
    //   |
    //   4
    // Expected: 4 first (deepest), then 3 vs 2 by timestamp (3 newer), then 1.
    const traces = [
      t('1', null, '2026-07-01T10:00:00Z'),
      t('2', '1',  '2026-07-01T10:00:01Z'),
      t('3', '1',  '2026-07-01T10:00:02Z'),
      t('4', '2',  '2026-07-01T10:00:03Z'),
    ];
    const order = topologicalRollbackOrder(traces);
    // 4 must precede 2 (its parent); 2 and 3 must precede 1.
    expect(order.indexOf('4')).toBeLessThan(order.indexOf('2'));
    expect(order.indexOf('2')).toBeLessThan(order.indexOf('1'));
    expect(order.indexOf('3')).toBeLessThan(order.indexOf('1'));
    // Newest sibling first among ready roots on entry.
    expect(order[0]).toBe('4');
  });

  test('explicit depends_on adds an extra constraint', () => {
    // No parent links. But step B says depends_on = [A]:
    //   → A must roll back BEFORE B.
    const traces = [
      t('A', null, '2026-07-01T10:00:00Z'),
      t('B', null, '2026-07-01T10:00:01Z'),
    ];
    const extraDeps = new Map([['B', ['A']]]);
    expect(topologicalRollbackOrder(traces, extraDeps)).toEqual(['A', 'B']);
  });

  test('parent link points outside the batch (delegation subset)', () => {
    // 1 not in batch; 2 has parent=1 (outside). Should still handle.
    const traces = [
      t('2', '1', '2026-07-01T10:00:01Z'),
      t('3', '2', '2026-07-01T10:00:02Z'),
    ];
    expect(topologicalRollbackOrder(traces)).toEqual(['3', '2']);
  });

  test('cycle in extraDeps falls back gracefully — no drops', () => {
    // A depends_on B; B depends_on A. Cycle — Kahn can't sort;
    // fallback yields reverse-time order but nothing missing.
    const traces = [
      t('A', null, '2026-07-01T10:00:00Z'),
      t('B', null, '2026-07-01T10:00:01Z'),
    ];
    const extraDeps = new Map([['A', ['B']], ['B', ['A']]]);
    const order = topologicalRollbackOrder(traces, extraDeps);
    expect(order.sort()).toEqual(['A', 'B']);
    expect(order.length).toBe(2);
  });

  test('empty input returns empty', () => {
    expect(topologicalRollbackOrder([])).toEqual([]);
  });
});

describe('parseDepends', () => {
  test('parses comma-separated ids', () => {
    const m = parseDepends([
      { trace_id: 'A', depends_on: 'B, C, D' },
      { trace_id: 'B', depends_on: null },
      { trace_id: 'C', depends_on: '' },
    ]);
    expect(m.get('A')).toEqual(['B', 'C', 'D']);
    expect(m.has('B')).toBe(false);
    expect(m.has('C')).toBe(false);
  });
});
