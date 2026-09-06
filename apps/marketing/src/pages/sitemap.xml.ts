// Sitemap for SEO. Auto-emits every page under src/pages/*.astro with
// lastmod = build time. Blog posts are pulled dynamically from the
// content collection so we don't have to hand-maintain the list.
// Re-built on every Cloudflare Pages deploy.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://aegistraces.com';

const pages = [
  { path: '/blog',                   priority: '0.9', changefreq: 'daily'   },
  { path: '/',                       priority: '1.0', changefreq: 'weekly'  },
  { path: '/pricing',                priority: '0.9', changefreq: 'monthly' },
  { path: '/download',               priority: '0.9', changefreq: 'weekly'  },
  { path: '/signup',                 priority: '0.9', changefreq: 'monthly' },
  { path: '/login',                  priority: '0.5', changefreq: 'monthly' },
  { path: '/features/scanner',           priority: '0.9', changefreq: 'monthly' },
  { path: '/features/policy-generator',  priority: '0.9', changefreq: 'monthly' },
  { path: '/features/predeploy',         priority: '0.9', changefreq: 'monthly' },
  { path: '/features/customize',         priority: '0.9', changefreq: 'monthly' },
  { path: '/docs',                   priority: '0.8', changefreq: 'weekly'  },
  { path: '/docs/self-host',         priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/sdk',               priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/api',               priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/policy-templates',  priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/ontology',          priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/compliance',        priority: '0.7', changefreq: 'monthly' },
  { path: '/security',               priority: '0.8', changefreq: 'monthly' },
  // Compliance + regulation-specific landing. /eu-ai-act is
  // date-sensitive (Aug 2 2026 deadline) → weekly changefreq
  // keeps Googlebot re-crawling around the deadline.
  { path: '/eu-ai-act',              priority: '0.9', changefreq: 'weekly'  },
  { path: '/case-studies',           priority: '0.8', changefreq: 'weekly'  },
  // Answer-engine landing: category catalogue with FAQPage +
  // ItemList schema. High-intent search + zero-click AI answers.
  { path: '/tools',                  priority: '0.95', changefreq: 'weekly' },
  // Competitor "AEGIS vs X" landings — high-intent long-tail.
  { path: '/vs/microsoft-agt',       priority: '0.8',  changefreq: 'monthly' },
  { path: '/vs/langfuse',            priority: '0.8',  changefreq: 'monthly' },
  { path: '/vs/prediction-guard',    priority: '0.8',  changefreq: 'monthly' },
  // Lakera is the highest-volume competitor query. Higher priority
  // and weekly changefreq so answer engines refetch as the market moves.
  { path: '/vs/lakera-guard',        priority: '0.9',  changefreq: 'weekly'  },
  // Two more competitor landings targeting complementary categories:
  // Guardrails AI (output validation) and NeMo Guardrails (dialog rails).
  { path: '/vs/guardrails-ai',       priority: '0.85', changefreq: 'monthly' },
  { path: '/vs/nemo-guardrails',     priority: '0.85', changefreq: 'monthly' },
  // /guides — answer-engine-bait landings for high-volume queries.
  // Each ships HowTo / ItemList / FAQPage schema. Higher priority
  // than blog because they answer a canonical query verbatim.
  { path: '/guides/how-to-secure-ai-agents',        priority: '0.95', changefreq: 'weekly' },
  { path: '/guides/agent-tool-call-risks',          priority: '0.9',  changefreq: 'weekly' },
  { path: '/guides/open-source-guardrails-2026',    priority: '0.9',  changefreq: 'weekly' },
  // Canonical FAQ + blog cluster landings — GEO surface for answer
  // engines that preferentially crawl /faq or topical landings.
  { path: '/faq',                                   priority: '0.9',  changefreq: 'monthly' },
  // Changelog + feed indexes. changelog is a freshness signal; feeds
  // (Atom + JSON Feed) are subscribed by RSS readers + AI reading-
  // list agents, so listing them in sitemap helps discovery even
  // though the Layout also emits <link rel="alternate">.
  { path: '/changelog',                             priority: '0.75', changefreq: 'weekly' },
  { path: '/atom.xml',                              priority: '0.6',  changefreq: 'weekly' },
  { path: '/feed.json',                             priority: '0.6',  changefreq: 'weekly' },
  // Trailing slash — /blog/cluster/<slug> redirects to the slashed
  // version (Astro default for nested dynamic routes), so the
  // sitemap listing points at the canonical 200 URL directly to
  // avoid burning crawler budget on 308 hops.
  { path: '/blog/cluster/agent-safety/',            priority: '0.85', changefreq: 'weekly' },
  { path: '/blog/cluster/verticals/',               priority: '0.85', changefreq: 'weekly' },
  { path: '/blog/cluster/comparison/',              priority: '0.85', changefreq: 'weekly' },
  { path: '/blog/cluster/deep-dive/',               priority: '0.85', changefreq: 'weekly' },
  { path: '/status',                 priority: '0.6', changefreq: 'daily'   },
  { path: '/privacy',                priority: '0.4', changefreq: 'yearly'  },
  { path: '/terms',                  priority: '0.4', changefreq: 'yearly'  },
  { path: '/dpa',                    priority: '0.4', changefreq: 'yearly'  },
];

export const GET: APIRoute = async () => {
  const now = new Date().toISOString().split('T')[0];

  // Pull blog posts at build time so every published post gets its
  // own sitemap entry with its real lastmod date (LLM crawlers care
  // about freshness here).
  const posts = (await getCollection('blog'))
    .filter(p => !p.data.draft)
    .map(p => ({
      path: `/blog/${p.slug}/`,
      priority:   '0.8',
      changefreq: 'monthly',
      lastmod:    (p.data.updatedAt ?? p.data.publishedAt)
                    .toISOString().split('T')[0],
    }));

  const allPages = [
    ...pages.map(p => ({ ...p, lastmod: now })),
    ...posts,
  ];

  const urls = allPages.map(p => `  <url>
    <loc>${SITE}${p.path}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // 24h edge cache is fine — sitemap changes only on deploy.
      'Cache-Control': 'public, max-age=86400',
    },
  });
};

// Explicit HEAD handler. Without it, HEAD requests fall through to
// Astro's 404 handler and older AI crawlers (PerplexityBot,
// classic BingBot, Slack unfurl) that HEAD-before-GET simply skip
// the sitemap. Returns the same headers as GET, empty body.
export const HEAD: APIRoute = async (ctx) => {
  const res = await GET(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};
