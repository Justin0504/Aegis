/**
 * OAuth + magic-link callback exchanger.
 *
 * The browser SDK's `signInWithOAuth` and `signInWithOtp` both redirect
 * back here with a `code` (PKCE flow) or `token_hash` (magic link).
 * We exchange it for a session and set the cookies before bouncing
 * the user to `next` (default /download).
 *
 * Any error path lands at /login with an ?error=... so the UI can
 * render it inline — never a naked stack trace.
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '@/lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, locals, redirect, request }) => {
  const code       = url.searchParams.get('code');
  const tokenHash  = url.searchParams.get('token_hash');
  const type       = url.searchParams.get('type');
  const next       = url.searchParams.get('next') || '/download';

  const supabase = getServerSupabase(locals, cookies, request);

  try {
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
    } else if (tokenHash && type) {
      const { error } = await supabase.auth.verifyOtp({
        type: type as any,
        token_hash: tokenHash,
      });
      if (error) throw error;
    } else {
      throw new Error('Missing OAuth code / token_hash on callback');
    }
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message || 'auth callback failed');
    return redirect(`/login?error=${msg}`, 302);
  }

  return redirect(next, 302);
};
