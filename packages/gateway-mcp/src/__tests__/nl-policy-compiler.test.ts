/**
 * Tests for the Phase 2 NL policy compiler.
 *
 * Split by backend — heuristic (deterministic, always available) and
 * LLM (stubbed adapter, tests only the wire contract not the model
 * quality). Every test asserts on the shape of the returned DSL AND
 * the workflow-anchor references so future refactors can't silently
 * regress the "workflow-aware" value prop that makes this compiler
 * different from every competitor.
 */
import pino from 'pino';
import {
  NlPolicyCompilerService,
  type NlLlmClient,
} from '../services/nl-policy-compiler';
import type { WorkflowGraph } from '../services/workflow/types';
import {
  nodeUuid, edgeUuid, bindingUuid, graphContentHash,
} from '../services/workflow/types';

// ── Fixture graph — one agent with two tools ────────────────────────

function fixtureGraph(): WorkflowGraph {
  const supportSlug = 'support_agent';
  const supportUuid = nodeUuid(supportSlug, 'src/agents/support.py', 'agent');
  const nodes = [{
    id: supportSlug, uuid: supportUuid,
    name: 'support_agent', kind: 'agent' as const,
    source_ref: { file: 'src/agents/support.py', line: 1 },
    metadata: { tools_declared: ['send_email', 'stripe_refund'] },
  }];
  const bindings = [
    {
      node_id: supportSlug, tool_name: 'send_email',
      uuid: bindingUuid(supportSlug, 'send_email'),
    },
    {
      node_id: supportSlug, tool_name: 'stripe_refund',
      uuid: bindingUuid(supportSlug, 'stripe_refund'),
    },
  ];
  const edges = [
    { from: '__start__', to: supportSlug, kind: 'entry' as const,
      uuid: edgeUuid('__start__', supportSlug, 'entry') },
  ];
  return {
    framework: 'langgraph',
    extracted_at: '2026-07-14T00:00:00Z',
    source: { root_path: '/', files_scanned: 1, language: 'python' },
    nodes, edges, tool_bindings: bindings,
    entry_points: [supportSlug], finish_points: [],
    warnings: [],
    content_hash: graphContentHash({
      nodes, edges, tool_bindings: bindings,
      entry_points: [supportSlug], finish_points: [],
    }),
  };
}

const logger = pino({ level: 'silent' });

// ── Heuristic backend ────────────────────────────────────────────────

describe('nl-policy compiler · heuristic backend', () => {
  test('resolves a tool name to the workflow binding UUID', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const graph = fixtureGraph();
    const out = await svc.compile({
      description: "Don't let the agent send_email",
      workflow: graph,
    });
    expect(out.backend).toBe('heuristic');
    expect(out.compiled.rules).toHaveLength(1);
    expect(out.compiled.rules[0].then.decision).toBe('block');
    // The reference set MUST include the resolved binding + node UUIDs
    // — this is the workflow-aware value prop.
    const emailBinding = graph.tool_bindings.find(b => b.tool_name === 'send_email')!;
    expect(out.references.binding_uuids).toContain(emailBinding.uuid);
    expect(out.references.node_uuids).toContain(graph.nodes[0].uuid);
  });

  test('parses "require approval when amount > $10k" into a pending rule with the amount comparator', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const out = await svc.compile({
      description: 'Require approval for stripe_refund when amount > $10k',
      workflow: fixtureGraph(),
    });
    expect(out.compiled.rules[0].then.decision).toBe('pending');
    // The "all" bucket should carry both the binding_id lookup AND the
    // amount>10000 numeric comparator.
    const when = out.compiled.rules[0].when as any;
    expect(when.all).toBeDefined();
    const flatChecks = Object.assign({}, ...when.all);
    expect(flatChecks['tool.args.amount']).toEqual({ '>': 10000 });
    expect(flatChecks['workflow.binding_id']).toBeDefined();
  });

  test('understands $ suffixes: k, m', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const outK = await svc.compile({
      description: 'require approval when refund is over $5k',
      workflow: fixtureGraph(),
    });
    const outM = await svc.compile({
      description: 'require approval when refund is over $2m',
      workflow: fixtureGraph(),
    });
    const kAll = (outK.compiled.rules[0].when as any).all;
    const mAll = (outM.compiled.rules[0].when as any).all;
    expect(Object.assign({}, ...kAll)['tool.args.amount']).toEqual({ '>': 5_000 });
    expect(Object.assign({}, ...mAll)['tool.args.amount']).toEqual({ '>': 2_000_000 });
  });

  test('falls back with a warning when no tool / risk / node resolved', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const out = await svc.compile({
      description: 'block something bad',
      workflow: fixtureGraph(),
    });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toMatch(/too broad|no tool/i);
  });

  test('AEGIS-DSL has no `warn`, so "monitor X" routes to pending with a note', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const out = await svc.compile({
      description: 'monitor send_email calls',
      workflow: fixtureGraph(),
    });
    expect(out.compiled.rules[0].then.decision).toBe('pending');
    expect(out.compiled.rules[0].then.reason).toMatch(/\[watch\]/);
    expect(out.warnings.some(w => /warn/i.test(w))).toBe(true);
  });

  test('produced DSL round-trips through PolicyDslSchema (i.e. loadable)', async () => {
    const svc = new NlPolicyCompilerService(logger);
    const { PolicyDslSchema } = await import('@agentguard/core-schema');
    const out = await svc.compile({
      description: 'block send_email',
      workflow: fixtureGraph(),
    });
    expect(() => PolicyDslSchema.parse(out.compiled)).not.toThrow();
  });

  test('rejects empty description', async () => {
    const svc = new NlPolicyCompilerService(logger);
    await expect(svc.compile({ description: '' })).rejects.toThrow(/required/);
    await expect(svc.compile({ description: '   ' })).rejects.toThrow(/required/);
  });
});

