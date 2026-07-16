/**
 * BFSI pack · Sarbanes-Oxley Act (SOX) financial reporting controls.
 *
 * SOX §302 + §404 require issuer management to design and evaluate
 * internal controls over financial reporting (ICFR). For agentic
 * systems that touch general-ledger, trade-book, or SEC-filing
 * artifacts, this pack enforces the change-management + segregation-
 * of-duties controls PCAOB AS 2201 expects to see evidence of.
 *
 * Pack scope:
 *   · Block direct writes to general-ledger / ERP / accounting
 *     tools without a workflow anchor (rules keyed on tool.name
 *     alone are insufficient — SOX requires WHO authorized WHAT
 *     inside WHICH process)
 *   · Route any close-period-related activity (journal entries,
 *     accruals, adjustments) to human approval with a 4-hour
 *     pending timeout so a controller has time to review
 *   · Block automated 10-K / 10-Q / 8-K SEC filing operations —
 *     these must ALWAYS have a human signer per SOX §906
 *   · Route trading-book writes through pending; agents can READ
 *     the trade blotter but not modify it without review
 *   · Block any tool call whose name matches audit-log tampering
 *     patterns (delete_audit, truncate_audit, drop_audit)
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'sox-block-gl-write-without-workflow-anchor',
      when: {
        all: [
          { 'tool.name': { matches: '^(post|write|journal|update)_(gl|general_ledger|erp|accounting)' } },
          // Phase 1.3 workflow anchor MUST be present. Rules that fire
          // on tool_name alone are insufficient evidence under PCAOB
          // AS 2201; the workflow node id ties the action to a
          // specific business process for the ICFR walkthrough.
          { 'workflow.node_id': null },
        ],
      },
      then: {
        decision: 'block',
        reason: 'SOX §404: general-ledger writes require workflow-anchored trace for ICFR walkthrough evidence',
        tags: ['sox', 'gl', 'workflow-anchor-required'],
      },
    },
    {
      name: 'sox-pending-journal-entry',
      when: {
        'tool.name': { matches: '(journal_entry|post_journal|accrual|adjustment)' },
      },
      then: {
        decision: 'pending',
        reason: 'SOX §404 + PCAOB AS 2201: journal entries require review by a controller separate from the preparer',
        tags: ['sox', 'sod'],
      },
    },
    {
      name: 'sox-block-automated-sec-filing',
      when: {
        'tool.name': { matches: '(file_10[kq]|file_8k|submit_edgar|xbrl_submit)' },
      },
      then: {
        decision: 'block',
        reason: 'SOX §906: SEC filings require a human signer (CEO/CFO certification) — no automated submission',
        tags: ['sox', 'sec-filing'],
      },
    },
    {
      name: 'sox-pending-trade-book-write',
      when: {
        all: [
          { 'tool.name': { matches: '^(insert|update|write|amend)_' } },
          { 'tool.args.table': { matches: '(trades|orders|positions|book)' } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'SOX §404: trade-book modifications require review (mark-to-market audit trail)',
        tags: ['sox', 'trading'],
      },
    },
    {
      name: 'sox-block-audit-log-tampering',
      when: {
        'tool.name': { matches: '(delete_audit|truncate_audit|drop_audit|clear_audit|purge_audit)' },
      },
      then: {
        decision: 'block',
        reason: 'SOX §802: destruction or alteration of audit records is a criminal offense',
        tags: ['sox', 'anti-tamper'],
      },
    },
    {
      name: 'sox-pending-quarter-end-anything',
      when: {
        all: [
          { 'tool.name': { matches: '(close|reconcile|reclassify|revalue)' } },
          { 'tool.args.period': { matches: '(Q[1-4]|quarter|year_end)' } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'SOX §302 + §404: period-close activities are ICFR key controls and require controller sign-off',
        tags: ['sox', 'close'],
      },
    },
  ],
};

export const bfsiSoxPack = {
  description:
    'Sarbanes-Oxley preset. Blocks general-ledger writes without a workflow anchor, forces human approval for journal entries and trade-book writes, blocks automated SEC filings and audit-log tampering.',
  citation: 'Sarbanes-Oxley Act §§ 302, 404, 802, 906 + PCAOB AS 2201',
  dsl,
};
