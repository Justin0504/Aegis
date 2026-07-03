/**
 * rehype-annotate — post-markdown-parse HAST transformer.
 *
 * Walks the article content and:
 *   1. Wraps first-occurrence acronyms in <abbr title="...">
 *      (screen readers + hover tooltips + GEO signal).
 *   2. Wraps numeric facts (percentages, x-out-of-y ratios) in
 *      <span class="fact"> so CSS + LLMs can spot the load-bearing
 *      number.
 *   3. Wraps first-occurrence glossary terms in
 *      <a class="dfn" href="/blog/glossary#slug"> so /blog/glossary
 *      becomes the canonical definition graph across the site.
 *
 * Rules:
 *   - Only the FIRST occurrence per article gets annotated (avoids
 *     annotation spam that hurts readability).
 *   - Never annotate inside <code>, <pre>, <a>, <h1..h6>, <abbr>,
 *     <script>, <style> — those are structural or already-linked.
 *   - Longest-match wins when patterns overlap (glossary phrase beats
 *     a substring acronym).
 */

const ABBRS = {
  'ECE':      'Expected Calibration Error',
  'IPI':      'Indirect Prompt Injection',
  'IPIGuard': 'IPIGuard — EMNLP 2025 oral, Zhou et al.',
  'ASR':      'Attack Success Rate',
  'PHI':      'Protected Health Information',
  'BAA':      'Business Associate Agreement',
  'HIPAA':    'Health Insurance Portability and Accountability Act',
  'PCI-DSS':  'Payment Card Industry Data Security Standard',
  'SOC 2':    'Service Organization Control 2 (AICPA)',
  'FATF':     'Financial Action Task Force',
  'VASP':     'Virtual Asset Service Provider',
  'DSL':      'Domain-Specific Language',
  'DLQ':      'Dead-Letter Queue',
  'LLM':      'Large Language Model',
  'SDK':      'Software Development Kit',
  'MCP':      'Model Context Protocol',
  'AICPA':    'American Institute of Certified Public Accountants',
  'SRAE':     'Sequence-aware Reconstruction Autoencoder',
  'ICLR':     'International Conference on Learning Representations',
  'EMNLP':    'Empirical Methods in Natural Language Processing',
  'AAAI':     'Association for the Advancement of Artificial Intelligence',
  'NeurIPS':  'Neural Information Processing Systems',
  'USDC':     'USD Coin (Circle stablecoin)',
  'JSON':     'JavaScript Object Notation',
  'API':      'Application Programming Interface',
  'HTTP':     'Hypertext Transfer Protocol',
  'SaaS':     'Software as a Service',
  'MIT':      'Massachusetts Institute of Technology (also refers to the MIT license)',
};

// Longest term first so multi-word phrases match before their prefixes.
const GLOSSARY = [
  ['parameter-level taint propagation', 'taint-propagation'],
  ['indirect prompt injection',          'indirect-prompt-injection'],
  ['behavioural anomaly detection',      'behavioural-anomaly'],
  ['transparency log',                   'transparency-log'],
  ['witness cosignature',                'witness-cosignature'],
  ['inclusion proof',                    'inclusion-proof'],
  ['consistency proof',                  'consistency-proof'],
  ['temperature scaling',                'temperature-scaling'],
  ['reliability diagram',                'reliability-diagram'],
  ['compensating action',                'compensating-action'],
  ['delegation-scoped observability',    'delegation-observability'],
  ['Three-Ring Architecture',            'three-ring'],
  ['Expected Calibration Error',         'ece'],
  ['Brier score',                        'brier-score'],
  ['agent runtime safety',               'agent-runtime-safety'],
  ['tool-call gateway',                  'tool-call-gateway'],
  ['agent firewall',                     'tool-call-gateway'],
  ['prompt injection',                   'prompt-injection'],
  ['taint propagation',                  'taint-propagation'],
  ['guard model',                        'guard-model'],
  ['LLM judge',                          'guard-model'],
  ['policy DSL',                         'policy-dsl'],
  ['kill switch',                        'kill-switch'],
  ['payload obfuscation',                'obfuscation'],
  ['data exfiltration',                  'data-exfiltration'],
  ['jailbreak',                          'jailbreak'],
  ['Merkle tree',                        'merkle-tree'],
  ['dead-letter queue',                  'dlq'],
  ['tool call',                          'tool-call'],
  ['FATF Travel Rule',                   'fatf-travel-rule'],
  ['Travel Rule',                        'fatf-travel-rule'],
  ['PCI-DSS',                            'pci-dss'],
  ['HIPAA',                              'hipaa'],
  ['SOC 2',                              'soc2'],
  ['saga',                               'saga'],
  ['DLQ',                                'dlq'],
];