// ── LLM backend (stub) ──────────────────────────────────────────────

describe('nl-policy compiler · LLM backend', () => {
  test('parses model JSON output into a DSL', async () => {
    const stub: NlLlmClient = {
      async complete() {
        return JSON.stringify({
          rules: [{
            name: 'llm-block-emails',
            when: { all: [{ 'tool.name': 'send_email' }] },
            then: { decision: 'block', reason: 'privacy hold' },
          }],
          explanation: 'This rule blocks every send_email call.',
        });
      },
    };
    const svc = new NlPolicyCompilerService(logger, stub);
    const out = await svc.compile({ description: 'block send_email' });
    expect(out.backend).toBe('llm');
    expect(out.compiled.rules[0].name).toBe('llm-block-emails');
    expect(out.explanation).toMatch(/blocks/);
  });

  test('strips ```json fences from LLM output', async () => {
    const stub: NlLlmClient = {
      async complete() {
        return '```json\n{"rules":[{"name":"r","when":{"all":[{"tool.name":"x"}]},"then":{"decision":"block"}}]}\n```';
      },
    };
    const svc = new NlPolicyCompilerService(logger, stub);
    const out = await svc.compile({ description: 'x' });
    expect(out.compiled.rules[0].name).toBe('r');
  });

  test('rejects non-JSON output loudly (not silently)', async () => {
    const stub: NlLlmClient = {
      async complete() { return 'I cannot help with that request.'; },
    };
    const svc = new NlPolicyCompilerService(logger, stub);
    await expect(svc.compile({ description: 'anything' })).rejects.toThrow(/non-JSON/);
  });

  test('rejects malformed DSL from the model (bad decision, missing fields)', async () => {
    const stub: NlLlmClient = {
      async complete() {
        return JSON.stringify({
          rules: [{
            name: 'bad-rule',
            when: {},
            then: { decision: 'DELETE_EVERYTHING' },   // not a valid decision
          }],
        });
      },
    };
    const svc = new NlPolicyCompilerService(logger, stub);
    await expect(svc.compile({ description: 'x' })).rejects.toThrow();
  });

  test('flags workflow.node_id references that are not in the supplied graph', async () => {
    const stub: NlLlmClient = {
      async complete() {
        return JSON.stringify({
          rules: [{
            name: 'ghost-node',
            when: { all: [{ 'workflow.node_id': '99999999-9999-9999-9999-999999999999' }] },
            then: { decision: 'block' },
          }],
          explanation: 'blocks ghost node',
        });
      },
    };
    const svc = new NlPolicyCompilerService(logger, stub);
    const out = await svc.compile({ description: 'x', workflow: fixtureGraph() });
    expect(out.warnings.some(w => /not in the supplied graph/.test(w))).toBe(true);
  });

  test('backend override forces heuristic even with LLM configured', async () => {
    const stub: NlLlmClient = { async complete() { throw new Error('should not run'); } };
    const svc = new NlPolicyCompilerService(logger, stub);
    const out = await svc.compile({
      description: 'block send_email',
      workflow: fixtureGraph(),
      backend: 'heuristic',
    });
    expect(out.backend).toBe('heuristic');
  });
});
