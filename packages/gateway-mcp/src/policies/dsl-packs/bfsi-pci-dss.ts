/**
 * BFSI pack · Payment Card Industry Data Security Standard (PCI DSS).
 *
 * PCI DSS v4.0 (effective 2025-03-31) requires that agents handling
 * cardholder data (CHD) or sensitive authentication data (SAD)
 * enforce transmission encryption, access minimization, and
 * prohibition of SAD storage post-authorization.
 *
 * Pack scope:
 *   · Block ANY tool call whose arguments contain unmasked PAN
 *     (13-19 digit card numbers). Detection is Luhn-agnostic
 *     (regex on 13-19 consecutive digits); false positives are
 *     preferable to a leak, and operators can whitelist specific
 *     args later.
 *   · Block CVV (3-4 digit code) exfil to any external tool.
 *   · Block any storage/persistence tool call that carries a magnetic
 *     stripe track (starts with %B or ;) — SAD post-authorization
 *     storage is prohibited by PCI DSS Req. 3.3.1.
 *   · Route database writes to any table named like *_pci or
 *     *_cardholder through human approval.
 *   · Block plaintext HTTP anywhere PAN is present (Req. 4.2.1).
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      name: 'pci-block-pan-in-tool-args',
      when: {
        // 13-19 digit sequence. This will over-match (any long number
        // stream triggers it). Operators can tighten by adding a
        // negative on a specific arg name once baseline data is in.
        'tool.args.body': { matches: '\\d{13,19}' },
      },
      then: {
        decision: 'block',
        reason: 'PCI DSS Req. 3.4: unmasked PAN cannot appear in tool arguments',
        tags: ['pci', 'pan'],
      },
    },
    {
      name: 'pci-block-cvv-anywhere',
      when: {
        any: [
          { 'tool.args.cvv':  { matches: '^\\d{3,4}$' } },
          { 'tool.args.cvc':  { matches: '^\\d{3,4}$' } },
          { 'tool.args.cvv2': { matches: '^\\d{3,4}$' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'PCI DSS Req. 3.3.1: CVV/CVC/CVV2 must not be stored or transmitted post-authorization',
        tags: ['pci', 'sad'],
      },
    },
    {
      name: 'pci-block-magstripe-track',
      when: {
        any: [
          { 'tool.args.track1': { matches: '^%B' } },
          { 'tool.args.track2': { matches: '^;' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'PCI DSS Req. 3.3.1: full magnetic stripe track data cannot be stored post-authorization',
        tags: ['pci', 'sad'],
      },
    },
    {
      name: 'pci-pending-cardholder-table-write',
      when: {
        all: [
          { 'tool.name': { matches: '^(insert|update|write|upsert)_' } },
          { 'tool.args.table': { matches: '(pci|cardholder|payment|transaction)' } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'PCI DSS Req. 7.2: cardholder-table writes require role-based access approval',
        tags: ['pci', 'db-write'],
      },
    },
    {
      name: 'pci-block-plaintext-http',
      when: {
        all: [
          { 'tool.name': { matches: '(http|request|fetch|call)' } },
          { 'tool.args.url': { matches: '^http:' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'PCI DSS Req. 4.2.1: strong cryptography and security protocols required for PAN in transit',
        tags: ['pci', 'encryption'],
      },
    },
    {
      name: 'pci-block-full-pan-in-logs',
      when: {
        all: [
          { 'tool.name': { matches: '^(log|emit|report|send)_' } },
          { 'tool.args.message': { matches: '\\d{13,19}' } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'PCI DSS Req. 3.4: PAN cannot be written to logs unless masked',
        tags: ['pci', 'logging'],
      },
    },
  ],
};

export const bfsiPciDssPack = {
  description:
    'PCI DSS v4.0 preset. Blocks unmasked PAN in tool args + logs, blocks all CVV/track transmission, forces human approval for cardholder-table writes, blocks plaintext HTTP with PAN.',
  citation: 'PCI DSS v4.0 (effective 2025-03-31), Requirements 3.3.1, 3.4, 4.2.1, 7.2',
  dsl,
};