const SKIP_TAGS = new Set([
  'code', 'pre', 'a', 'abbr', 'script', 'style',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// Percentages tolerate the ` %` typography (common in the AEGIS blog).
// Ratios: "4 of 5", "1 of 10", etc.
const PCT_RE   = /(\d+(?:\.\d+)?\s?%)/;
const RATIO_RE = /(\d+ of \d+)/;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAnnotations(text, doneAbbr, doneDfn) {
  const hits = [];

  // 1. Percentages — every occurrence gets .fact (they're all load-bearing)
  for (const re of [PCT_RE, RATIO_RE]) {
    const global = new RegExp(re.source, 'g');
    let m;
    while ((m = global.exec(text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length,
                   kind: 'fact', text: m[0], length: m[0].length });
    }
  }

  // 2. Glossary — first occurrence per slug per article. Longest phrase first.
  for (const [term, slug] of GLOSSARY) {
    if (doneDfn.has(slug)) continue;
    const re = new RegExp('\\b' + escapeRegex(term) + '\\b', 'i');
    const m = re.exec(text);
    if (m) {
      hits.push({ start: m.index, end: m.index + m[0].length,
                   kind: 'dfn', text: m[0], slug, length: m[0].length });
      // Mark used so the same slug isn't re-annotated later in this text
      doneDfn.add(slug);
    }
  }

  // 3. Acronyms — first occurrence per acronym per article
  for (const abbr of Object.keys(ABBRS)) {
    if (doneAbbr.has(abbr)) continue;
    const re = new RegExp('\\b' + escapeRegex(abbr) + '\\b');
    const m = re.exec(text);
    if (m) {
      hits.push({ start: m.index, end: m.index + abbr.length,
                   kind: 'abbr', text: abbr, title: ABBRS[abbr],
                   length: abbr.length });
      doneAbbr.add(abbr);
    }
  }

  if (hits.length === 0) return null;

  // Sort by start; when ties, longer match wins (dfn phrase over abbr letter).
  hits.sort((a, b) => a.start - b.start || b.length - a.length);
  const merged = [];
  for (const h of hits) {
    if (merged.length === 0 || h.start >= merged[merged.length - 1].end) {
      merged.push(h);
    }
    // Overlapping hit is dropped (already-committed one wins by sort order)
  }

  // Emit hast nodes
  const out = [];
  let cursor = 0;
  for (const h of merged) {
    if (h.start > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, h.start) });
    }
    if (h.kind === 'fact') {
      out.push({
        type: 'element', tagName: 'span',
        properties: { className: ['fact'] },
        children: [{ type: 'text', value: h.text }],
      });
    } else if (h.kind === 'abbr') {
      out.push({
        type: 'element', tagName: 'abbr',
        properties: { title: h.title },
        children: [{ type: 'text', value: h.text }],
      });
    } else if (h.kind === 'dfn') {
      out.push({
        type: 'element', tagName: 'a',
        properties: { className: ['dfn'], href: `/blog/glossary#${h.slug}` },
        children: [{ type: 'text', value: h.text }],
      });
    }
    cursor = h.end;
  }
  if (cursor < text.length) {
    out.push({ type: 'text', value: text.slice(cursor) });
  }
  return out;
}

function walk(node, doneAbbr, doneDfn) {
  if (!node || !node.children) return;
  if (node.type === 'element' && SKIP_TAGS.has(node.tagName)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'text') {
      const replacement = findAnnotations(child.value, doneAbbr, doneDfn);
      if (replacement) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
    } else {
      walk(child, doneAbbr, doneDfn);
    }
  }
}

export default function rehypeAnnotate() {
  return (tree) => {
    walk(tree, new Set(), new Set());
  };
}
