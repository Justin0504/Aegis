/**
 * POST /api/team/invite
 *
 * Body: { email: string, role: 'admin' | 'member' | 'viewer' }
 *
 * Only owners + admins of the current org can invite. Flow:
 *
 *   1. Validate caller is owner/admin of some org.
 *   2. Insert row in organization_invites (email + role).
 *   3. Trigger a Supabase magic-link email to that address —
 *      pointing at /login?next=/account (they'll auto-join their
 *      org via the on_auth_user_created_org trigger since the
 *      invite row is now waiting).
 *   4. Return { invite_id, sent_to } for the UI to show a toast.
 *
 * On revoke: DELETE /api/team/invite?id=... (owner + admin only).
 */

import type { APIRoute } from 'astro';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase';

export const prerender = false;

const ROLE_ALLOWED = new Set(['admin', 'member', 'viewer']);

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const supabase = getServerSupabase(locals, cookies, request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'sign in required' }, 401);

  let body: { email?: string; role?: string; org_id?: string };
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  // Multi-org users: prefer the org they've explicitly switched to
  // (aegis_current_org cookie set by /api/auth/switch-org). Body-
  // supplied org_id still wins if present.
  if (!body.org_id) {
    const cookieOrgId = cookies.get('aegis_current_org')?.value;
    if (cookieOrgId) body.org_id = cookieOrgId;
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const role  = (body.role  ?? 'member').toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'valid email required' }, 400);
  }
  if (!ROLE_ALLOWED.has(role)) {
    return json({ error: `role must be one of ${[...ROLE_ALLOWED].join(', ')}` }, 400);
  }

  // Resolve the caller's org: either explicitly passed (multi-org
  // users) or their owner/admin membership.
  const { data: memberships, error: mErr } = await supabase
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .in('role', ['owner', 'admin']);
  if (mErr) return json({ error: mErr.message }, 500);
  if (!memberships || memberships.length === 0) {
    return json({ error: 'you must be an owner or admin of an org to invite' }, 403);
  }

  const orgId = body.org_id
    ?? memberships[0].org_id;  // default to first admin/owner org
  const isMember = memberships.some((m) => m.org_id === orgId);
  if (!isMember) return json({ error: 'not an owner/admin of that org' }, 403);

  // Prevent inviting a user who is ALREADY a member.
  const service = getServiceSupabase(locals);
  const { data: existingUser } = await service.auth.admin.listUsers();
  const preexisting = existingUser?.users?.find((u) => u.email?.toLowerCase() === email);
  if (preexisting) {
    const { data: existingMember } = await service
      .from('organization_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', preexisting.id)
      .maybeSingle();
    if (existingMember) {
      return json({ error: `${email} is already a member of this org` }, 409);
    }
    // If the user exists but isn't a member yet, insert directly —
    // no need to send an invite email, they can just switch orgs.
    const { error: insertErr } = await service
      .from('organization_members')
      .insert({ org_id: orgId, user_id: preexisting.id, role, invited_by: user.id });
    if (insertErr) return json({ error: insertErr.message }, 500);
    return json({ invite_id: null, sent_to: email, immediate: true }, 200);
  }

  // New user — record the invite, then send a magic-link email.
  const { data: invite, error: invErr } = await service
    .from('organization_invites')
    .upsert(
      { org_id: orgId, email, role, invited_by: user.id, accepted_at: null, revoked_at: null },
      { onConflict: 'org_id,email' },
    )
    .select('id')
    .single();
  if (invErr) return json({ error: invErr.message }, 500);

  // Send Supabase magic-link. The email template is the same one
  // we already ship (supabase/templates/magic-link.html), pointing
  // at /api/auth/callback which sets a session; the auth trigger
  // then auto-joins them to the org because their email matches a
  // pending invite row.
  const origin = new URL(request.url).origin;
  const { error: otpErr } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/api/auth/callback?next=/account`,
  });
  // Note: inviteUserByEmail creates the auth.users row + sends the
  // invite email in one shot. If the user later signs in via
  // GitHub/Google with the SAME email, Supabase links them to that
  // row automatically.
  if (otpErr && !otpErr.message.toLowerCase().includes('already been registered')) {
    return json({ error: otpErr.message }, 500);
  }

  return json({ invite_id: invite.id, sent_to: email, immediate: false }, 200);
};

// Revoke an outstanding invite.
export const DELETE: APIRoute = async ({ request, cookies, locals, url }) => {
  const supabase = getServerSupabase(locals, cookies, request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'sign in required' }, 401);

  const inviteId = url.searchParams.get('id');
  if (!inviteId) return json({ error: 'id query param required' }, 400);

  const { data, error } = await supabase
    .from('organization_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', inviteId)
    .select('id')
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data)  return json({ error: 'invite not found or not authorized' }, 404);

  return json({ ok: true }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
