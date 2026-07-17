/**
 * Create a Stripe Checkout Session for the caller's requested price_id.
 *
 * Auth: signed-in user required (middleware would have already redirected
 * if not, but we double-check at API layer too — belt + suspenders).
 *
 * Body: { price_id: string, mode?: 'subscription' | 'payment' }
 *   · price_id must be one of the STRIPE_PRICE_* env vars (see stripe.ts)
 *   · mode defaults to 'subscription' (matches all preset plans)
 *
 * Response: { url } — the Checkout redirect URL.
 *
 * Post-purchase entitlement flows through the webhook at
 * /api/stripe-webhook (checkout.session.completed → issue license).
 * This endpoint never issues licenses directly so a network flake between
 * Stripe and the browser can't leave the user paid-but-unlicensed.
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';
import { getStripe, planForPrice, priceForPlan } from '@/lib/stripe';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals, url }) => {
  const supabase = getServerSupabase(locals, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'sign in required' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }

  let body: { price_id?: string; plan?: string; mode?: 'subscription' | 'payment' };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400 }); }

  // Accept EITHER a friendly plan name (safer — the browser never sees
  // price ids) OR an explicit price_id (for internal / admin flows).
  let price_id = body.price_id;
  if (!price_id && body.plan) {
    const resolved = priceForPlan(locals, body.plan);
    if (!resolved) {
      return new Response(JSON.stringify({
        error: `plan "${body.plan}" is not configured — set the corresponding STRIPE_PRICE_* env var`,
      }), { status: 400 });
    }
    price_id = resolved;
  }
  if (!price_id) {
    return new Response(JSON.stringify({ error: 'plan or price_id required' }), { status: 400 });
  }

  const plan = planForPrice(locals, price_id);
  if (!plan) {
    return new Response(JSON.stringify({
      error: `price_id ${price_id} is not on the allow-list`,
    }), { status: 400 });
  }

  const stripe = getStripe(locals);

  // Look up or create the Stripe customer, keyed on the Supabase user id.
  // We stash the id in profiles so subsequent purchases reuse it (avoids
  // dup customer rows in the Stripe dashboard).
  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await supabase.from('profiles')
      .upsert({ id: user.id, email: user.email, stripe_customer_id: customerId }, { onConflict: 'id' });
  }

  const origin = new URL(request.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: body.mode ?? 'subscription',
    customer: customerId,
    line_items: [{ price: price_id, quantity: 1 }],
    success_url: `${origin}/download?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${origin}/pricing?checkout=canceled`,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata: { supabase_user_id: user.id, plan },
    subscription_data: body.mode !== 'payment'
      ? { metadata: { supabase_user_id: user.id, plan } }
      : undefined,
  });

  return new Response(JSON.stringify({ url: session.url }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
