"""Feature encoder for L2 (behavioral) layer.

Mirrors packages/gateway-mcp/src/services/feature-encoder.ts so the Python
research code and the TS production code use the same feature space. Any
divergence between them is a bug.

Features (numeric, fixed-dim):
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


@dataclass
class ToolCallFeatures:
    vector: np.ndarray
    names: tuple[str, ...] = (
        "arg_count", "total_arg_chars", "max_string_depth",
        "url_count", "ip_literal_count",
        "digit_ratio", "uppercase_ratio", "punct_ratio",
        "json_depth", "has_path_separator", "has_curly_braces",
        "shannon_entropy", "longest_run_same_char",
        "base64_like_score", "hex_like_score",
    )


def encode(call: ToolCall) -> ToolCallFeatures:
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
    return ToolCallFeatures(vector=vec)
