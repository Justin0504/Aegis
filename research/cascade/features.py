"""Feature encoder for L2 (behavioral) layer.

Mirrors packages/gateway-mcp/src/services/feature-encoder.ts so the Python
research code and the TS production code use the same feature space. Any
divergence between them is a bug.

Base features (numeric, fixed-dim, 15):
    0  arg_count
    1  total_arg_chars
    2  max_string_depth
    3  url_count
    4  ip_literal_count
    5  digit_ratio
    6  uppercase_ratio
    7  punct_ratio
    8  json_depth
    9  has_path_separator (0/1)
   10  has_curly_braces (0/1)
   11  shannon_entropy (bits/char)
   12  longest_run_same_char
   13  base64_like_score   (heuristic 0..1)
   14  hex_like_score      (heuristic 0..1)

Taint-augmented features (add 5, produced by encode_with_taint):
   15  taint_untrusted_frac       fraction of args labeled untrusted
   16  taint_source_entropy       Shannon entropy over per-arg source_ids
   17  taint_max_hop_norm         max hop_distance / 10, clipped to [0,1]
   18  taint_sink_untrusted       1.0 iff is_sink AND any untrusted arg
   19  taint_cross_source_count   count of distinct source_ids across args

Rationale: IPIGuard (EMNLP 2025 oral) shows parameter-level taint drops
ASR from 4.43% → 0.69%. The 15-dim tabular encoder alone can't see
provenance; these 5 features let a tree/sequence model learn "sensitive
sink + untrusted parameter = block" without a brittle hard-coded rule.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any

import numpy as np

from benchmark.schema import ToolCall

_URL_RE = re.compile(r"https?://[^\s'\"]+", re.IGNORECASE)
_IP_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]{16,}={0,2}$")
_HEX_RE = re.compile(r"^[0-9a-fA-F]{16,}$")


def _shannon(s: str) -> float:
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    n = len(s)
    return -sum((f / n) * math.log2(f / n) for f in freq.values())


def _longest_run(s: str) -> int:
    best = cur = 0
    prev = ""
    for c in s:
        if c == prev:
            cur += 1
        else:
            cur = 1
        prev = c
        best = max(best, cur)
    return best


def _walk(obj: Any, depth: int = 0) -> tuple[list[str], int]:
    """Collect string leaves and the maximum nesting depth."""
    strings: list[str] = []
    max_d = depth
    if isinstance(obj, str):
        strings.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            s, d = _walk(v, depth + 1)
            strings.extend(s)
            max_d = max(max_d, d)
    elif isinstance(obj, list):
        for v in obj:
            s, d = _walk(v, depth + 1)
            strings.extend(s)
            max_d = max(max_d, d)
    return strings, max_d


BASE_FEATURE_NAMES: tuple[str, ...] = (
    "arg_count", "total_arg_chars", "max_string_depth",
    "url_count", "ip_literal_count",
    "digit_ratio", "uppercase_ratio", "punct_ratio",
    "json_depth", "has_path_separator", "has_curly_braces",
    "shannon_entropy", "longest_run_same_char",
    "base64_like_score", "hex_like_score",
)

TAINT_FEATURE_NAMES: tuple[str, ...] = (
    "taint_untrusted_frac",
    "taint_source_entropy",
    "taint_max_hop_norm",
    "taint_sink_untrusted",
    "taint_cross_source_count",
)


@dataclass
class ToolCallFeatures:
    vector: np.ndarray
    # Populated at construction time; defaults to the 15-dim base names
    # so existing callers (encode()) don't need to change.
    names: tuple[str, ...] = BASE_FEATURE_NAMES


@dataclass
class TaintInfo:
    """Per-argument taint labels for one tool call.

    Produced by the gateway TaintService (or by a bench loader for
    research). Any missing field is treated as "unknown" — taint
    features silently degrade to 0 rather than raising.

    Fields:
        trust_labels: arg_name -> {"trusted", "untrusted", "unknown"}
        source_ids:   arg_name -> str  (opaque provenance id, e.g. hash
                                        of the originating tool_call)
        hop_distance: arg_name -> int  (tool hops from source to here;
                                        0 = literal user input, 1 = one
                                        intermediate tool, etc.)
        is_sink: True when the tool being called is a sensitive sink
                 (payment, email send, file write, remote exec).
    """
    trust_labels: dict[str, str] | None = None
    source_ids:   dict[str, str] | None = None
    hop_distance: dict[str, int] | None = None
    is_sink:      bool = False


def _base_vector(call: ToolCall) -> tuple[np.ndarray, int, list[str], str]:
    """Compute the 15-dim base vector plus a few intermediates the taint
    features need (strings, blob). Split out so encode() and
    encode_with_taint() share exactly one implementation."""
    args = call.arguments or {}
    strings, json_depth = _walk(args)
    blob = "".join(strings)
    n = max(1, len(blob))

    digits = sum(c.isdigit() for c in blob)
    uppers = sum(c.isupper() for c in blob)
    punct = sum(not c.isalnum() and not c.isspace() for c in blob)

    base64_score = sum(1 for s in strings if _BASE64_RE.match(s)) / max(1, len(strings))
    hex_score = sum(1 for s in strings if _HEX_RE.match(s)) / max(1, len(strings))

    vec = np.array([
        float(len(args)),
        float(len(blob)),
        float(json_depth),
        float(len(_URL_RE.findall(blob))),
        float(len(_IP_RE.findall(blob))),
        digits / n,
        uppers / n,
        punct / n,
        float(json_depth),
        1.0 if any(("/" in s or "\\" in s) for s in strings) else 0.0,
        1.0 if "{" in blob or "}" in blob else 0.0,
        _shannon(blob),
        float(_longest_run(blob)),
        base64_score,
        hex_score,
    ], dtype=np.float64)
    return vec, len(args), strings, blob


def _taint_vector(args: dict, taint: TaintInfo | None) -> np.ndarray:
    """Compute the 5-dim taint block from a TaintInfo (all-zero when
    taint is None or lacks fields)."""
    z = np.zeros(5, dtype=np.float64)
    if taint is None or not args:
        return z
    arg_names = list(args.keys())
    n = max(1, len(arg_names))

    trust = taint.trust_labels or {}
    sources = taint.source_ids or {}
    hops = taint.hop_distance or {}

    # 15 taint_untrusted_frac
    untrusted = sum(1 for a in arg_names if trust.get(a) == "untrusted")
    z[0] = untrusted / n

    # 16 taint_source_entropy — Shannon entropy over source_ids
    src_vals = [sources[a] for a in arg_names if a in sources]
    if src_vals:
        freq: dict[str, int] = {}
        for s in src_vals:
            freq[s] = freq.get(s, 0) + 1
        m = len(src_vals)
        z[1] = -sum((c / m) * math.log2(c / m) for c in freq.values())

    # 17 taint_max_hop_norm — max hops / 10, clipped
    if hops:
        z[2] = min(1.0, max(hops.values()) / 10.0)

    # 18 taint_sink_untrusted — sink AND any untrusted
    z[3] = 1.0 if (taint.is_sink and untrusted > 0) else 0.0

    # 19 taint_cross_source_count — number of distinct source ids
    z[4] = float(len(set(src_vals)))
    return z


def encode(call: ToolCall) -> ToolCallFeatures:
    """Base 15-dim encoding. Backward-compatible entry point — existing
    IForest / XGBoost models trained against this shape are unaffected."""
    vec, _, _, _ = _base_vector(call)
    return ToolCallFeatures(vector=vec, names=BASE_FEATURE_NAMES)


def encode_with_taint(
    call: ToolCall,
    taint: TaintInfo | None = None,
) -> ToolCallFeatures:
    """20-dim encoding: 15 base features + 5 taint features.

    When `taint` is None, the taint block is all zeros — safe for
    inference against a model trained on partial taint coverage.
    A model retrained on this 20-dim shape can learn the interaction
    ('sensitive sink' × 'untrusted argument' → block) that the base
    features can't see.
    """
    base, _, _, _ = _base_vector(call)
    args = call.arguments or {}
    tvec = _taint_vector(args, taint)
    vec = np.concatenate([base, tvec], axis=0)
    return ToolCallFeatures(
        vector=vec,
        names=BASE_FEATURE_NAMES + TAINT_FEATURE_NAMES,
    )
