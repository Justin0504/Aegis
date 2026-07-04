import Database from 'better-sqlite3';
import pino from 'pino';
import { SagaService } from '../services/saga';

function setup() {
  const db = new Database(':memory:');
  return new SagaService(db, pino({ level: 'silent' }));
}

describe('SagaService — state machine + step ledger', () => {
  it('opens a saga in STARTED', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single', root_trace_id: 't1' });
    const s = svc.get({ orgId: 'org-1', sagaId: id })!;
    expect(s.state).toBe('STARTED');
    expect(s.kind).toBe('rollback_single');
    expect(s.step_count).toBe(0);
  });

  it('transitions STARTED → EXECUTING → COMPLETED', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'COMPLETED' });
    const s = svc.get({ orgId: 'org-1', sagaId: id })!;
    expect(s.state).toBe('COMPLETED');
    expect(s.completed_at).toBeTruthy();
  });

  it('rejects invalid transitions', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    // STARTED → COMPLETED is not allowed (must go through EXECUTING)
    expect(() => svc.transition({ orgId: 'org-1', sagaId: id, to: 'COMPLETED' })).toThrow(/invalid/i);
    expect(() => svc.transition({ orgId: 'org-1', sagaId: id, to: 'ABORTED'   })).toThrow(/invalid/i);
  });

  it('terminal states are write-locked', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'COMPLETED' });
    expect(() => svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' })).toThrow(/invalid/i);
    expect(() => svc.transition({ orgId: 'org-1', sagaId: id, to: 'FAILED' })).toThrow(/invalid/i);
  });

  it('same-state transition is idempotent (no error, no double-completed_at)', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'STARTED' });   // no-op
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' }); // no-op
    expect(svc.get({ orgId: 'org-1', sagaId: id })!.state).toBe('EXECUTING');
  });

  it('appendStep increments step_count + persists row', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_chain' });
    svc.appendStep({ sagaId: id, trace_id: 't1', outcome: 'rolled_back', compensator_kind: 'webhook', duration_ms: 12 });
    svc.appendStep({ sagaId: id, trace_id: 't2', outcome: 'failed',      compensator_kind: 'webhook', duration_ms: 87, error: 'HTTP 503' });
    const page = svc.steps({ orgId: 'org-1', sagaId: id });
    expect(page.steps).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.steps[0].step_idx).toBe(1);
    expect(page.steps[1].step_idx).toBe(2);
    expect(page.steps[1].error).toBe('HTTP 503');
    expect(svc.get({ orgId: 'org-1', sagaId: id })!.step_count).toBe(2);
  });

  it('list filters by state', () => {
    const svc = setup();
    const a = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    const b = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    svc.transition({ orgId: 'org-1', sagaId: a, to: 'EXECUTING' });
    svc.transition({ orgId: 'org-1', sagaId: a, to: 'COMPLETED' });
    // b stays in STARTED
    expect(svc.list({ orgId: 'org-1', state: 'COMPLETED' })).toHaveLength(1);
    expect(svc.list({ orgId: 'org-1', state: 'STARTED' })).toHaveLength(1);
    expect(svc.list({ orgId: 'org-1', state: ['COMPLETED', 'STARTED'] })).toHaveLength(2);
  });

  it('cross-tenant isolation: cannot read another org\'s saga', () => {
    const svc = setup();
    const aId = svc.open({ orgId: 'org-A', kind: 'rollback_single' });
    expect(svc.get({ orgId: 'org-B', sagaId: aId })).toBeNull();
    expect(svc.steps({ orgId: 'org-B', sagaId: aId }).steps).toHaveLength(0);
    expect(svc.list({ orgId: 'org-B' })).toHaveLength(0);
  });

  it('list filter by agent_id', () => {
    const svc = setup();
    svc.open({ orgId: 'org-1', kind: 'rollback_single', agent_id: 'a-1' });
    svc.open({ orgId: 'org-1', kind: 'rollback_single', agent_id: 'a-2' });
    expect(svc.list({ orgId: 'org-1', agent_id: 'a-1' })).toHaveLength(1);
    expect(svc.list({ orgId: 'org-1' })).toHaveLength(2);
  });

  it('list limit clamps to [1, 500]', () => {
    const svc = setup();
    for (let i = 0; i < 20; i++) svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    expect(svc.list({ orgId: 'org-1', limit: 5 })).toHaveLength(5);
    expect(svc.list({ orgId: 'org-1', limit: 0 }).length).toBeGreaterThanOrEqual(1);
  });

  it('completed_at is set on entering a terminal state', () => {
    const svc = setup();
    const id = svc.open({ orgId: 'org-1', kind: 'rollback_single' });
    expect(svc.get({ orgId: 'org-1', sagaId: id })!.completed_at).toBeNull();
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'EXECUTING' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'COMPENSATING' });
    svc.transition({ orgId: 'org-1', sagaId: id, to: 'ABORTED' });
    expect(svc.get({ orgId: 'org-1', sagaId: id })!.completed_at).toBeTruthy();
  });

  it('transition throws for missing saga', () => {
    const svc = setup();
    expect(() => svc.transition({ orgId: 'org-1', sagaId: 'no-such-id', to: 'EXECUTING' })).toThrow(/not found/);
  });
});
