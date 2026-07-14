/**
 * Tests for the Phase 1.1 workflow identity primitives:
 *
 *   - uuidv5   — RFC 4122 shape + determinism
 *   - nodeUuid — same (slug, file, kind) → same uuid; rename → new uuid
 *   - edgeUuid — same tuple → same; rewire → new
 *   - bindingUuid — same (node_id, tool_name) → same
 *   - graphContentHash — canonicalisation is stable across:
 *       · array reordering (nodes / edges / bindings)
 *       · source_ref changes (file moves shouldn't invalidate)
 *       · metadata changes (temperature / max_tokens shouldn't invalidate)
 *     and DOES change when the graph shape changes.
 *
 * These primitives are the trust anchor for the whole Phase 1
 * architecture — get them wrong and every downstream layer (agent
 * register cert, policy compiler, compensator binding) drifts.
 */

import {
  uuidv5,
  nodeUuid,
  edgeUuid,
  bindingUuid,
  graphContentHash,
  WorkflowNode,
  WorkflowEdge,
  ToolBinding,
} from '../services/workflow/types';

// ── uuidv5 ─────────────────────────────────────────────────────────

describe('uuidv5', () => {
  test('returns an RFC 4122 v5-shaped string', () => {
    const u = uuidv5('anything');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('is deterministic — same input always the same uuid', () => {
    expect(uuidv5('foo')).toBe(uuidv5('foo'));
    expect(uuidv5('foo:bar:baz')).toBe(uuidv5('foo:bar:baz'));
  });

  test('different inputs give different uuids', () => {
    expect(uuidv5('foo')).not.toBe(uuidv5('bar'));
    expect(uuidv5('foo:bar')).not.toBe(uuidv5('bar:foo'));
  });
});

// ── nodeUuid / edgeUuid / bindingUuid ──────────────────────────────

describe('nodeUuid', () => {
  test('same (slug, file, kind) → same uuid', () => {
    const a = nodeUuid('support', 'src/agents/support.py', 'agent');
    const b = nodeUuid('support', 'src/agents/support.py', 'agent');
    expect(a).toBe(b);
  });

  test('rename → new uuid (that is the point)', () => {
    const before = nodeUuid('support', 'src/agents/support.py', 'agent');
    const after  = nodeUuid('helpdesk', 'src/agents/support.py', 'agent');
    expect(before).not.toBe(after);
  });

  test('kind change → new uuid', () => {
    const asAgent = nodeUuid('support', 'src/x.py', 'agent');
    const asHuman = nodeUuid('support', 'src/x.py', 'human');
    expect(asAgent).not.toBe(asHuman);
  });

  test('file relocation → new uuid', () => {
    const oldPath = nodeUuid('support', 'src/agents/support.py', 'agent');
    const newPath = nodeUuid('support', 'src/support/agent.py', 'agent');
    expect(oldPath).not.toBe(newPath);
  });
});

describe('edgeUuid', () => {
  test('same (from, to, kind, condition) → same', () => {
    expect(edgeUuid('a', 'b', 'sequential')).toBe(edgeUuid('a', 'b', 'sequential'));
    expect(edgeUuid('a', 'b', 'conditional', 'x>0'))
      .toBe(edgeUuid('a', 'b', 'conditional', 'x>0'));
  });

  test('direction matters — a→b ≠ b→a', () => {
    expect(edgeUuid('a', 'b', 'sequential')).not.toBe(edgeUuid('b', 'a', 'sequential'));
  });

  test('same endpoints different kind → new uuid', () => {
    expect(edgeUuid('a', 'b', 'sequential'))
      .not.toBe(edgeUuid('a', 'b', 'conditional'));
  });

  test('condition change → new uuid', () => {
    expect(edgeUuid('a', 'b', 'conditional', 'x>0'))
      .not.toBe(edgeUuid('a', 'b', 'conditional', 'x<0'));
  });
});

describe('bindingUuid', () => {
  test('same (node, tool) → same', () => {
    expect(bindingUuid('support', 'stripe_refund'))
      .toBe(bindingUuid('support', 'stripe_refund'));
  });

  test('different tool → different uuid', () => {
    expect(bindingUuid('support', 'stripe_refund'))
      .not.toBe(bindingUuid('support', 'stripe_charge'));
  });

  test('same tool different node → different uuid', () => {
    expect(bindingUuid('support', 'stripe_refund'))
      .not.toBe(bindingUuid('billing', 'stripe_refund'));
  });
});

// ── graphContentHash ───────────────────────────────────────────────

function mkNode(id: string): WorkflowNode {
  return {
    id, uuid: nodeUuid(id, 'src/x.py', 'agent'),
    name: id, kind: 'agent',
    source_ref: { file: 'src/x.py', line: 1 },
    metadata: { llm_model: 'claude-sonnet', tools_declared: ['a', 'b'] },
  };
}
function mkEdge(from: string, to: string): WorkflowEdge {
  return {
    from, to, kind: 'sequential',
    uuid: edgeUuid(from, to, 'sequential'),
    source_ref: { file: 'src/x.py', line: 2 },
  };
}
function mkBinding(nodeId: string, tool: string): ToolBinding {
  return {
    node_id: nodeId, tool_name: tool,
    uuid: bindingUuid(nodeId, tool),
    source_ref: { file: 'src/x.py', line: 3 },
  };
}

describe('graphContentHash', () => {
  const baseline = {
    nodes:         [mkNode('a'), mkNode('b'), mkNode('c')],
    edges:         [mkEdge('a', 'b'), mkEdge('b', 'c')],
    tool_bindings: [mkBinding('a', 'stripe_refund'), mkBinding('b', 'send_email')],
    entry_points:  ['a'],
    finish_points: ['c'],
  };

  test('same graph → same hash', () => {
    expect(graphContentHash(baseline)).toBe(graphContentHash(baseline));
  });

  test('node array reordering does NOT change the hash', () => {
    const reordered = { ...baseline, nodes: [baseline.nodes[2], baseline.nodes[0], baseline.nodes[1]] };
    expect(graphContentHash(reordered)).toBe(graphContentHash(baseline));
  });

  test('edge array reordering does NOT change the hash', () => {
    const reordered = { ...baseline, edges: [baseline.edges[1], baseline.edges[0]] };
    expect(graphContentHash(reordered)).toBe(graphContentHash(baseline));
  });

  test('source_ref change does NOT change the hash (refactor-safe)', () => {
    const relocated = {
      ...baseline,
      nodes: baseline.nodes.map(n => ({
        ...n,
        source_ref: { file: 'src/moved/here.py', line: 999 },
      })),
    };
    expect(graphContentHash(relocated)).toBe(graphContentHash(baseline));
  });

  test('metadata (temperature / max_tokens) change does NOT change the hash', () => {
    const tuned = {
      ...baseline,
      nodes: baseline.nodes.map(n => ({
        ...n,
        metadata: { ...n.metadata, temperature: 0.99, max_tokens: 4096 },
      })),
    };
    expect(graphContentHash(tuned)).toBe(graphContentHash(baseline));
  });

  test('adding a node → hash changes', () => {
    const withNewNode = {
      ...baseline,
      nodes: [...baseline.nodes, mkNode('d')],
    };
    expect(graphContentHash(withNewNode)).not.toBe(graphContentHash(baseline));
  });

  test('rewiring an edge → hash changes', () => {
    const rewired = {
      ...baseline,
      edges: [mkEdge('a', 'c'), baseline.edges[1]],   // a→b becomes a→c
    };
    expect(graphContentHash(rewired)).not.toBe(graphContentHash(baseline));
  });

  test('new tool binding → hash changes', () => {
    const withBinding = {
      ...baseline,
      tool_bindings: [...baseline.tool_bindings, mkBinding('c', 'postgres_delete')],
    };
    expect(graphContentHash(withBinding)).not.toBe(graphContentHash(baseline));
  });

  test('entry_points change → hash changes', () => {
    const differentEntry = { ...baseline, entry_points: ['b'] };
    expect(graphContentHash(differentEntry)).not.toBe(graphContentHash(baseline));
  });

  test('hash shape is 64-char lowercase hex (SHA-256)', () => {
    expect(graphContentHash(baseline)).toMatch(/^[0-9a-f]{64}$/);
  });
});
