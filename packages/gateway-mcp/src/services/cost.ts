/**
 * Token cost calculator.
 * Prices in USD per 1M tokens (input / output).
 * Updated: 2025-Q1
 */

interface ModelPrice {
  input: number;   // $ per 1M input tokens
  output: number;  // $ per 1M output tokens
}

const PRICING: Record<string, ModelPrice> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  'claude-opus-4-5-20251101':       { input: 15.00, output: 75.00 },
  'claude-opus-4-6':                { input: 15.00, output: 75.00 },
  'claude-sonnet-4-5':              { input:  3.00, output: 15.00 },
  'claude-sonnet-4-6':              { input:  3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022':     { input:  3.00, output: 15.00 },
  'claude-3-5-sonnet-20240620':     { input:  3.00, output: 15.00 },
  'claude-haiku-4-5-20251001':      { input:  0.80, output:  4.00 },
  'claude-3-5-haiku-20241022':      { input:  0.80, output:  4.00 },
  'claude-3-haiku-20240307':        { input:  0.25, output:  1.25 },
  'claude-3-opus-20240229':         { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229':       { input:  3.00, output: 15.00 },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  'gpt-4o':                         { input:  5.00, output: 15.00 },
  'gpt-4o-2024-11-20':              { input:  2.50, output: 10.00 },
  'gpt-4o-mini':                    { input:  0.15, output:  0.60 },
  'gpt-4o-mini-2024-07-18':         { input:  0.15, output:  0.60 },
  'gpt-4-turbo':                    { input: 10.00, output: 30.00 },
  'gpt-4-turbo-2024-04-09':         { input: 10.00, output: 30.00 },
  'gpt-4':                          { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':                  { input:  0.50, output:  1.50 },
  'o1':                             { input: 15.00, output: 60.00 },
  'o1-mini':                        { input:  3.00, output: 12.00 },
  'o3-mini':                        { input:  1.10, output:  4.40 },
  // ── Gemini ─────────────────────────────────────────────────────────────────
  'gemini-1.5-pro':                 { input:  3.50, output: 10.50 },
  'gemini-1.5-flash':               { input:  0.075, output: 0.30 },
  'gemini-2.0-flash':               { input:  0.10, output:  0.40 },
};

/** Fuzzy match: prefix/substring lookup so 'claude-opus-4-6-...' resolves correctly. */
function resolvePrice(model: string): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  // Exact match first
  if (PRICING[m]) return PRICING[m];
  // Prefix match (longest wins)
  let best: [string, ModelPrice] | null = null;
  for (const [key, price] of Object.entries(PRICING)) {
    if (m.startsWith(key) || key.startsWith(m)) {
      if (!best || key.length > best[0].length) best = [key, price];
    }
  }
  return best ? best[1] : null;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const price = resolvePrice(model);
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input
       + (outputTokens / 1_000_000) * price.output;
}

export function getModelPricing(model: string): ModelPrice | null {
  return resolvePrice(model);
}

export const ALL_PRICING = PRICING;
