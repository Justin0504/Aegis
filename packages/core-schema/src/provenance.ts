/**
 * Instruction provenance — which turn authorised a tool call.
 *
 * WHY THIS EXISTS
 *
 * The policy DSL can only see the call. It can say "block when the SQL
 * argument matches this pattern", and it cannot say "block when nothing
 * the user asked for accounts for this call". Measured against tool calls
 * a live agent was actually manipulated into emitting, the first kind of
 * rule fires on 0.4% of attacks, because a successful indirect injection
 * produces a syntactically ordinary call --- AmazonViewSavedPaymentMethods({})
 * carries no argument at all. There is nothing in the call string to match.
 *
 * What separates those calls from legitimate ones is where their authority
 * came from. This module computes that, so a policy can express it.
 *
 * DATA PROVENANCE IS NOT THIS
 *
 * Taint tracking answers "where did this argument's value come from".
 * Measured against a benign control in which legitimate calls also draw
 * their arguments from tool output --- the control that makes the
 * comparison honest --- taint features reach AUC 0.737 against 0.687 for
 * content features, spreads overlapping. Both classes carry tool-derived
 * data, so data provenance cannot separate them.
 *
 * Instruction provenance asks a different question: not where the value
 * came from, but which turn *authorised* the call. The four grounded
 * features below reach AUC 0.991 on the same corpus and hold at 0.933
 * against an attacker who deliberately shapes the call to mimic the
 * user's own request. The definitions here follow the Python that produced
 * those numbers (research/cascade/provenance.py) --- a production path
 * that computes something subtly different is not entitled to the
 * measurement --- with one documented divergence in channel tokenisation,
 * noted at `words()` below. Quote the Python for the AUCs, not this.
 *
 * RELATION TO PUBLISHED WORK
 *
 * The thesis that authority should follow the source of an instruction is
 * not ours. CaMeL (Debenedetti et al., SaTML 2026) enforces it with
 * capability-based information-flow control inside a custom interpreter,
 * and IntentCap (Zheng et al., AgenticOS 2026) scopes capabilities to
 * task intent across context sources. Both require the agent to be built
 * around them. The contribution here is narrower and deployable: the same
 * question answered at an interposition point, for an agent nobody
 * rewrote, in under a millisecond and with no model call.
 *
 * WHAT IT IS NOT
 *
 * Not a classifier, and not sufficient alone. It raises the price of an
 * attack from "phrase an instruction" to "phrase an instruction that also
 * looks like the user's own request" --- a price that scales with how far
 * the attacker's goal is from the principal's, which is what makes an
 * attack worth running in the first place. Policies should treat it as
 * one input to a decision, not as the decision.
 */

import { z } from 'zod';

/** Where a span of agent context came from. */
export const ContextChannelSchema = z.enum([
  /** The principal typed it. This is the authority the agent acts under. */
  'user',
  /** It arrived from outside the trust boundary: a tool return, a
   *  retrieved document, a web page. Never an authority. */
  'untrusted',
  /** The model wrote it. Not an authority either --- a model repeating an
   *  injected instruction does not launder it. */
  'model',
]);
export type ContextChannel = z.infer<typeof ContextChannelSchema>;

export const ContextEventSchema = z.object({
  /** Monotonic within a session; used only for ordering and debugging. */
  seq: z.number().int().nonnegative(),
  channel: ContextChannelSchema,
  /** For `untrusted`, the tool whose return this was. */
  source: z.string().max(200).optional(),
  /** The text as it entered the model's context. */
  text: z.string(),
});
export type ContextEvent = z.infer<typeof ContextEventSchema>;

export const AuthorityVerdictSchema = z.enum([
  /** The principal's own request accounts for this call. */
  'user',
  /** Only untrusted content accounts for it. */
  'untrusted',
  /** Both channels account for it comparably, or neither does. */
  'unclear',
  /** No context was reported, so the question was not asked. */
  'unknown',
]);
export type AuthorityVerdict = z.infer<typeof AuthorityVerdictSchema>;

