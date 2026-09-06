// JSON Feed 1.1 (jsonfeed.org) for the AEGIS blog.
//
// Why serve a JSON Feed in addition to Atom/RSS?
//   - Slack + Discord unfurl JSON Feed better than RSS (icons, HTML
//     body, favicon all in one payload — no separate feed metadata
//     dance).
//   - Reader.ai / Feedly Pro / Fraidycat / NetNewsWire all consume
//     JSON Feed natively; some newer AI reading-list tools accept
//     ONLY JSON Feed (no XML parser).
//   - AI answer engines increasingly use feed subscriptions as a
//     freshness signal — a live JSON Feed at a stable URL is one
//     of the few no-cost ways to keep them re-crawling.
//
// Spec: https://www.jsonfeed.org/version/1.1/

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://aegistraces.com';

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'AEGIS — Runtime AI Agent Safety',
    home_page_url: `${SITE}/`,
    feed_url: `${SITE}/feed.json`,
    description: 'Deep-dive writing on runtime safety, cryptographic audit, and compliance evidence for LLM tool-using agents. Every article carries a citable one-sentence answer, load-bearing numeric claims, and TechArticle / FAQPage / HowTo JSON-LD.',
    language: 'en-US',
    icon: `${SITE}/aegis-logo.png`,
    favicon: `${SITE}/favicon.ico`,
    authors: [{
      name: 'Aojie Yuan',
      url: 'https://aegistraces.com/blog',
      avatar: `${SITE}/aegis-logo.png`,
    }],
    items: posts.map((p) => ({
      id: `${SITE}/blog/${p.slug}/`,
      url: `${SITE}/blog/${p.slug}/`,
      title: p.data.title,
      summary: p.data.oneSentenceAnswer ?? p.data.description,
      content_text: p.body,
      date_published: p.data.publishedAt.toISOString(),
      date_modified: (p.data.updatedAt ?? p.data.publishedAt).toISOString(),
      tags: p.data.tags ?? [],
      _aegis: {
        // Custom extension: canonical query the article answers +
        // the load-bearing statistic. Some AI aggregators pluck
        // these for higher-quality summarisation.
        answers_query: p.data.answersQuery ?? null,
        headline_stat: p.data.headlineStat ?? null,
        cluster: p.data.cluster ?? null,
      },
    })),
  };

  const body = JSON.stringify(feed, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/feed+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
};

export const HEAD: APIRoute = async (ctx) => {
  const res = await GET(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};
