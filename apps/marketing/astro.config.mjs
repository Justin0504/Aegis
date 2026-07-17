// AEGIS marketing site — aegistraces.com
//
// Distinct from apps/homepage (Justin's personal site at aojieyuan.com)
// and apps/compliance-cockpit (the per-tenant customer app at
// app.aegistraces.com). Public-marketing only: landing, pricing, security,
// blog, signup CTA.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import rehypeAnnotate from './rehype-annotate.mjs';

export default defineConfig({
  site: 'https://aegistraces.com',
  // SSR is required for auth callback + Stripe webhook + session middleware.
  // Static pages remain fully cacheable at the edge; only API routes and
  // session-gated pages hit the Worker. Cloudflare Pages runs the same
  // deploy target, so wrangler.toml stays valid.
  output: 'server',
  adapter: cloudflare({ mode: 'directory' }),
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  markdown: {
    // Auto-annotate: first-occurrence acronyms as <abbr>, glossary
    // terms as <a class="dfn"> deep-linking /blog/glossary#slug, and
    // numeric facts (percentages, ratios) as <span class="fact"> so
    // both humans and LLM crawlers can spot load-bearing numbers.
    rehypePlugins: [rehypeAnnotate],
  },
  // Allow Cloudflare quick-tunnel previews (*.trycloudflare.com) to hit
  // the local dev server. Without this Vite's host-check 403s.
  vite: {
    server: {
      host: true,
      allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    },
  },
});
