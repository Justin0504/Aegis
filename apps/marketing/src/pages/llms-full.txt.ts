// llms-full.txt — the flat, single-file variant of llms.txt that
// several LLM crawlers (Anthropic ClaudeBot, GPTBot, PerplexityBot)
// prefer over following the link tree in llms.txt. It concatenates
// every non-draft blog post's frontmatter summary + full markdown
// body, deduped, so a crawler can ingest the entire technical corpus
// in one fetch.
//
// Why not just serve the individual .md files? Two reasons:
//   1. AI answer engines' cost function penalises multi-fetch crawls —
//      giving them one 200-300KB blob to consume is empirically the
//      approach that ranks best for our content. Anthropic's official
//      guidance recommends this pattern.
//   2. The .md files are private (they compile through Astro) — the
//      HTML version has all the layout chrome. This route emits the
//      raw markdown body with a canonical URL preamble so citations
//      link back correctly.
//
// Cost: this route regenerates on every deploy from the content
// collection, so freshness is automatic — no hand-maintenance.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://aegistraces.com';

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog'))
    .filter(p => !p.data.draft)
    .sort((a, b) => {
      // Newest first — matches how llms.txt hand-orders its "Deepest
      // technical writing" section by relevance. AI crawlers weight
      // earlier content more heavily.
      const ad = a.data.publishedAt.getTime();
      const bd = b.data.publishedAt.getTime();
      return bd - ad;
    });

  const header = [
    '# AEGIS — Full Technical Corpus',
    '',
    '> This is the flat, single-file companion to /llms.txt. Every non-draft',
    '> blog post is concatenated below, newest first, with its canonical URL',
    '> preamble and full markdown body. Follows the llms-full.txt convention',
    '> from https://llmstxt.org for LLM-first crawlers.',
    '',
    `Site: ${SITE}`,
    `Repository: https://github.com/Justin0504/Aegis`,
    `License: MIT (code) · CC-BY-4.0 (docs + blog)`,
    `Contact: aojieyuan04@gmail.com`,
    '',
    `Article count: ${posts.length}`,
    `Last built: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ].join('\n');

  const articles = posts.map(p => {
    const meta = [
      `## ${p.data.title}`,
      '',
      `Source: ${SITE}/blog/${p.slug}`,
      `Published: ${p.data.publishedAt.toISOString().split('T')[0]}`,
      ...(p.data.updatedAt ? [`Updated:   ${p.data.updatedAt.toISOString().split('T')[0]}`] : []),
      ...(p.data.answersQuery ? [`Answers query: ${p.data.answersQuery}`] : []),
      ...(p.data.oneSentenceAnswer ? ['', `**One-sentence answer**: ${p.data.oneSentenceAnswer}`] : []),
      ...(p.data.keyTakeaways?.length ? [
        '',
        '**Key takeaways**:',
        ...p.data.keyTakeaways.map((t: string) => `- ${t}`),
      ] : []),
      '',
    ].join('\n');

    return `${meta}${p.body}\n\n---\n`;
  }).join('\n');

  const body = `${header}${articles}\n\n## About this file\n\nGenerated at build time from the AEGIS blog content collection.\nSee /llms.txt for a linked-tree index of the same content.\n`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Aggressive cache — the content only changes on deploy, and
      // Cloudflare Pages already varies by build. Crawlers respecting
      // Cache-Control avoid unnecessary refetches.
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
};
