/**
 * Instruction-provenance pack · indirect prompt injection.
 *
 * Every other pack in this directory matches on what a call *contains*.
 * This one matches on where its *authority* came from, which is the only
 * thing left once the call itself is unremarkable.
 *
 * WHY A CONTENT PACK CANNOT COVER THIS
 *
 * Measured against tool calls a live agent was actually manipulated into
 * emitting, the 22 shipped detection patterns fire on 0.4%. SQL injection
 * 0.0%, path traversal 0.0%, sensitive-file access 0.0%, prompt injection
 * 0.0%, shell injection 0.4%. A successful indirect injection does not
 * produce a hostile payload; it produces an ordinary call the agent was
 * talked into. `AmazonViewSavedPaymentMethods({})` carries no argument at
 * all. There is nothing for a pattern to match, and no amount of pattern
 * tuning changes that.
 *
 * WHAT THESE RULES ASSUME
 *
 * That the SDK reports context events, so the gateway knows which spans
 * of the agent's context came from the principal and which crossed the
 * trust boundary. Without that, `provenance.authorised_by` is `unknown`
 * and every rule here is inert by construction — they all require a
 * decided verdict. That is deliberate: a deployment that has not upgraded
 * its SDK sees no behaviour change rather than a wall of false blocks.
 *
 * WHY MOSTLY `pending` AND NOT `block`
 *
 * The underlying signal is strong but not a proof: AUC 0.991 against a
 * benign control in which legitimate calls also draw on tool output, and
 * 0.933 against an attacker who shapes the call to mimic the user's own
 * request. At those rates, blocking outright on provenance alone would
 * stop real work. The rules escalate to a human, except where the call is
 * both untrusted-authorised AND irreversible, where the asymmetry of
 * costs favours blocking.
 *
 * Reference: Debenedetti et al., "Defeating Prompt Injections by Design"
 * (CaMeL), SaTML 2026 — the capability/IFC formulation this approximates
 * at an interposition point rather than inside a rewritten interpreter.
 */

import { PolicyDsl } from '@agentguard/core-schema';

// The DSL compiles `matches` as new RegExp(source) with no flags, so an
// inline (?i) is a syntax error rather than a case-insensitivity request.
// Tool names are camelCase or snake_case, so the classes below cover both
// without needing the flag.

const dsl: PolicyDsl = {
  version: 1,
  rules: [
    {
      // The headline case. The call is better explained by what a tool
      // returned than by anything the principal asked for, and its effect
      // leaves the principal's account.
      name: 'provenance-untrusted-authority-on-exfil-sink',
      when: {
        all: [
          { 'provenance.authorised_by': 'untrusted' },
          {
            'tool.name': {
              matches:
                '[Ss][Ee][Nn][Dd]|[Ee]mail|[Pp]ost|[Uu]pload|[Ss]hare|[Tt]ransfer|[Pp]ay|[Pp]ublish|[Ff]orward|[Ee]xport',
            },
          },
        ],
      },
      then: {
        decision: 'block',
        reason:
          'Nothing the user asked for accounts for this call, and it moves data out of their account. Characteristic of indirect prompt injection.',
        tags: ['provenance', 'injection', 'exfil'],
      },
    },
    {
      // Destructive and irreversible. Same logic, different cost
      // asymmetry: a false block is an annoyance, a false allow is not
      // recoverable.
      name: 'provenance-untrusted-authority-on-destructive',
      when: {
        all: [
          { 'provenance.authorised_by': 'untrusted' },
          {
            'tool.name': {
              matches: '[Dd]elete|[Dd]rop|[Rr]emove|[Rr]evoke|[Tt]erminate|[Dd]estroy|[Pp]urge',
            },
          },
        ],
      },
      then: {
        decision: 'block',
        reason:
          'Irreversible action whose authority traces to untrusted content rather than to the user.',
        tags: ['provenance', 'injection', 'destructive'],
      },
    },
    {
      // The untrusted channel names the tool and the user does not. An
      // injection has to name its target; a principal rarely knows
      // internal tool names. Strong on its own, so it escalates even when
      // the margin has not tipped the verdict.
      name: 'provenance-tool-named-only-by-untrusted-source',
      when: {
        all: [
          { 'provenance.degraded': false },
          // a read the injection named is harmless until something acts on
          // it; the act is held by the rules below (see isReadOnlyTool)
          { 'tool.read_only': false },
          { 'provenance.tool_named_in_untrusted': { '>': 0.5 } },
          { 'provenance.user_licence': { '<': 0.2 } },
        ],
      },
      then: {
        decision: 'pending',
        reason:
          'The tool being called is named in untrusted content and not by the user.',
        tags: ['provenance', 'injection'],
      },
    },
    {
      // The general case, escalated rather than blocked: the authority is
      // untrusted but the action is not obviously harmful.
      name: 'provenance-untrusted-authority-review',
      // Acting calls only. A lookup whose arguments came from an earlier
      // tool result is how multi-step work looks; holding it held 671
      // ordinary reads in 97 clean AgentDojo tasks.
      when: { all: [{ 'provenance.authorised_by': 'untrusted' }, { 'tool.read_only': false }] },
      then: {
        decision: 'pending',
        reason:
          'This call is better explained by tool output than by the user request it is supposedly serving.',
        tags: ['provenance', 'injection'],
      },
    },
    {
      // A sink the user did not ask for, where the margin is ambiguous
      // rather than decided. Weakest rule in the pack; present because
      // the measured evasion (echoing the user's vocabulary into a
      // free-text argument) lands exactly here, dragging a genuine attack
      // from `untrusted` into `unclear`.
      name: 'provenance-unclear-authority-on-sink',
      when: {
        all: [
          { 'provenance.authorised_by': 'unclear' },
          { 'provenance.user_licence': { '<': 0.15 } },
          {
            'tool.name': {
              matches: '[Ss][Ee][Nn][Dd]|[Ee]mail|[Pp]ost|[Uu]pload|[Ss]hare|[Tt]ransfer|[Pp]ay',
            },
          },
        ],
      },
      then: {
        decision: 'pending',
        reason:
          'Outbound action with no clear authority from the user request. Possible provenance evasion.',
        tags: ['provenance', 'injection', 'evasion'],
      },
    },
  ],
};

export const instructionProvenancePack = {
  id: 'security-instruction-provenance',
  title: 'Instruction provenance — indirect prompt injection',
  description:
    'Blocks or escalates tool calls whose authority traces to untrusted content rather than to the user. Covers the attack class that payload inspection misses: on real agent-emitted attacks the pattern layer fires on 0.4%, because a successful injection produces a syntactically ordinary call.',
  citation:
    'Debenedetti et al., Defeating Prompt Injections by Design (CaMeL), SaTML 2026; OWASP LLM01 Prompt Injection',
  requires: ['sdk-context-events'],
  dsl,
} as const;
