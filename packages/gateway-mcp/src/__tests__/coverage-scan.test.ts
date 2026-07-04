import { CoverageScanService } from '../services/workflow/coverage-scan';
import { WorkflowExtractorService } from '../services/workflow/extractor';
import type { DslPolicyService } from '../services/policy-dsl';

/** Minimal fake DslPolicyService — we don't need the real cache
 *  behaviour for coverage-scan tests, only `getEvaluator(orgId)`. */
function fakeDsl(evaluator: any): DslPolicyService {
  return { getEvaluator: () => evaluator } as unknown as DslPolicyService;
}

const CREWAI_SIMPLE = `
from crewai import Agent, Task, Crew, Process

researcher = Agent(role='researcher', goal='Find things', tools=[web_search, stripe_refund], llm=gpt4)
writer     = Agent(role='writer',     goal='Write things', tools=[grammarly], llm=gpt4)

t1 = Task(description='research', agent=researcher)
t2 = Task(description='write',    agent=writer)
crew = Crew(agents=[researcher, writer], tasks=[t1, t2], process=Process.sequential)
`;

describe('CoverageScanService', () => {
  test('no DSL loaded → every binding is uncovered', () => {
    const svc = new CoverageScanService(new WorkflowExtractorService(), fakeDsl(null));
    const report = svc.scan({
      orgId: 'org1',
      files: [{ path: 'crew.py', text: CREWAI_SIMPLE }],
    });
    expect(report.summary.total_bindings).toBeGreaterThan(0);
    expect(report.summary.covered).toBe(0);
    // stripe_refund is a payment sink → blocker
    const stripeBinding = report.bindings.find(b => b.tool_name === 'stripe_refund');
    expect(stripeBinding?.severity).toBe('blocker');
    expect(stripeBinding?.status).toBe('uncovered');
  });

  test('matching rule marks binding covered + records hit', () => {
    // Evaluator returns a match only when tool.name matches "stripe_refund".
    const evaluator = {
      compiled: { rules: [{ name: 'block-stripe-refund' }, { name: 'unused-rule' }] },
      evaluate(ctx: any) {
        if (ctx.tool?.name === 'stripe_refund') {
          return { ruleName: 'block-stripe-refund', decision: 'BLOCK', reason: 'ok' };
        }
        return null;
      },
    };
    const svc = new CoverageScanService(new WorkflowExtractorService(), fakeDsl(evaluator));
    const report = svc.scan({
      orgId: 'org1',
      files: [{ path: 'crew.py', text: CREWAI_SIMPLE }],
    });
    const stripe = report.bindings.find(b => b.tool_name === 'stripe_refund');
    expect(stripe?.status).toBe('covered');
    expect(stripe?.matched_rule?.name).toBe('block-stripe-refund');
    // unused-rule never matched anything → dead
    expect(report.summary.dead_rules).toContain('unused-rule');
    // block-stripe-refund matched at least once → not dead
    expect(report.summary.dead_rules).not.toContain('block-stripe-refund');
  });

  test('per-node coverage + recommendations for uncovered blockers', () => {
    const svc = new CoverageScanService(new WorkflowExtractorService(), fakeDsl(null));
    const report = svc.scan({
      orgId: 'org1',
      files: [{ path: 'crew.py', text: CREWAI_SIMPLE }],
    });
    // Two nodes: researcher + writer
    expect(report.summary.per_node.length).toBe(2);
    // Researcher's coverage < 100 because stripe_refund is uncovered
    const researcher = report.summary.per_node.find(p => p.node_id === 'researcher');
    expect(researcher?.uncovered_blocker).toBeGreaterThan(0);

    // Recommendation kind: add_rule for the stripe binding
    const addRule = report.recommendations.find(r =>
      r.kind === 'add_rule' && r.target === 'stripe_refund');
    expect(addRule).toBeTruthy();
    expect(addRule?.suggested_dsl).toContain('stripe_refund');
    expect(addRule?.suggested_dsl).toContain('BLOCK');
  });

  test('non-sensitive tool bindings are info, not blockers', () => {
    // grammarly is not on the SENSITIVE list; should not be a blocker
    const svc = new CoverageScanService(new WorkflowExtractorService(), fakeDsl(null));
    const report = svc.scan({
      orgId: 'org1',
      files: [{ path: 'crew.py', text: CREWAI_SIMPLE }],
    });
    const grammarly = report.bindings.find(b => b.tool_name === 'grammarly');
    expect(grammarly?.severity).toBe('info');
  });
});
