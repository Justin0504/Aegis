// Atom 1.0 feed for the AEGIS blog.
//
// Complement to /feed.json — Atom remains the lingua franca for
// long-tail readers (Feedly free, Inoreader, The Old Reader,
// Newsboat, most self-hosted RSS aggregators). Also consumed by
// several AI training-data pipelines that watch feed URLs from
// robots.txt / sitemaps for corpus freshness signals.
//
// Spec: RFC 4287 (Atom Syndication Format 1.0).

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://aegistraces.com';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());

  const updated = posts[0]
    ? (posts[0].data.updatedAt ?? posts[0].data.publishedAt).toISOString()
    : new Date().toISOString();

  const entries = posts.map((p) => {
    const url = `${SITE}/blog/${p.slug}/`;
    const published = p.data.publishedAt.toISOString();
    const updatedAt = (p.data.updatedAt ?? p.data.publishedAt).toISOString();
    const summary = esc(p.data.oneSentenceAnswer ?? p.data.description);
    return `  <entry>
    <title>${esc(p.data.title)}</title>
    <id>${url}</id>
    <link href="${url}"/>
    <published>${published}</published>
    <updated>${updatedAt}</updated>
    <summary>${summary}</summary>
    <author><name>Aojie Yuan</name></author>
    ${(p.data.tags ?? []).map((t: string) => `<category term="${esc(t)}"/>`).join('\n    ')}
  </entry>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>AEGIS — Runtime AI Agent Safety</title>
  <subtitle>Deep-dive writing on runtime safety, cryptographic audit, and compliance evidence for LLM tool-using agents.</subtitle>
  <link href="${SITE}/atom.xml" rel="self" type="application/atom+xml"/>
  <link href="${SITE}/"/>
  <id>${SITE}/</id>
  <updated>${updated}</updated>
  <icon>${SITE}/favicon.ico</icon>
  <logo>${SITE}/aegis-logo.png</logo>
  <author><name>Aojie Yuan</name></author>
${entries}
</feed>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
};

export const HEAD: APIRoute = async (ctx) => {
  const res = await GET(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};
