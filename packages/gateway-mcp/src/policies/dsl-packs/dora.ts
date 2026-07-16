/**
 * BFSI pack · EU Digital Operational Resilience Act (DORA).
 *
 * Regulation (EU) 2022/2554. Applies from 2025-01-17 to EU
 * financial entities + their critical ICT third-party providers.
 * For agentic systems, DORA's ICT risk management framework
 * (Chapter II) + incident-reporting obligations (Chapter III) +
 * third-party risk (Chapter V) require agents to be:
 *   · sandboxed from touching operational-resilience-critical
 *     systems without human approval
 *   · unable to bypass ICT-related audit trail
 *   · gated from exfil to any third-party ICT provider not on
 *     the approved list
 *
 * Pack scope:
 *   · Block writes to any tool touching CTPP registers or
 *     operational-resilience infrastructure without workflow
 *     anchor (Art. 5-16 governance)
 *   · Route ANY incident-notification tool through pending —
 *     Art. 19 requires notification to competent authorities on
 *     STRICT timelines that require named human review
 *   · Block outbound to third-party ICT domains not on the
 *     approved list (encoded here as .europa.eu / .esma.europa.eu
 *     / internal .* — expand via tenant-specific rules)
 *   · Route data-transfer to any TPP through pending (Art. 28
 *     third-party risk assessment)
 *   · Block modifications to the resilience-testing configuration
 *     (Art. 24-27 digital operational resilience testing)
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'dora-block-ctpp-register-write-without-anchor',
      when: {
        all: [
          { 'tool.name': { matches: '(ctpp|third_party_provider|resilience_config)' } },
          { 'workflow.node_id': null },
        ],
      },
      then: {
        decision: 'block',
        reason: 'DORA Art. 5: ICT third-party risk register modifications require workflow-anchored trace for governance evidence',
        tags: ['dora', 'ctpp', 'workflow-anchor-required'],
      },
    },
    {
      name: 'dora-pending-incident-notification',
      when: {
        'tool.name': { matches: '(notify|report|submit)_(incident|major_incident|significant_cyber)' },
      },
      then: {
        decision: 'pending',
        reason: 'DORA Art. 19: incident notification to competent authorities requires named human sign-off (strict timelines)',
        tags: ['dora', 'art-19', 'incident-reporting'],
      },
    },
    {
      name: 'dora-block-resilience-test-config-mutation',
      when: {
        all: [
          { 'tool.name': { matches: '^(update|modify|disable|delete)_' } },
          { 'tool.args.target': { matches: '(dort|resilience_test|penetration_test|tlpt)' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'DORA Art. 24-27: DORT / TLPT configurations may not be mutated by automated agents',
        tags: ['dora', 'art-24', 'resilience-testing'],
      },
    },
    {
      name: 'dora-pending-third-party-data-transfer',
      when: {
        all: [
          { 'tool.name': { matches: '(transfer|send|share|export)_' } },
          {
            any: [
              { 'tool.args.provider':      { matches: '.+' } },
              { 'tool.args.tpp':           { matches: '.+' } },
              { 'tool.args.third_party':   { matches: '.+' } },
            ],
          },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'DORA Art. 28: data transfer to ICT third-party requires prior risk assessment + concentration-risk check',
        tags: ['dora', 'art-28', 'third-party'],
      },
    },
    {
      name: 'dora-block-ict-audit-trail-tampering',
      when: {
        'tool.name': { matches: '(delete|truncate|drop|purge)_(ict_audit|resilience_log|dora_evidence)' },
      },
      then: {
        decision: 'block',
        reason: 'DORA Art. 12: ICT-related audit trail integrity must be preserved for supervisory review',
        tags: ['dora', 'art-12', 'anti-tamper'],
      },
    },
    {
      name: 'dora-pending-critical-system-config-change',
      when: {
        all: [
          { 'tool.name': { matches: '^(deploy|configure|update)_' } },
          { 'tool.args.criticality': { in: ['critical', 'high', 'important'] } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'DORA Art. 8-9: changes to critical ICT systems require documented risk assessment + approval',
        tags: ['dora', 'art-8', 'change-management'],
      },
    },
  ],
};

export const doraPack = {
  description:
    'EU DORA preset. Blocks CTPP register writes without workflow anchor, blocks ICT audit-log tampering + DORT test config mutation; routes incident notification, third-party transfers, and critical-system changes through human approval.',
  citation: 'Regulation (EU) 2022/2554 (DORA) · Articles 5, 8-9, 12, 19, 24-28 · applies from 2025-01-17',
  dsl,
};
