/**
 * Fintech pack · agent-initiated payments (2026-era protocols).
 *
 * Covers the payment surfaces LLM agents actually touch in 2026:
 *   · x402 (Coinbase's HTTP 402 payment protocol for agents)
 *   · Stripe Agentic API (charge / transfer / customer.create from
 *     an agent context — card_present=false, agent as initiator)
 *   · Coinbase Agent Kit (wallet ops, stablecoin transfers)
 *   · Generic stablecoin transfers (USDC / USDT / DAI over any RPC)
 *   · Traditional wire APIs when called by agents (Modern Treasury,
 *     Column, Increase)
 *
 * The unifying pattern: an autonomous agent is moving MONEY. The
 * rules enforce the four load-bearing controls buyers ask about:
 *   1. Threshold-based human approval ("no unattended wire > $X")
 *   2. Allow-list enforcement for recipient wallets / accounts
 *   3. Rate-limit / daily budget (agent can't drain a wallet in
 *      a burst)
 *   4. Complete audit of every dollar-moving call, blocked or not
 *
 * All rules skew toward `pending` (human review) unless the
 * violation is unambiguous (e.g., non-allowlisted recipient over
 * $10k → hard block).
 *
 * Regulatory anchor: Regulation E for US consumer transfers, EU
 * PSD3 for European payment initiation, plus BSA/OFAC for
 * counterparty screening (already covered by bfsi-sox / bfsi-glba
 * — this pack is the AGENT-LAYER complement).
 */