export interface AuthorityReport {
  /** Fraction of the call's vocabulary the principal's turns account for. */
  userLicence: number;
  /** Same, for everything that crossed the trust boundary. */
  untrustedLicence: number;
  /** untrustedLicence - userLicence. Positive means the call is better
   *  explained by what a tool said than by what the user asked for. */
  authorityMargin: number;
  /** Untrusted text names the tool being called and the user does not.
   *  An injection has to name its target; a user rarely knows internal
   *  tool names. */
  toolNamedInUntrusted: number;
  /** Argument-level authority: distinctive argument values (addresses,
   *  URLs, account numbers, paths, phone numbers) that appear in untrusted
   *  text and never in the user's. A same-tool hijack keeps the user's tool
   *  and swaps the destination; the tool-level licence cannot see that,
   *  this can. */
  untrustedOnlyValues: string[];
  verdict: AuthorityVerdict;
  /** True when no user turn was ever reported for this session. Policies
   *  must not read a margin of 0 as "safe" in that case. */
  degraded: boolean;
}

export interface CallEvidence {
  user_request: string;
  untrusted_only_values: string[];
  excerpts: { source?: string; text: string; highlight?: string; truncated_before: boolean }[];
}

// A session's context can grow without bound; the ledger holds a window.
// 64 events and 256 KB per session is far more than the licence measure
// needs (it is a bag-of-tokens comparison) and bounds a long-running
// agent's memory.
const MAX_EVENTS = 64;
const MAX_TEXT_BYTES = 256 * 1024;

/**
 * Per-session record of what entered the agent's context and through
 * which channel.
 *
 * The gateway owns one of these per session. It is the only new state the
 * provenance layer needs, and it is what a deployed gateway can observe
 * that an offline evaluation has to reconstruct.
 */
export class ContextLedger {
  private events: ContextEvent[] = [];
  private bytes = 0;

  append(event: ContextEvent): void {
    const text = event.text ?? '';
    this.events.push({ ...event, text });
    this.bytes += Buffer.byteLength(text, 'utf8');
    while (this.events.length > MAX_EVENTS || this.bytes > MAX_TEXT_BYTES) {
      const dropped = this.events.shift();
      if (!dropped) break;
      this.bytes -= Buffer.byteLength(dropped.text, 'utf8');
    }
  }

  /** Everything the principal typed. */
  userText(): string {
    return this.textFor('user');
  }

  /** Everything that entered context from outside the trust boundary. */
  untrustedText(): string {
    return this.textFor('untrusted');
  }

  /** The most recent untrusted spans, newest last, within a character
   *  budget. For a reviewer (the alignment auditor) that has to judge a
   *  held call against what the agent actually read, not only against
   *  what it was asked. Returned as data; callers must present it as such. */
  recentUntrusted(maxChars = 6000): string[] {
    const out: string[] = [];
    let used = 0;
    for (let i = this.events.length - 1; i >= 0 && used < maxChars; i--) {
      const e = this.events[i];
      if (e.channel !== 'untrusted' || !e.text) continue;
      const t = e.text.slice(0, maxChars - used);
      out.unshift(t);
      used += t.length;
    }
    return out;
  }

