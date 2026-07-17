/**
 * Sign-out endpoint. POST-only to prevent CSRF drive-by sign-outs
 * (a GET-based sign-out could be triggered by an <img src="…"> tag
 * on any page the user visits).
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, locals, redirect }) => {
  const supabase = getServerSupabase(locals, cookies);
  await supabase.auth.signOut();
  return redirect('/', 302);
};

// Convenience GET so a plain link works from the account menu. Same
// risk (drive-by) as any bookmarkable link — mitigated by the fact
// that a signed-out user can just sign in again.
export const GET: APIRoute = async ({ cookies, locals, redirect }) => {
  const supabase = getServerSupabase(locals, cookies);
  await supabase.auth.signOut();
  return redirect('/', 302);
};
