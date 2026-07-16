/**
 * BFSI pack · Gramm-Leach-Bliley Act (GLBA) Safeguards Rule.
 *
 * 15 U.S.C. §§ 6801-6809 + 16 CFR Part 314 (as revised by the FTC's
 * 2021 Safeguards Rule amendments). Requires financial institutions
 * to protect "customer information" — any non-public personal
 * information about a consumer.
 *
 * Pack scope:
 *   · Block agents from sending customer-information payloads to
 *     external tools (data exfil to third parties)
 *   · Route database queries that read customer PII through human
 *     approval (least-privilege monitoring)
 *   · Block writes to any tool matching /^(export|share|publish)_/
 *     when the arguments contain customer identifiers (SSN, DOB,
 *     account number)
 *   · Route bulk export tools (matching /export|dump|archive/) to
 *     pending review regardless of workflow node
 *
 * Rules deliberately skew to `pending` for anything a legitimate
 * agent might do in a compliant workflow — tighten to `block` once
 * your agents' baseline is stable.
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'glba-block-external-share-of-ssn',
      when: {
        all: [
          { 'tool.name': { matches: '^(share|send|publish|export)_' } },
          { 'tool.args.ssn': { matches: '\\d{3}-?\\d{2}-?\\d{4}' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'GLBA §501: SSN cannot be shared with third-party tools without customer consent',
        tags: ['glba', 'pii', 'exfil'],
      },
    },
    {
      name: 'glba-pending-external-share-of-account-number',
      when: {
        all: [
          { 'tool.name': { matches: '^(share|send|publish|export)_' } },
          { 'tool.args.account_number': { matches: '\\d{6,}' } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'GLBA §501: bank account numbers require human approval before external sharing',
        tags: ['glba', 'pii'],
      },
    },
    {
      name: 'glba-pending-bulk-customer-export',
      when: {
        'tool.name': { matches: '(export|dump|archive|backup)_customer' },
      },
      then: {
        decision: 'pending',
        reason: 'GLBA §501: bulk customer data export requires human approval + logging (16 CFR 314.4)',
        tags: ['glba', 'bulk-export'],
      },
    },
    {
      name: 'glba-pending-database-read-of-customer-pii',
      when: {
        all: [
          { 'tool.name': { matches: '^(query|select|read)_' } },
          {
            any: [
              { 'tool.args.table':  { matches: '(customer|account|ssn|pii)' } },
              { 'tool.args.column': { matches: '(ssn|dob|account_number|routing)' } },
            ],
          },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'GLBA Safeguards Rule (16 CFR 314.4(c)(1)): customer-info reads require access control + monitoring',
        tags: ['glba', 'db-read'],
      },
    },
    {
      name: 'glba-block-plaintext-http-with-customer-data',
      when: {
        all: [
          { 'tool.name': { matches: '(http|request|fetch|call)' } },
          { 'tool.args.url': { matches: '^http:' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'GLBA Safeguards Rule: encryption of customer information in transit is required (16 CFR 314.4(c)(3))',
        tags: ['glba', 'encryption'],
      },
    },
  ],
};

export const bfsiGlbaPack = {
  description:
    'Gramm-Leach-Bliley Safeguards Rule preset. Blocks SSN exfil + plaintext HTTP with customer data; routes bulk exports and customer-PII reads through human approval.',
  citation: '15 U.S.C. §§ 6801-6809 + 16 CFR Part 314 (FTC Safeguards Rule, 2021 rev.)',
  dsl,
};