  /** What a reviewer needs to decide a held call: the principal's latest
   *  request, and the tool output the call drew on — the passages that
   *  contain an argument value the user never gave, or failing that the
   *  most recent tool output. Bounded; text only, never instructions. */
  evidenceFor(args: Record<string, unknown> | null | undefined): CallEvidence {
    const users = this.events.filter((e) => e.channel === 'user' && e.text);
    const user_request = users.length ? users[users.length - 1].text.slice(0, 600) : '';
    const values = untrustedOnlyValues(args, this.userText(), this.untrustedText());
    const excerpts: CallEvidence['excerpts'] = [];
    const untrusted = this.events.filter((e) => e.channel === 'untrusted' && e.text);
    for (const e of [...untrusted].reverse()) {
      const low = e.text.toLowerCase();
      const hit = values.map((v) => v.toLowerCase().replace(/^https?:\/\//, '')).find((v) => low.includes(v));
      if (!hit) continue;
      const at = low.indexOf(hit);
      const from = Math.max(0, at - 160);
      excerpts.push({ source: e.source, text: e.text.slice(from, at + hit.length + 160), highlight: e.text.substr(at, hit.length), truncated_before: from > 0 });
      if (excerpts.length >= 3) break;
    }
    if (!excerpts.length && untrusted.length) {
      const e = untrusted[untrusted.length - 1];
      excerpts.push({ source: e.source, text: e.text.slice(0, 400), truncated_before: false });
    }
    return { user_request, untrusted_only_values: values, excerpts };
  }

  hasUserTurn(): boolean {
    return this.events.some((e) => e.channel === 'user');
  }

  size(): number {
    return this.events.length;
  }

  private textFor(channel: ContextChannel): string {
    return this.events
      .filter((e) => e.channel === channel)
      .map((e) => e.text)
      .join(' ');
  }
}

const WORD_RE = /[a-z0-9]+/g;
// GmailSendEmail -> gmail, send, email. Tool names are the one place where
// a call and the prose describing it share vocabulary.
const CAMEL_RE = /[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+/g;

/**
 * Tokenise a channel's text.
 *
 * Identifiers are split as well as lowercased, because an injection
 * routinely names its target tool literally --- "call
 * AmazonViewSavedPaymentMethods now" --- and a plain word split collapses
 * that to one token that matches nothing.
 *
 * This is a deliberate divergence from the Python the measurement was run
 * with (research/cascade/provenance.py), which splits identifiers on the
 * call side only. The corpus there carried injections phrased as prose, so
 * the gap never showed; in deployment it would. The change is additive and
 * applied to both channels, so a user who names a tool gets the same
 * credit an injection does, and the measured numbers are a lower bound on
 * what this computes rather than a description of it. Anything quoting
 * AUC 0.991 should quote the Python.
 */
function words(text: string): Set<string> {
  const lower = (text ?? '').toLowerCase();
  const out = new Set(lower.match(WORD_RE) ?? []);
  for (const ident of (text ?? '').match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? []) {
    for (const part of splitIdentifier(ident)) out.add(part);
  }
  return out;
}

function splitIdentifier(name: string): Set<string> {
  const parts = (name ?? '').match(CAMEL_RE) ?? [];
  return new Set(parts.map((p) => p.toLowerCase()).filter((p) => p.length > 1));
}

/**
 * Everything about the call that could plausibly appear in prose: the tool
 * name split into words, the argument keys, and the argument values.
 * Values matter --- an injection that dictates a recipient address puts
 * that address into both the untrusted text and the call.
 */
export function callTokens(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): Set<string> {
  const toks = splitIdentifier(toolName);
  for (const [k, v] of Object.entries(args ?? {})) {
    for (const t of splitIdentifier(k)) toks.add(t);
    for (const t of words(String(k))) toks.add(t);
    for (const t of words(typeof v === 'string' ? v : JSON.stringify(v) ?? '')) {
      toks.add(t);
    }
  }
  return new Set([...toks].filter((t) => t.length > 2));
}

/**
 * Fraction of the call's vocabulary this channel accounts for.
 *
 * Asymmetric on purpose: the question is how much of the CALL the channel
 * explains, not how similar the two texts are. That asymmetry is load
 * bearing --- an attacker who pads the untrusted channel with a copy of
 * the user's request moves this measure not at all, because the padding
 * does not add any of the call's vocabulary. Measured, that evasion took
 * the margin from +0.373 to +0.398, i.e. it cost the attacker nothing and
 * gained nothing.
 */
function licence(callToks: Set<string>, text: string): number {
  if (callToks.size === 0) return 0;
  const channel = words(text);
  let hit = 0;
  for (const t of callToks) if (channel.has(t)) hit += 1;
  return hit / callToks.size;
}

/** A margin this close to zero is noise, not a finding. */
const MARGIN_DEADBAND = 0.05;

// Values worth attributing: things that name a destination or an account.
// Ordinary words are left to the licence measure; numbers shorter than six
// digits (amounts, dates) are too common to attribute.
const VALUE_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,              // email address
  /https?:\/\/[^\s"'<>]+/g,                   // URL
  /\bwww\.[^\s"'<>]+/g,                       // scheme-less URL
  /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g,          // IBAN-shaped account
  /\b\d{6,}\b/g,                              // long account / card / id number
  /(?:\/[\w.-]+){2,}/g,                        // file path
  /\+?\d[\d -]{7,}\d/g,                       // phone number
];

function argumentValues(args: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 16 || v == null) return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === 'object') { Object.values(v as Record<string, unknown>).forEach(x => walk(x, depth + 1)); return; }
    const s = String(v);
    for (const re of VALUE_PATTERNS) {
      for (const m of s.matchAll(re)) {
        const val = m[0].replace(/^[ .,]+|[ .,]+$/g, '');
        if (val.length >= 5) out.add(val);
      }
    }
  };
  walk(args, 0);
  return out;
}

export function untrustedOnlyValues(
  args: Record<string, unknown> | null | undefined,
  userText: string,
  untrustedText: string,
): string[] {
  // Compared in a canonical form: an agent that copies "www.x.com" from a
  // page routinely writes "https://www.x.com/", and an exact match would
  // then find the value in neither channel (seen on AgentDojo: a phishing
  // link sent with its scheme added went through as authority-free).
  const user = canonicalText(userText);
  const untrusted = canonicalText(untrustedText);
  const seen = new Set<string>();
  // One destination can match two patterns (an IBAN's digit tail is also
  // phone-shaped); keep the longest so it counts once.
  const all = [...argumentValues(args)];
  const canon = all.map(canonicalValue);
  const maximal = all.filter((_, i) => !canon.some((c, j) => j !== i && c.length > canon[i].length && c.includes(canon[i])));
  return maximal.filter(v => {
    const lv = canonicalValue(v);
    if (!lv || seen.has(lv)) return false;
    seen.add(lv);
    return untrusted.includes(lv) && !user.includes(lv);
  });
}

function canonicalValue(v: string): string {
  return v.toLowerCase().replace(/^https?:\/\//, '').replace(/[\/.,;:)\]]+$/, '');
}

function canonicalText(t: string): string {
  return t.toLowerCase().replace(/https?:\/\//g, '');
}

export function assessAuthority(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  ledger: ContextLedger,
): AuthorityReport {
  const toks = callTokens(toolName, args);
  const userLicence = licence(toks, ledger.userText());
  const untrustedLicence = licence(toks, ledger.untrustedText());
  const authorityMargin = untrustedLicence - userLicence;

  const nameToks = splitIdentifier(toolName);
  let toolNamedInUntrusted = 0;
  if (nameToks.size > 0) {
    const inUntrusted = licence(nameToks, ledger.untrustedText());
    const inUser = licence(nameToks, ledger.userText());
    toolNamedInUntrusted = Math.max(0, inUntrusted - inUser);
  }

  // Fail-soft, deliberately. A gateway that is not being told about user
  // turns cannot answer this question, and reporting `untrusted` there
  // would block every call in every deployment that has not upgraded its
  // SDK. `unknown` is distinguishable, and the shipped policy pack does
  // not tighten on it --- see the note on `degraded`.
  const degraded = !ledger.hasUserTurn();
  const untrustedOnly = degraded ? [] : untrustedOnlyValues(args, ledger.userText(), ledger.untrustedText());
  let verdict: AuthorityVerdict;
  if (degraded) {
    verdict = 'unknown';
  } else if (authorityMargin > MARGIN_DEADBAND) {
    verdict = 'untrusted';
  } else if (authorityMargin < -MARGIN_DEADBAND) {
    verdict = 'user';
  } else {
    verdict = 'unclear';
  }

  return {
    userLicence,
    untrustedLicence,
    authorityMargin,
    toolNamedInUntrusted,
    untrustedOnlyValues: untrustedOnly,
    verdict,
    degraded,
  };
}

/**
 * The shape exposed to the policy DSL. Snake_case because DSL field paths
 * are written by humans in YAML alongside `classifier.category` and
 * `anomaly.score`.
 */
export interface ProvenanceDslFacts {
  // Index signature so this drops straight into the DSL context, whose
  // blocks are all open-shaped for forward compatibility.
  [k: string]: unknown;
  authorised_by: AuthorityVerdict;
  authority_margin: number;
  user_licence: number;
  untrusted_licence: number;
  tool_named_in_untrusted: number;
  /** How many destination-like argument values only untrusted text contains. */
  untrusted_only_values: number;
  degraded: boolean;
}

export function toDslFacts(report: AuthorityReport): ProvenanceDslFacts {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    authorised_by: report.verdict,
    authority_margin: round(report.authorityMargin),
    user_licence: round(report.userLicence),
    untrusted_licence: round(report.untrustedLicence),
    tool_named_in_untrusted: round(report.toolNamedInUntrusted),
    untrusted_only_values: report.untrustedOnlyValues.length,
    degraded: report.degraded,
  };
}
