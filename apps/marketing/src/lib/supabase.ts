/**
 * Supabase clients — one per request context.
 *
 *   getBrowserSupabase() — for <script is:inline> on the client. Reads env
 *                          from import.meta.env at build time (PUBLIC_ vars).
 *   getServerSupabase()  — for Astro API routes + middleware. Reads env
 *                          from Astro's runtime env (Cloudflare bindings +
 *                          process.env fallback for `astro dev`).
 *
 * The server client is bound to the current request's cookies so
 * `session.getSession()` returns the live user; the browser client is
 * anon-scoped and lets the user sign in via OAuth redirect.
 *
 * All secrets live in Cloudflare Pages env (production) or .env (dev).
 * See docs/AUTH-SETUP.md for the full setup.
 */

import { createServerClient, createBrowserClient } from '@supabase/ssr';
import type { AstroCookies } from 'astro';

/** Read a runtime env var with Cloudflare + Node fallback. */
export function readEnv(locals: App.Locals, key: string): string | undefined {
  const cfEnv = (locals as any)?.runtime?.env;
  if (cfEnv && typeof cfEnv === 'object' && key in cfEnv) return cfEnv[key];
  if (typeof process !== 'undefined' && process.env && key in process.env) {
    return process.env[key];
  }
  return undefined;
}

/** Public URL — safe to embed in <script>. */
export function getPublicSupabaseUrl(locals: App.Locals): string {
  return readEnv(locals, 'PUBLIC_SUPABASE_URL') ?? '';
}
export function getPublicSupabaseAnonKey(locals: App.Locals): string {
  return readEnv(locals, 'PUBLIC_SUPABASE_ANON_KEY') ?? '';
}

/**
 * Server-side Supabase client. Wire this into every SSR page or API
 * route that needs to know who the user is. Reads/writes cookies via
 * Astro's typed cookies helper so session refresh is transparent.
 */
export function getServerSupabase(
  locals: App.Locals,
  cookies: AstroCookies,
) {
  const url = getPublicSupabaseUrl(locals);
  const anon = getPublicSupabaseAnonKey(locals);
  if (!url || !anon) {
    throw new Error('Supabase env not configured (PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY). See docs/AUTH-SETUP.md.');
  }
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookies.headers()
          .toString()
          .split(';')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => {
            const [name, ...rest] = c.split('=');
            return { name, value: decodeURIComponent(rest.join('=')) };
          });
      },
      setAll(list) {
        for (const { name, value, options } of list) {
          cookies.set(name, value, {
            ...(options as any),
            path: options?.path ?? '/',
            httpOnly: options?.httpOnly ?? true,
            secure:   options?.secure   ?? true,
            sameSite: options?.sameSite ?? 'lax',
          });
        }
      },
    },
  });
}

/**
 * Service-role client — bypasses RLS. Use ONLY in webhook handlers
 * and other server-side flows where the caller is trusted (Stripe
 * webhook, cron jobs). NEVER ship this key to the browser.
 */
export function getServiceSupabase(locals: App.Locals) {
  const url = getPublicSupabaseUrl(locals);
  const service = readEnv(locals, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) {
    throw new Error('Service-role Supabase not configured (SUPABASE_SERVICE_ROLE_KEY). Only set on server; never expose to browser.');
  }
  // Service-role bypasses RLS. Import at call site so any accidental
  // browser reference stays impossible.
  const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
  return createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Browser factory — returns a client that reads/writes cookies via
 *  document.cookie. Used by the login form's inline script. */
export function browserSupabaseFactory(url: string, anon: string) {
  return createBrowserClient(url, anon);
}
