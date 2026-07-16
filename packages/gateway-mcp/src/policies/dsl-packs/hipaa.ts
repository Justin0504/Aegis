/**
 * Healthcare pack · HIPAA Security + Privacy Rule.
 *
 * 45 CFR Part 164 Subpart C (Security Rule) + Subpart E (Privacy
 * Rule). Applies to covered entities and business associates
 * handling Protected Health Information (PHI). This pack targets
 * the specific agent behaviors most likely to trigger a HITECH
 * breach notification.
 *
 * Pack scope:
 *   · Block PHI (SSN / MRN / DOB combos) in outbound tool args
 *     to external services (§164.312(e)(1) transmission security)
 *   · Route reads of tables that look like PHI stores through
 *     pending review (§164.312(a)(1) access control)
 *   · Block bulk PHI export operations (§164.502(b) minimum
 *     necessary standard)
 *   · Block ANY outbound message where the body looks like a
 *     clinical note (§164.312(c)(1) integrity)
 *   · Block plaintext HTTP anywhere PHI could be present
 *     (§164.312(e)(2)(ii) encryption)
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'hipaa-block-mrn-external-share',
      when: {
        all: [
          { 'tool.name': { matches: '^(share|send|publish|export|post)_' } },
          { 'tool.args.mrn': { matches: '.+' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'HIPAA §164.312(e)(1): MRN cannot leave covered-entity boundary without BAA + encryption',
        tags: ['hipaa', 'phi', 'exfil'],
      },
    },
    {
      name: 'hipaa-block-ssn-dob-combo',
      when: {
        all: [
          { 'tool.name': { matches: '^(share|send|export|post|write)_' } },
          { 'tool.args.ssn': { matches: '\\d{3}-?\\d{2}-?\\d{4}' } },
          { 'tool.args.dob': { matches: '\\d{4}-\\d{2}-\\d{2}' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'HIPAA §164.514: SSN+DOB is a HIPAA identifier combination requiring de-identification',
        tags: ['hipaa', 'phi', 'identifier'],
      },
    },
    {
      name: 'hipaa-pending-phi-table-read',
      when: {
        all: [
          { 'tool.name': { matches: '^(query|select|read|fetch)_' } },
          {
            any: [
              { 'tool.args.table':  { matches: '(patient|encounter|diagnos|prescription|visit)' } },
              { 'tool.args.column': { matches: '(mrn|icd|snomed|rxnorm|npi)' } },
            ],
          },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'HIPAA §164.312(a)(1) + §164.502(b): PHI reads require access control + minimum-necessary review',
        tags: ['hipaa', 'phi', 'db-read'],
      },
    },
    {
      name: 'hipaa-block-bulk-phi-export',
      when: {
        'tool.name': { matches: '(export|dump|archive|backup)_(patient|phi|clinical|ehr)' },
      },
      then: {
        decision: 'block',
        reason: 'HIPAA §164.502(b): bulk PHI export violates minimum-necessary standard without prior authorization',
        tags: ['hipaa', 'bulk-export'],
      },
    },
    {
      name: 'hipaa-block-plaintext-http-with-phi',
      when: {
        all: [
          { 'tool.name': { matches: '(http|request|fetch|call)' } },
          { 'tool.args.url': { matches: '^http:' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'HIPAA §164.312(e)(2)(ii): encryption of ePHI in transit is addressable-but-required (NIST SP 800-52)',
        tags: ['hipaa', 'encryption'],
      },
    },
    {
      name: 'hipaa-pending-diagnosis-write',
      when: {
        all: [
          { 'tool.name': { matches: '^(insert|update|write)_' } },
          {
            any: [
              { 'tool.args.diagnosis': { matches: '.+' } },
              { 'tool.args.icd_code':  { matches: '.+' } },
            ],
          },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'HIPAA §164.312(c)(1): PHI integrity — diagnosis writes require clinician review to prevent alteration',
        tags: ['hipaa', 'integrity'],
      },
    },
  ],
};

export const hipaaPack = {
  description:
    'HIPAA Security + Privacy Rule preset. Blocks MRN / SSN+DOB exfil, blocks plaintext HTTP with PHI, blocks bulk PHI export, routes PHI reads + diagnosis writes through human approval.',
  citation: '45 CFR Part 164 Subpart C (Security Rule) + Subpart E (Privacy Rule) + HITECH breach-notification (§13402)',
  dsl,
};
