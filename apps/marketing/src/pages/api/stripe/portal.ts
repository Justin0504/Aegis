/**
 * POST /api/stripe/portal
 *
 * Creates a Stripe Billing Portal session for the current signed-in
 * user and returns the portal URL. Cockpit's Settings page opens
 * the URL in a new tab so paying customers can update card, cancel,
 * download invoices, and switch plan — without our team touching
 * anything.
 *
 * Requires:
 *   - user is signed in (Supabase session)
 *   - user has a profiles.stripe_customer_id (set on first checkout)
 *
 * If the user has never checked out, we short-circuit with 404 so
 * the Cockpit can route them to /pricing instead.
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';
import { getStripe } from '@/lib/stripe';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const supabase = getServerSupabase(locals, cookies, request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'sign in required' }, 401);

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();
  const customerId = profile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    return json({ error: 'no stripe customer — visit /pricing to purchase first' }, 404);
  }

  try {
    const stripe = getStripe(locals);
    const origin = new URL(request.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/account`,
    });
    return json({ url: session.url }, 200);
  } catch (err) {
    return json({ error: `portal creation failed: ${(err as Error).message}` }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
