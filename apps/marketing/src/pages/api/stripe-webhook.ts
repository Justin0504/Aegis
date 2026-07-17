/**
 * Stripe webhook — the source of truth for entitlement.
 *
 * Events handled:
 *   · checkout.session.completed          → issue license, upsert subscription
 *   · customer.subscription.updated       → sync status / period end
 *   · customer.subscription.deleted       → revoke license
 *   · invoice.payment_failed              → mark past_due (no license revoke;
 *                                            Stripe retries handle this)
 *
 * Signature verification is REQUIRED (STRIPE_WEBHOOK_SECRET). Without
 * it any actor could POST a fake "session completed" event and hand
 * themselves an enterprise license. Rejected requests return 400 —
 * Stripe interprets that as "delivery failed" and retries later.
 *
 * We use the service-role Supabase client here because entitlement
 * writes bypass row-level security (the webhook is trusted server code).
 */

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getStripe, getWebhookSecret, planForPrice } from '@/lib/stripe';
import { getServiceSupabase } from '@/lib/supabase';

export const prerender = false;

/** Generate a signed-ish license key. Not cryptographically strong
 *  on its own — the source of truth is the `license_keys` row —
 *  but the format makes it visually distinct from other tokens the
 *  user might see. */
function newLicenseKey(plan: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `AEGIS-${plan.toUpperCase()}-${b64}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const stripe = getStripe(locals);
  const secret = getWebhookSecret(locals);

  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('missing stripe-signature', { status: 400 });

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, secret);
  } catch (err) {
    return new Response(`webhook signature verify failed: ${(err as Error).message}`, { status: 400 });
  }

  const supabase = getServiceSupabase(locals);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.supabase_user_id;
        const plan   = session.metadata?.plan || 'pro';
        if (!userId) break;

        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await supabase.from('subscriptions').upsert({
            id: sub.id,
            user_id: userId,
            price_id: sub.items.data[0]?.price.id ?? null,
            status: sub.status,
            current_period_end: new Date((sub.current_period_end as number) * 1000).toISOString(),
            cancel_at_period_end: sub.cancel_at_period_end,
            metadata: sub.metadata,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' });
        }

        // Issue license key. Idempotency: use session.id as the license
        // key's `checkout_session_id`; re-delivery of the same event
        // (Stripe retries on 5xx) upserts the SAME row instead of
        // handing the buyer a second key.
        const key = newLicenseKey(plan);
        await supabase.from('license_keys').upsert({
          key,
          user_id: userId,
          plan,
          status: 'active',
          checkout_session_id: session.id,
          subscription_id: subId,
        }, { onConflict: 'checkout_session_id' });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;
        await supabase.from('subscriptions').upsert({
          id: sub.id,
          user_id: userId,
          price_id: sub.items.data[0]?.price.id ?? null,
          status: sub.status,
          current_period_end: new Date((sub.current_period_end as number) * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          metadata: sub.metadata,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
        // Revoke any active licenses on this sub if the sub is dead.
        if (['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status)) {
          await supabase.from('license_keys')
            .update({ status: 'revoked' })
            .eq('subscription_id', sub.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await supabase.from('subscriptions').update({
          status: 'canceled',
          updated_at: new Date().toISOString(),
        }).eq('id', sub.id);
        await supabase.from('license_keys')
          .update({ status: 'revoked' })
          .eq('subscription_id', sub.id);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (subId) {
          await supabase.from('subscriptions').update({
            status: 'past_due',
            updated_at: new Date().toISOString(),
          }).eq('id', subId);
          // Deliberately DO NOT revoke license on first failure — Stripe
          // retries for ~4 weeks. Revocation happens on subscription.deleted.
        }
        break;
      }
    }
  } catch (err) {
    // Log + 500 so Stripe retries. Never swallow — a silent failure
    // means paid users go unlicensed.
    console.error('stripe webhook handler error', event.type, err);
    return new Response(`handler error: ${(err as Error).message}`, { status: 500 });
  }

  return new Response('ok', { status: 200 });
};
