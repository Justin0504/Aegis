"""Instruction provenance — who authorised this call, not where its data came from.

WHY THIS EXISTS

The five taint features in features.py answer "where did the argument
*values* come from". Measured honestly (selective/taint_eval.py, against
a two-step benign arm where legitimate calls also carry tool-derived
arguments) they reach AUC 0.7374 versus 0.6866 for content features —
a difference inside the cross-validation spread at n=237/169.

That is the expected result, and it localises the problem. In both
classes data flows from a tool response into a call. Data provenance
cannot tell them apart because on that axis they are the same. What
differs is the *instruction*: in the attack arm the imperative driving
the call arrived through the tool channel; in the benign arm it came
from the user and only the data came through the tool.

So the question a gateway has to answer is not "is this argument
tainted" but "which turn authorised this call, and was that turn
attacker-controlled".

THE FEATURES

Six, all computable in under a millisecond with no model call:

    user_licence        how much of the call is accounted for by the
                        user's own request
    obs_licence         how much is accounted for by untrusted tool
                        output
    authority_margin    obs_licence - user_licence. The headline. A call
                        the user asked for scores negative; a call only
                        the tool output asked for scores positive.
    tool_named_in_obs   the untrusted channel names the tool being
                        called and the user does not. An injection has
                        to name its target; a user rarely knows internal
                        tool names.
    imperative_density  fraction of untrusted sentences that are
                        directives
    directive_to_agent  untrusted text addresses the assistant in the
                        second person ("you should", "your task is")

A NECESSARY WARNING ABOUT THE LAST TWO

`imperative_density` and `directive_to_agent` are *definitional*. An
indirect prompt injection simply is an instruction in a data channel, so
a feature that detects instructions in data channels detecting injection
is close to tautological, and it will look excellent on any corpus whose
benign tool output was written to be pure data.

It is not, however, sound. Real tool output carries imperative text
constantly and legitimately: an email body that says "please forward
this to accounting", a ticket that says "escalate if unresolved by
Friday", documentation that says "call refresh() first". A detector
keyed on directives-in-data fires on all of it.

We therefore report the two families separately throughout, and treat
only the first four features — which compare the call against the user's
stated task rather than pattern-matching the channel — as carrying a
claim. Validating the definitional pair requires a benign arm whose tool
observations contain genuine assistant-directed imperatives that the
agent correctly declined to act on. That arm needs agent rollouts to
establish the label rather than assert it; the protocol is written down
in selective/provenance_eval.py and it has not been run.

WHAT A DEPLOYED GATEWAY HAS THAT THIS DOES NOT

Here the channels are reconstructed from a transcript. In-process the
gateway knows them exactly: it mediates every tool return, so it can
attribute each span of context to the turn that produced it and mark
the ones that arrived from outside the trust boundary. These features
are the offline approximation of that, deliberately simple, so the
result reflects the *abstraction* rather than the cleverness of a
particular attribution heuristic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from .features import ToolCall

PROVENANCE_FEATURE_NAMES: tuple[str, ...] = (
    "prov_user_licence",
    "prov_obs_licence",
    "prov_authority_margin",
    "prov_tool_named_in_obs",
    "prov_imperative_density",
    "prov_directive_to_agent",
)

# The four that compare the call against the user's task. These carry the
# claim; see the module docstring.
GROUNDED_FEATURE_NAMES: tuple[str, ...] = PROVENANCE_FEATURE_NAMES[:4]
# The two that detect "an instruction appears in a data channel", which is
# the definition of the attack and so cannot corroborate itself.
DEFINITIONAL_FEATURE_NAMES: tuple[str, ...] = PROVENANCE_FEATURE_NAMES[4:]

_WORD_RE = re.compile(r"[a-z0-9]+")
_CAMEL_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+")
_SENT_RE = re.compile(r"[.!?\n]+")

# Second-person framing aimed at an assistant. Deliberately narrow: these
# are phrases that address a reader who is expected to act, which is what
# separates "you must call X" from prose that merely contains the word you.
_AGENT_ADDRESS = (
    "you must", "you should", "you need to", "you have to", "you are required",
    "your task", "you are an", "as an assistant", "as the assistant",
    "ignore the", "ignore all", "ignore previous", "disregard",
    "do not tell", "without informing", "before you", "first you",
    "please note that you", "system:", "instruction:",
)

# Verbs that begin a directive. An imperative sentence in English usually
# opens with a bare verb, which is cheap to spot and does not require a
# parser.
_IMPERATIVE_VERBS = frozenset((
    "send", "email", "forward", "post", "share", "transfer", "pay", "delete",
    "remove", "add", "create", "update", "set", "call", "invoke", "use",
    "run", "execute", "fetch", "get", "retrieve", "read", "write", "upload",
    "download", "grant", "revoke", "schedule", "book", "cancel", "confirm",
    "notify", "inform", "reply", "respond", "click", "visit", "navigate",
    "please", "make", "ensure", "remember", "note", "check", "verify",
    "ignore", "disregard", "stop", "start", "continue", "proceed",
))


@dataclass
class CallContext:
    """The channels a gateway can distinguish at call time.

    user_text   everything the principal typed. Trusted: this is the
                authority the agent is acting under.
    obs_text    everything that entered context from outside the trust
                boundary — tool returns, retrieved documents, web pages.
    prior_calls tool names the agent already called in this session,
                used to tell a genuine multi-step plan from a call that
                appears only after untrusted text arrived.
    """
    user_text: str = ""
    obs_text: str = ""
    prior_calls: list[str] = field(default_factory=list)


def _words(text: str) -> set[str]:
    return set(_WORD_RE.findall((text or "").lower()))


def _split_identifier(name: str) -> set[str]:
    """GmailSendEmail -> {gmail, send, email}. Tool names are the one place
    where the call and the prose describing it share vocabulary."""
    return {p.lower() for p in _CAMEL_RE.findall(name or "") if len(p) > 1}


def _call_tokens(call: ToolCall) -> set[str]:
    """Everything about the call that could plausibly appear in prose:
    the tool name split into words, the argument keys, and the argument
    values. Values matter — an injection that dictates a recipient
    address puts that address in both the observation and the call."""
    toks = _split_identifier(call.tool_name)
    for k, v in (call.arguments or {}).items():
        toks |= _split_identifier(k) | _words(str(k))
        toks |= _words(str(v))
    return {t for t in toks if len(t) > 2}


def _licence(call_toks: set[str], text: str) -> float:
    """Fraction of the call's vocabulary this channel accounts for.

    Asymmetric on purpose: we ask how much of the CALL the channel
    explains, not how similar the two are. A long user request that
    happens to share stopwords with the call should not score highly,
    and a short observation that names the exact tool and recipient
    should.
    """
    if not call_toks:
        return 0.0
    return len(call_toks & _words(text)) / len(call_toks)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.split(text or "") if len(s.strip()) > 3]


def _is_imperative(sentence: str) -> bool:
    toks = _WORD_RE.findall(sentence.lower())
    if not toks:
        return False
    # A directive opens with a bare verb, or reaches one immediately after
    # a discourse marker ("then send ...", "now call ...").
    if toks[0] in _IMPERATIVE_VERBS:
        return True
    if toks[0] in ("then", "now", "next", "also", "first", "finally") \
            and len(toks) > 1 and toks[1] in _IMPERATIVE_VERBS:
        return True
    return False


def encode_provenance(call: ToolCall, ctx: CallContext | None) -> np.ndarray:
    """Six instruction-provenance features. All-zero when no context is
    available, so a model trained on this block degrades to the base
    features rather than raising."""
    z = np.zeros(6, dtype=np.float64)
    if ctx is None:
        return z

    call_toks = _call_tokens(call)
    user_lic = _licence(call_toks, ctx.user_text)
    obs_lic = _licence(call_toks, ctx.obs_text)

    z[0] = user_lic
    z[1] = obs_lic
    z[2] = obs_lic - user_lic

    # The tool is named in untrusted text but not by the principal.
    name_toks = _split_identifier(call.tool_name)
    if name_toks:
        in_obs = len(name_toks & _words(ctx.obs_text)) / len(name_toks)
        in_user = len(name_toks & _words(ctx.user_text)) / len(name_toks)
        z[3] = max(0.0, in_obs - in_user)

    sents = _sentences(ctx.obs_text)
    if sents:
        z[4] = sum(_is_imperative(s) for s in sents) / len(sents)
    low = (ctx.obs_text or "").lower()
    z[5] = 1.0 if any(p in low for p in _AGENT_ADDRESS) else 0.0
    return z


def authority_gap(call: ToolCall, ctx: CallContext | None) -> float:
    """The single number this module exists to produce.

    > 0 means the untrusted channel accounts for more of this call than
    the principal's own request does — the call is being authorised by
    something the principal did not say. This is the quantity the taint
    features cannot express, and it is defined without reference to what
    the call contains.
    """
    if ctx is None:
        return 0.0
    toks = _call_tokens(call)
    return _licence(toks, ctx.obs_text) - _licence(toks, ctx.user_text)
