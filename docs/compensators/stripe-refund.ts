/**
 * Compensator: stripe.refund
 *
 * Undoes a `stripe.charge` or `stripe.payment_intent.confirm` by
 * issuing a refund via Stripe's `refunds.create` API. Idempotent by
 * design — Stripe's own `Idempotency-Key` header is passed through
 * from the gateway's `Idempotency-Key` header, so any retry is safe.
 *
 * Cost-estimate hint (register in tenant_config.rollback):
 *   magnitude: high      — refunds are irreversible without cost
 *   currency:  USD
 *
 * Runtime: Node.js 18+ (native fetch). Deploy anywhere that speaks HTTP —
 * Vercel Function, Cloudflare Worker, Fastify, or a bare Express handler.
 */

import type { IncomingMessage, ServerResponse } from 'http';

const STRIPE_API = 'https://api.stripe.com/v1/refunds';

interface RollbackWebhookBody {
  trace_id: string;
  agent_id: string;
  tool_name: string;
  arguments: {
    charge_id?: string;
    payment_intent_id?: string;
    amount?: number;
    reason?: string;
  };
  observation?: { raw_output?: { id?: string } };
  timestamp: string;
}

export async function handleStripeRefund(
  body: RollbackWebhookBody,
  idempotencyKey: string,
  stripeSecretKey: string,
): Promise<{ status: 'ok' | 'no_op'; refund_id?: string; reason?: string }> {
  // Prefer the original observation's charge id (most authoritative)
  // and fall back to arguments if the SDK persisted the input.
  const chargeId =
    body.observation?.raw_output?.id ??
    body.arguments.charge_id ??
    body.arguments.payment_intent_id;

  if (!chargeId) {
    // Nothing to refund. Report no_op so the gateway records this as
    // a successful (but idempotent) compensation.
    return { status: 'no_op', reason: 'no charge_id in arguments or observation' };
  }

  // Payment intent → resolve to charge id via retrieve if we didn't
  // already have the raw charge id.
  const finalChargeId = chargeId.startsWith('pi_')
    ? await resolvePaymentIntentToCharge(chargeId, stripeSecretKey)
    : chargeId;

  if (!finalChargeId) {
    return { status: 'no_op', reason: 'payment intent had no charge yet' };
  }

  const params = new URLSearchParams({
    charge: finalChargeId,
    reason: body.arguments.reason ?? 'requested_by_customer',
  });
  if (typeof body.arguments.amount === 'number') {
    params.set('amount', String(body.arguments.amount));
  }

  const res = await fetch(STRIPE_API, {
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${stripeSecretKey}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      // Stripe honours this header at their end — same key on retry ⇒
      // same refund, never a duplicate.
      'Idempotency-Key': idempotencyKey,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 4xx from Stripe: usually "charge_already_refunded" — treat as no_op.
    if (res.status === 400 && /already[_-]?refunded/i.test(text)) {
      return { status: 'no_op', reason: 'charge already refunded' };
    }
    throw new Error(`Stripe refund failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const refund = await res.json() as { id: string };
  return { status: 'ok', refund_id: refund.id };
}

async function resolvePaymentIntentToCharge(pi: string, key: string): Promise<string | null> {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${pi}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { latest_charge?: string };
  return data.latest_charge ?? null;
}

// ── Example Express handler ──────────────────────────────────────────

export function createExpressHandler(stripeSecretKey: string) {
  return async (req: IncomingMessage & { body: RollbackWebhookBody }, res: ServerResponse) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string
                          ?? (req.body?.trace_id ?? 'no-key');
      const result = await handleStripeRefund(req.body, idempotencyKey, stripeSecretKey);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err?.message ?? 'stripe refund failed' }));
    }
  };
}
