"""ToolEmu loader.

Source: Ruan et al., 2024 — "Identifying the Risks of LM Agents with an
LM-Emulated Sandbox". Repo: https://github.com/ryoungj/ToolEmu

ToolEmu ships ~144 hand-crafted red-team test cases under
    assets/all_cases.json
Each case has a `User Instruction` and a `Toolkits` list. The risky tool calls
are produced *during* execution by the emulator; for a static benchmark we use
the trajectories the authors released under
    assets/test_cases_with_trajectories.json (if present).

If only the case file is present, we emit one BenchRecord per case at the
*intent* level (no concrete tool_call). Such records carry tool_call.tool_name
= "<unknown>" and are skipped by content-only baselines but counted by
LLM-judge baselines that operate on conversation context.
"""

from __future__ import annotations

import json
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


@register_loader("toolemu")
class ToolEmuLoader(BaseLoader):
    def iter_records(self) -> Iterable[BenchRecord]:
        traj = self.root / "test_cases_with_trajectories.json"
        cases = self.root / "all_cases.json"

        if traj.exists():
            yield from self._from_trajectories(traj)
        elif cases.exists():
            yield from self._from_cases(cases)

    def _from_trajectories(self, path) -> Iterable[BenchRecord]:
        with path.open() as f:
            data = json.load(f)
        for i, case in enumerate(data):
            session = f"toolemu::{i}"
            user_instr = case.get("User Instruction", "")
            for step, action in enumerate(case.get("intermediate_steps", [])):
                tool = action.get("tool") or action.get("action")
                args = action.get("tool_input") or action.get("action_input") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {"_raw": args}
                yield BenchRecord(
                    id=f"{session}::step{step}",
                    source="toolemu",
                    label=Label.MALICIOUS,
                    category=AttackCategory.UNAUTHORIZED_ACTION,
                    tool_call=ToolCall(
                        tool_name=tool or "unknown",
                        arguments=args if isinstance(args, dict) else {"_raw": args},
                        framework="toolemu-sandbox",
                    ),
                    conversation=[{"role": "user", "content": user_instr}],
                    session_id=session,
                    step_index=step,
                    distribution=Distribution.NEAR_OOD,
                    granularity=Granularity.COARSE,
                    meta={"toolkits": case.get("Toolkits"), "license": "MIT"},
                )

    def _from_cases(self, path) -> Iterable[BenchRecord]:
        with path.open() as f:
            cases = json.load(f)
        for i, case in enumerate(cases):
            yield BenchRecord(
                id=f"toolemu::case{i}",
                source="toolemu",
                label=Label.MALICIOUS,
                category=AttackCategory.UNAUTHORIZED_ACTION,
                tool_call=ToolCall(
                    tool_name="<intent_only>",
                    arguments={},
                    framework="toolemu-sandbox",
                ),
                conversation=[
                    {"role": "user", "content": case.get("User Instruction", "")}
                ],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.INTENT,
                meta={
                    "toolkits": case.get("Toolkits"),
                    "intent_only": True,
                    "license": "MIT",
                    # Carried through so an agent-rollout pass can later
                    # instantiate these into real tool calls, and so an
                    # LLM-judge-only evaluation has the risk description
                    # to score against.
                    "potential_risky_actions": case.get("Potential Risky Actions"),
                    "potential_risky_outcomes": case.get("Potential Risky Outcomes"),
                    "expected_achievements": case.get("Expected Achievements"),
                },
            )
