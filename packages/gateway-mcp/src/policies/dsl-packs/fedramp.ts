/**
 * Government pack · FedRAMP Moderate baseline (NIST SP 800-53 Rev 5).
 *
 * The FedRAMP Moderate baseline aligns with NIST SP 800-53 Rev 5
 * control families. This pack targets the controls most directly
 * violated by an unchecked agent: AC (Access Control), AU (Audit),
 * SC (System & Communications Protection), SI (System & Information
 * Integrity).
 *
 * Pack scope:
 *   · AC-4 (info flow enforcement) — block any egress to a
 *     non-.gov / non-.mil / non-explicitly-approved domain
 *   · AC-6 (least privilege) — block ALL shell / exec / eval
 *     tool calls (agent should never need arbitrary code exec)
 *   · AU-9 (audit log protection) — block any log-mutation call
 *   · SC-13 (cryptographic protection) — block plaintext HTTP
 *   · SC-28 (protection at rest) — block writes to any storage
 *     tool matching /^(s3_|blob_|store_)/ with plain payloads
 *     larger than 64 KB (heuristic for bulk exfil without going
 *     through the approved encryption gateway)
 *   · SI-4 (system monitoring) — pending on any tool that could
 *     disable monitoring (turn_off / disable / suppress)
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'fedramp-block-non-gov-egress',
      when: {
        all: [
          { 'tool.name': { matches: '(http|request|fetch|call|post|get)' } },
          // Anything that DOESN'T look like a .gov, .mil, or an
          // explicitly-allowed private domain.
          { 'tool.args.url': { matches: '^https?://(?!.*\\.(gov|mil)(/|$))' } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'NIST 800-53 AC-4: outbound to non-.gov/.mil destination requires info-flow enforcement review',
        tags: ['fedramp', 'ac-4', 'egress'],
      },
    },
    {
      name: 'fedramp-block-arbitrary-code-exec',
      when: {
        'tool.name': { matches: '^(shell|exec|eval|run_command|subprocess|bash|sh)' },
      },
      then: {
        decision: 'block',
        reason: 'NIST 800-53 AC-6: least-privilege violation — agents may not invoke arbitrary code execution tools',
        tags: ['fedramp', 'ac-6', 'code-exec'],
      },
    },
    {
      name: 'fedramp-block-audit-log-mutation',
      when: {
        'tool.name': { matches: '(delete|truncate|drop|clear|purge|rotate_out)_(audit|log|events)' },
      },
      then: {
        decision: 'block',
        reason: 'NIST 800-53 AU-9: audit records must be protected against unauthorized modification and deletion',
        tags: ['fedramp', 'au-9', 'anti-tamper'],
      },
    },
    {
      name: 'fedramp-block-plaintext-http',
      when: {
        all: [
          { 'tool.name': { matches: '(http|request|fetch|call)' } },
          { 'tool.args.url': { matches: '^http:' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'NIST 800-53 SC-13 + SC-8: cryptographic protection of transmitted information required',
        tags: ['fedramp', 'sc-13', 'encryption'],
      },
    },
    {
      name: 'fedramp-pending-monitoring-disable',
      when: {
        'tool.name': { matches: '(disable|turn_off|suppress|silence)_(alert|monitor|log|audit|siem)' },
      },
      then: {
        decision: 'pending',
        reason: 'NIST 800-53 SI-4: disabling monitoring requires named authorising official approval',
        tags: ['fedramp', 'si-4', 'monitoring'],
      },
    },
    {
      name: 'fedramp-pending-bulk-blob-write',
      when: {
        all: [
          { 'tool.name': { matches: '^(s3_upload|blob_put|store_write|azure_blob|gcs_upload)' } },
          { 'tool.args.size_bytes': { '>': 65536 } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'NIST 800-53 SC-28: bulk data-at-rest write must go through the approved crypto gateway',
        tags: ['fedramp', 'sc-28', 'bulk-write'],
      },
    },
  ],
};

export const fedrampPack = {
  description:
    'FedRAMP Moderate (NIST SP 800-53 Rev 5) preset. Blocks arbitrary code exec, audit-log mutation, plaintext HTTP; routes non-.gov egress, monitoring-disable, and bulk blob writes through human approval.',
  citation: 'FedRAMP Moderate baseline · NIST SP 800-53 Rev 5 controls AC-4, AC-6, AU-9, SC-8, SC-13, SC-28, SI-4',
  dsl,
};
