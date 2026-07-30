/**
 * Astro middleware — runs on every SSR request.
 *
 * Responsibilities:
 *   1. Refresh the Supabase session cookie so downstream pages see
 *      a valid user without each page doing session dance.
 *   2. Populate `locals.user` for typed access in .astro components.
 *   3. Gate protected routes — /download and /account require a live
 *      session; unauthenticated requests are redirected to /login
 *      with a `next=` param so the round-trip lands back where the
 *      user started.
 *
 * Public marketing pages (/, /pricing, /security, /docs, /blog, /login,
 * /signup, /contact, etc.) are wide-open — no auth touched.
 */

import { defineMiddleware } from 'astro:middleware';
import { getServerSupabase } from './lib/supabase';

// /account is the sole logged-in-only page — personal home + license
// keys + billing + sign-out. /download stays PUBLIC because the
// desktop bundles are MIT open source and gating them adds friction
// without security benefit. License keys are shown on /account, not
// /download, so anon visitors can still grab the binary but can't
// see anyone's license.
const PROTECTED_PREFIXES = ['/account'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { url, cookies, locals, redirect } = ctx;

  // Supabase is opt-in per env; if not configured, skip auth entirely
  // so a fresh clone can still `npm run dev` for design work.
  try {
    const supabase = getServerSupabase(locals, cookies, ctx.request);
    const { data: { user } } = await supabase.auth.getUser();
    (locals as any).user = user ?? null;
    (locals as any).supabase = supabase;
  } catch (_err) {
    // Env not configured — non-fatal. Auth-gated pages will bounce to /login.
    (locals as any).user = null;
  }

  if (isProtected(url.pathname) && !(locals as any).user) {
    const nextParam = encodeURIComponent(url.pathname + url.search);
    return redirect(`/login?next=${nextParam}`, 302);
  }

  return next();
});