import { PolicyDsl } from '@agentguard/core-schema';

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    // ── x402 protocol ────────────────────────────────────────────
    // Coinbase's x402 uses HTTP 402 Payment Required as a signal
    // the resource is monetized. Agents that auto-pay these need
    // approval past a small "coffee money" threshold.
    {
      name: 'x402-pending-over-50usd',
      when: {
        all: [
          { 'tool.name': { matches: '^(x402|pay_x402|http402)' } },
          { 'tool.args.amount_usd': { '>': 50 } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'x402 auto-payment over $50 requires human approval',
        tags: ['agent-payments', 'x402', 'threshold'],
      },
    },
    {
      name: 'x402-block-over-500usd',
      when: {
        all: [
          { 'tool.name': { matches: '^(x402|pay_x402|http402)' } },
          { 'tool.args.amount_usd': { '>': 500 } },
        ],
      },
      then: {
        decision: 'block',
        reason: 'x402 auto-payment over $500 blocked — likely misuse; escalate manually',
        tags: ['agent-payments', 'x402', 'hard-block'],
      },
    },

    // ── Stripe Agentic API ──────────────────────────────────────
    // Card-not-present + agent-initiated + no human present is the
    // fraud triangle. Any charge in that shape needs review past
    // the small-ticket threshold.
    {
      name: 'stripe-agentic-pending-cnp-charge',
      when: {
        all: [
          { 'tool.name': { matches: '^stripe_(charge|payment_intent|invoice)' } },
          { 'tool.args.card_present': false },
          { 'tool.args.amount': { '>': 10000 } }, // $100 in cents
        ],
      },
      then: {
        decision: 'pending',
        reason: 'Card-not-present agent charge over $100 — human review per Reg E §205.10(b)',
        tags: ['agent-payments', 'stripe-agentic', 'cnp', 'reg-e'],
      },
    },
    {
      name: 'stripe-agentic-block-transfer-to-new-recipient',
      when: {
        all: [
          { 'tool.name': 'stripe_transfer' },
          { 'tool.args.recipient_first_seen_days': { '<': 7 } },
          { 'tool.args.amount': { '>': 100000 } }, // $1000 in cents
        ],
      },
      then: {
        decision: 'block',
        reason: 'Stripe transfer > $1k to recipient seen < 7 days ago — velocity risk; require manual add',
        tags: ['agent-payments', 'stripe-agentic', 'velocity'],
      },
    },

    // ── Stablecoin transfers (USDC / USDT / DAI) ────────────────
    // Wallet-level allow-list enforcement. Agent-initiated stablecoin
    // sends are the top exfil vector for compromised agents — the
    // moment a private key is on the box, funds leave.
    {
      name: 'stablecoin-block-non-allowlisted',
      when: {
        all: [
          { 'tool.name': { matches: '(transfer|send)_(usdc|usdt|dai|stablecoin)' } },
          { 'tool.args.to_allowlisted': false },
        ],
      },
      then: {
        decision: 'block',
        reason: 'Stablecoin transfer to non-allowlisted address blocked — add via out-of-band flow',
        tags: ['agent-payments', 'stablecoin', 'allowlist'],
      },
    },
    {
      name: 'stablecoin-pending-over-10k',
      when: {
        all: [
          { 'tool.name': { matches: '(transfer|send)_(usdc|usdt|dai|stablecoin)' } },
          { 'tool.args.amount_usd': { '>': 10000 } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'Stablecoin transfer > $10k requires human approval + BSA CTR filing consideration',
        tags: ['agent-payments', 'stablecoin', 'bsa'],
      },
    },
    {
      name: 'stablecoin-block-ofac-sanctioned',
      when: {
        all: [
          { 'tool.name': { matches: '(transfer|send)_(usdc|usdt|dai|stablecoin)' } },
          { 'tool.args.to_ofac_flagged': true },
        ],
      },
      then: {
        decision: 'block',
        reason: 'OFAC-sanctioned wallet blocked (OFAC SDN list)',
        tags: ['agent-payments', 'stablecoin', 'ofac', 'sanctions'],
      },
    },

    // ── Wire APIs (Modern Treasury / Column / Increase) ─────────
    // 2-of-N approval on any agent-initiated wire is the industry
    // norm. Rule fires on the shipping tools we've seen in the field.
    {
      name: 'wire-pending-any-agent-initiated',
      when: {
        all: [
          { 'tool.name': { matches: '^(wire|ach|treasury)_(create|initiate|send)' } },
          { 'tool.args.approver_count': { '<': 2 } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'Agent-initiated wire requires 2-of-N approver signature',
        tags: ['agent-payments', 'wire', 'sod'],
      },
    },
    {
      name: 'wire-block-over-daily-budget',
      when: {
        all: [
          { 'tool.name': { matches: '^(wire|ach|treasury)_' } },
          { 'tool.args.would_exceed_daily_budget': true },
        ],
      },
      then: {
        decision: 'block',
        reason: 'Wire would exceed the agent\'s daily spending budget — hard block until budget reset',
        tags: ['agent-payments', 'wire', 'budget'],
      },
    },

    // ── Generic velocity / burst detection ──────────────────────
    // Any payment tool called > N times in a rolling window looks
    // like a compromised agent draining accounts. Fire pending so
    // the operator sees the pattern immediately.
    {
      name: 'payment-pending-burst',
      when: {
        all: [
          { 'tool.name': { matches: '(pay|transfer|send|charge|wire)' } },
          { 'agent.calls_5m': { '>': 20 } },
        ],
      },
      then: {
        decision: 'pending',
        reason: 'Payment burst (>20 calls / 5m) — possible compromise; hold pending SecOps review',
        tags: ['agent-payments', 'velocity', 'burst'],
      },
    },
  ],
};

export const fintechAgentPaymentsPack = {
  description:
    'Agent-initiated payment guardrails for x402, Stripe Agentic API, Coinbase Agent Kit, stablecoin transfers, and Modern Treasury / Column / Increase wire APIs. Threshold-based human approval, allow-list enforcement, velocity detection, OFAC block.',
  citation:
    'Regulation E §205.10 (US consumer transfers) · PSD3 (EU payment initiation) · BSA/OFAC (counterparty screening) · x402 spec (Coinbase, 2025) · Stripe Agentic API docs (2026)',
  dsl,
};
