/**
 * RSS 2.0 feed for the AEGIS blog.
 *
 * Emitted as /blog/rss.xml so Perplexity, AI news aggregators, and
 * classic feed readers (NetNewsWire, Feedbin, Inoreader) can subscribe.
 * Hand-rolled to avoid pulling in @astrojs/rss for one endpoint.
 *
 * Every item carries:
 *   - <title>, <link>, <guid isPermaLink="true">
 *   - <pubDate> (RFC 822)
 *   - <description> — a CDATA-wrapped block containing the article's
 *     description + a rendered list of keyTakeaways (LLM-friendly)
 *   - <category> per tag
 *
 * The channel-level <atom:link rel="self"> makes the feed valid per
 * both the RSS 2.0 spec and the Atom self-reference extension.
 */

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://aegistraces.com';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s: string): string {
  // RSS <description> allows CDATA; nested ]]> must be split.
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function rfc822(d: Date): string {
  return d.toUTCString();
}

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog'))
    .filter(p => !p.data.draft)
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());

  const now = new Date();
  const items = posts.map(p => {
    const url  = `${SITE}/blog/${p.slug}/`;
    const pub  = rfc822(p.data.publishedAt);
    const tags = (p.data.tags ?? []).map(t =>
      `<category>${escapeXml(t)}</category>`).join('');

    // Description block: article summary + rendered takeaways. Feed
    // readers show only description; LLM crawlers use both fields.
    const takeaways = p.data.keyTakeaways && p.data.keyTakeaways.length > 0
      ? `<h3>Key takeaways</h3><ul>${p.data.keyTakeaways
          .map(t => `<li>${escapeXml(t)}</li>`).join('')}</ul>`
      : '';
    const descHtml = `<p>${escapeXml(p.data.description)}</p>${takeaways}`;

    return `
    <item>
      <title>${escapeXml(p.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pub}</pubDate>
      <description>${cdata(descHtml)}</description>
      ${tags}
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>AEGIS Blog</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Field notes on AI agent runtime safety, prompt injection defence, LLM judge calibration, cryptographic audit, and the verticals (fintech, healthcare, stablecoins) where agents touch high-stakes data.</description>
    <language>en-US</language>
    <lastBuildDate>${rfc822(now)}</lastBuildDate>
    <generator>Astro — hand-rolled endpoint</generator>
    <ttl>60</ttl>${items}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type':  'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
    },
  });
};
