/**
 * POST /api/team/remove
 *
 * Body: { org_id: string, user_id: string }
 *
 * Only owners can remove other members. Owners cannot remove
 * themselves (must transfer ownership first — separate endpoint).
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const supabase = getServerSupabase(locals, cookies, request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'sign in required' }, 401);

  let body: { org_id?: string; user_id?: string };
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  const orgId    = body.org_id;
  const targetId = body.user_id;
  if (!orgId || !targetId) return json({ error: 'org_id and user_id required' }, 400);

  if (targetId === user.id) {
    return json({ error: 'owners cannot remove themselves — transfer ownership first' }, 400);
  }

  // Verify caller is owner of this org.
  const { data: myMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (myMembership?.role !== 'owner') {
    return json({ error: 'only owners can remove members' }, 403);
  }

  const { error } = await supabase
    .from('organization_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', targetId);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
