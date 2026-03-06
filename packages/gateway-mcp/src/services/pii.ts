/**
 * PII auto-detection and redaction.
 * Scans string values in trace data and replaces detected PII with [REDACTED:TYPE].
 */

interface PiiPattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: PiiPattern[] = [
  // Email addresses
  { type: 'EMAIL',       regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // Phone numbers (US/intl)
  { type: 'PHONE',       regex: /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  // SSN (US)
  { type: 'SSN',         regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card numbers (13-16 digits, optionally space/dash separated)
  { type: 'CREDIT_CARD', regex: /\b(?:\d[ -]?){13,16}\b/g },
  // API keys / secrets (common patterns: sk-, pk-, bearer tokens, hex 32+)
  { type: 'API_KEY',     regex: /\b(sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,}(?=["'\s]|$))/g },
  // IPv4 addresses (private ranges often signal internal data)
  { type: 'IP_ADDRESS',  regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export interface RedactionResult {
  text: string;
  count: number;
  types: string[];
}

export function redactPii(text: string): RedactionResult {
  if (!text || typeof text !== 'string') return { text, count: 0, types: [] };

  let result = text;
  let count = 0;
  const typeSet = new Set<string>();

  for (const { type, regex } of PATTERNS) {
    const matches = result.match(regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      typeSet.add(type);
      result = result.replace(regex, `[REDACTED:${type}]`);
    }
    regex.lastIndex = 0; // reset stateful regex
  }

  return { text: result, count, types: Array.from(typeSet) };
}

/** Recursively redact all string values in a JSON-serializable object. */
export function redactObjectPii(obj: any): { redacted: any; count: number; types: string[] } {
  let totalCount = 0;
  const allTypes = new Set<string>();

  function walk(val: any): any {
    if (typeof val === 'string') {
      const { text, count, types } = redactPii(val);
      totalCount += count;
      types.forEach(t => allTypes.add(t));
      return text;
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) out[k] = walk(v);
      return out;
    }
    return val;
  }

  return { redacted: walk(obj), count: totalCount, types: Array.from(allTypes) };
}
