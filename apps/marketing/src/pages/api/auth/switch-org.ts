/**
 * POST /api/auth/switch-org  { org_id }
 *
 * Sets the `aegis_current_org` cookie so downstream server-rendered
 * pages + API routes default to this org. Validates the caller
 * actually belongs to the org first — a leaked/forged org_id
 * cookie should never grant access to an org the user isn't a
 * member of. RLS on the underlying tables is the real guarantee;
 * this validation just gives a clear 403 instead of silently
 * showing an empty page.
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const supabase = getServerSupabase(locals, cookies, request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'sign in required' }, 401);

  let body: { org_id?: string };
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  const orgId = body.org_id;
  if (!orgId) return json({ error: 'org_id required' }, 400);

  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!membership) return json({ error: 'not a member of that org' }, 403);

  cookies.set('aegis_current_org', orgId, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,  // one year — refreshed on next switch
  });

  return json({ ok: true, org_id: orgId, role: membership.role }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
