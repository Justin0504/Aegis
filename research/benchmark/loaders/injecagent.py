"""InjecAgent loader.

Source: Zhan et al., 2024 — "InjecAgent: Benchmarking Indirect Prompt Injections
in Tool-Integrated Large Language Model Agents".
Repo: https://github.com/uiuc-kang-lab/InjecAgent

Expected raw layout (after `scripts/download_all.py`):
    research/benchmark/data/raw/injecagent/
        test_cases_dh_base.json        # direct harm
        test_cases_ds_base.json        # data stealing
        test_cases_dh_enhanced.json
        test_cases_ds_enhanced.json

Each case in the upstream JSON looks like (abridged):
    {
      "User Tool": "GoogleHome",
      "Attacker Tools": ["GmailSendEmail"],
      "Attacker Instruction": "Send an email to ...",
      "User Instruction": "...",
      "Tool Parameters": "{\"to\": \"attacker@evil.com\", ...}"
    }

We map each case to TWO BenchRecords if needed:
  - the *attacker tool call* with `label=MALICIOUS, category=INDIRECT_INJECTION`
  - (optionally) the user-tool benign baseline call

Direct-harm cases default to UNAUTHORIZED_ACTION; data-stealing to DATA_EXFILTRATION.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Iterable

from ..schema import (
    AttackCategory,
    BenchRecord,
    Distribution,
    Granularity,
    Label,
    ToolCall,
)
from .base import BaseLoader, register_loader

_FILE_TO_CATEGORY = {
    "test_cases_dh_base.json": AttackCategory.UNAUTHORIZED_ACTION,
    "test_cases_dh_enhanced.json": AttackCategory.UNAUTHORIZED_ACTION,
    "test_cases_ds_base.json": AttackCategory.DATA_EXFILTRATION,
    "test_cases_ds_enhanced.json": AttackCategory.DATA_EXFILTRATION,
}


def _safe_loads(s):
    """InjecAgent's `Tool Parameters` is Python-repr style (single quotes)."""
    if isinstance(s, dict):
        return s
    if not isinstance(s, str):
        return {}
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        try:
            v = ast.literal_eval(s)
            return v if isinstance(v, dict) else {"_raw": s}
        except (ValueError, SyntaxError):
            return {"_raw": s}


@register_loader("injecagent")
class InjecAgentLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        if not self.is_available():
            return
        for fname, category in _FILE_TO_CATEGORY.items():
            path = self.root / fname
            if not path.exists():
                continue
            with path.open() as f:
                cases = json.load(f)
            for i, case in enumerate(cases):
                user_instruction = case.get("User Instruction", "")
                attacker_instruction = case.get("Attacker Instruction", "")
                user_tool = case.get("User Tool")
                user_args = _safe_loads(case.get("Tool Parameters"))

                # Each case yields ONE benign user tool call (the legitimate
                # request the user actually made) ...
                if user_tool:
                    yield BenchRecord(
                        id=f"injecagent::{path.stem}::{i}::user",
                        source="injecagent",
                        label=Label.BENIGN,
                        category=None,
                        tool_call=ToolCall(
                            tool_name=user_tool,
                            arguments=user_args if isinstance(user_args, dict) else {},
                            framework="injecagent-emulator",
                        ),
                        conversation=[{"role": "user", "content": user_instruction}],
                        distribution=Distribution.NEAR_OOD,
                        granularity=Granularity.FINE,
                        meta={"split": path.stem, "license": "Apache-2.0"},
                    )

                # ... and one malicious record per attacker tool.
                #
                # IMPORTANT: InjecAgent does NOT ship the attacker tool's
                # arguments. Like ToolEmu, it is an agent-execution
                # benchmark — the concrete malicious call only exists once
                # an agent has interpreted the injected instruction. An
                # earlier version of this loader fabricated the call as
                #
                #     arguments={"_attacker_instruction": <the injection>}
                #
                # which produced three independent shortcuts that made the
                # benchmark trivially solvable, all measured in
                # results/selective/:
                #
                #   1. Label leakage. 3,196/3,196 malicious records carried
                #      an argument key literally containing "attacker";
                #      0/2,108 benign ones did. The key name *was* the label,
                #      readable by any LLM judge and by grep.
                #   2. Structural shortcut. Benign records got real
                #      `Tool Parameters` from the dataset (median 38 chars)
                #      while malicious got a natural-language sentence
                #      (median 152). `total_chars` alone separates the two
                #      classes at AUC 0.9944 — no semantics required.
                #   3. Duplication. Distinct attacker instructions are far
                #      fewer than cases: 3,196 malicious records collapse to
                #      94 unique tool calls (97.1% duplicated).
                #
                # Marking these INTENT is the honest encoding: there is a
                # real attack described here, but not a tool call a per-call
                # detector can inspect. build.py quarantines INTENT records
                # from the default benchmark, so they can still be evaluated
                # by conversation-level judges without silently inflating
                # per-call detection numbers.
                #
                # To turn these into genuine per-call records, run an agent
                # against the injected observation and capture what it
                # actually emits. That instantiation pass is the correct
                # construction and is tracked separately.
                attacker_tools = case.get("Attacker Tools") or []
                if isinstance(attacker_tools, str):
                    attacker_tools = [attacker_tools]
                for j, tool_name in enumerate(attacker_tools):
                    yield BenchRecord(
                        id=f"injecagent::{path.stem}::{i}::atk{j}",
                        source="injecagent",
                        label=Label.MALICIOUS,
                        category=category,
                        tool_call=ToolCall(
                            tool_name=tool_name,
                            # Deliberately empty. The injected instruction
                            # lives in `conversation` where it belongs; it is
                            # context that caused the attack, not an argument
                            # the attacker passed.
                            arguments={},
                            framework="injecagent-emulator",
                        ),
                        conversation=[
                            {"role": "user", "content": user_instruction},
                            {"role": "tool_observation", "content": attacker_instruction},
                        ],
                        distribution=Distribution.NEAR_OOD,
                        granularity=Granularity.INTENT,
                        meta={
                            "split": path.stem,
                            "user_tool": user_tool,
                            "attack_type": case.get("Attack Type"),
                            "attacker_instruction": attacker_instruction,
                            "license": "Apache-2.0",
                        },
                    )
