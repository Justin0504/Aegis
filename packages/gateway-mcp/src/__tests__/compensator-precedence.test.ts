/**
 * Phase 3 · compensator lookup precedence tests.
 *
 * Precedence (tightest → loosest):
 *   1. binding_uuid → "this exact tool call inside this exact node"
 *   2. node_uuid    → "any tool call inside this node"
 *   3. tool_name    → legacy fallback (still supported)
 *
 * Every test asserts on the `matchedBy` field so the audit trail
 * knows WHY a specific compensator was picked. This is the operator-
 * facing explanation on the saga step / DLQ row.
 */
import pino from 'pino';
import {
  CompensationRegistry,
  type CompensationConfig,
  type CompensatorDecl,
} from '../services/compensation-registry';

const NODE_A    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NODE_B    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BINDING_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BINDING_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const WEBHOOK_TOOL = { kind: 'webhook',  url: 'https://tool.example/comp' } as CompensatorDecl;
const WEBHOOK_NODE = { kind: 'webhook',  url: 'https://node.example/comp' } as CompensatorDecl;
const WEBHOOK_BIND = { kind: 'webhook',  url: 'https://bind.example/comp' } as CompensatorDecl;

function svc(config: CompensationConfig): CompensationRegistry {
  const r = new CompensationRegistry(pino({ level: 'silent' }));
  r.setConfig('org-1', config);
  return r;
}

describe('CompensationRegistry precedence (Phase 3)', () => {
  test('binding_uuid beats node_uuid beats tool_name', () => {
    const r = svc({
      compensators: { 'stripe_refund': WEBHOOK_TOOL },
      compensators_by_node:    { [NODE_A]:    WEBHOOK_NODE },
      compensators_by_binding: { [BINDING_A]: WEBHOOK_BIND },
    });
    const res = r.lookup('org-1', 'stripe_refund', {
      node_uuid: NODE_A, binding_uuid: BINDING_A,
    });
    expect(res.compensator).toBe(WEBHOOK_BIND);
    expect(res.matchedBy).toBe('binding_uuid');
  });

  test('falls back to node_uuid when binding_uuid absent', () => {
    const r = svc({
      compensators: { 'stripe_refund': WEBHOOK_TOOL },
      compensators_by_node: { [NODE_A]: WEBHOOK_NODE },
    });
    const res = r.lookup('org-1', 'stripe_refund', {
      node_uuid: NODE_A, binding_uuid: BINDING_A,
    });
    expect(res.compensator).toBe(WEBHOOK_NODE);
    expect(res.matchedBy).toBe('node_uuid');
  });

  test('falls back to tool_name when no workflow anchor matches', () => {
    const r = svc({
      compensators: { 'stripe_refund': WEBHOOK_TOOL },
      compensators_by_node:    { [NODE_B]:    WEBHOOK_NODE },  // doesn't match
      compensators_by_binding: { [BINDING_B]: WEBHOOK_BIND },  // doesn't match
    });
    const res = r.lookup('org-1', 'stripe_refund', {
      node_uuid: NODE_A, binding_uuid: BINDING_A,
    });
    expect(res.compensator).toBe(WEBHOOK_TOOL);
    expect(res.matchedBy).toBe('tool_name');
  });

  test('legacy lookup with no workflow context still finds tool-scoped', () => {
    const r = svc({ compensators: { 'stripe_refund': WEBHOOK_TOOL } });
    const res = r.lookup('org-1', 'stripe_refund');
    expect(res.compensator).toBe(WEBHOOK_TOOL);
    expect(res.matchedBy).toBe('tool_name');
  });

  test('same tool_name in two nodes can have DIFFERENT compensators', () => {
    // The exact scenario Phase 3 unblocks:
    // support_agent.send_email  → correction-only (already sent)
    // billing_agent.send_email  → webhook that pulls invoice email back
    const CORRECTION = { kind: 'none', note: 'email already sent' } as CompensatorDecl;
    const RECALL     = { kind: 'webhook', url: 'https://ops.example/email-recall' } as CompensatorDecl;
    const r = svc({
      compensators: {},   // no tool-name default
      compensators_by_node: {
        [NODE_A]: CORRECTION,
        [NODE_B]: RECALL,
      },
    });

    const resA = r.lookup('org-1', 'send_email', { node_uuid: NODE_A });
    const resB = r.lookup('org-1', 'send_email', { node_uuid: NODE_B });
    expect(resA.compensator).toBe(CORRECTION);
    expect(resB.compensator).toBe(RECALL);
    expect(resA.matchedBy).toBe('node_uuid');
    expect(resB.matchedBy).toBe('node_uuid');
  });

  test('returns null + no matchedBy when nothing matches', () => {
    const r = svc({ compensators: { 'other_tool': WEBHOOK_TOOL } });
    const res = r.lookup('org-1', 'stripe_refund', {
      node_uuid: NODE_A, binding_uuid: BINDING_A,
    });
    expect(res.compensator).toBeNull();
    expect(res.matchedBy).toBeUndefined();
  });

  test("kind='none' at any scope is reported as explicitlyUnrollable", () => {
    const NONE = { kind: 'none', note: 'irreversible' } as CompensatorDecl;
    const r = svc({
      compensators: {},
      compensators_by_binding: { [BINDING_A]: NONE },
    });
    const res = r.lookup('org-1', 'send_email', { binding_uuid: BINDING_A });
    expect(res.compensator).toBe(NONE);
    expect(res.explicitlyUnrollable).toBe(true);
    expect(res.matchedBy).toBe('binding_uuid');
  });

  test('unknown tenant → no compensator, no crash', () => {
    const r = new CompensationRegistry(pino({ level: 'silent' }));
    const res = r.lookup('never-registered', 'x');
    expect(res.compensator).toBeNull();
    expect(res.matchedBy).toBeUndefined();
  });
});
