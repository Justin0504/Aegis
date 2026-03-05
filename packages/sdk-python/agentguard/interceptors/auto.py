"""
Auto-instrumentation: patches Anthropic/OpenAI at SDK level.
Zero user code changes required.
"""

import time
import threading
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, Optional
from uuid import uuid4

if TYPE_CHECKING:
    from ..core.tracer import AgentGuard


class AutoInstrument:
    """
    Patches Anthropic and OpenAI message APIs to auto-trace tool calls.

    Flow (Anthropic):
      1. messages.create() returns  → response has tool_use blocks
         → store pending{tool_use_id: {name, input, prompt, start_time}}
      2. Next messages.create() call → messages contain tool_result blocks
         → match by tool_use_id, send complete trace
    """

    _lock = threading.Lock()

    def __init__(self, guard: "AgentGuard"):
        self._guard = guard
        self._pending: Dict[str, Dict[str, Any]] = {}  # tool_use_id → partial data

    # ── Anthropic ──────────────────────────────────────────────────────────

    def patch_anthropic(self) -> bool:
        try:
            import anthropic.resources.messages as _mod
            original = _mod.Messages.create

            instrument = self  # closure

            def patched_create(self_msg, **kwargs):
                messages = kwargs.get("messages", [])

                # ① Collect tool_results from incoming messages → complete pending traces
                for msg in messages:
                    content = msg.get("content", [])
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            tid = block.get("tool_use_id")
                            result = block.get("content", "")
                            if isinstance(result, list):
                                # list of content blocks → extract text
                                result = " ".join(
                                    b.get("text", "") for b in result
                                    if isinstance(b, dict)
                                )
                            with instrument._lock:
                                pending = instrument._pending.pop(tid, None)
                            if pending:
                                instrument._send_trace(
                                    tool_name=pending["tool_name"],
                                    input_prompt=pending["input_prompt"],
                                    arguments=pending["arguments"],
                                    result=result,
                                    start_time=pending["start_time"],
                                    error=None,
                                )

                # ② Make the real call
                response = original(self_msg, **kwargs)

                # ③ Extract tool_use blocks from response → store as pending
                if getattr(response, "stop_reason", None) == "tool_use":
                    # Grab the last user prompt as context
                    last_prompt = ""
                    for msg in reversed(messages):
                        c = msg.get("content", "")
                        if isinstance(c, str) and msg.get("role") == "user":
                            last_prompt = c
                            break
                        if isinstance(c, list):
                            for b in c:
                                if isinstance(b, dict) and b.get("type") == "text":
                                    last_prompt = b.get("text", "")
                                    break
                            if last_prompt:
                                break

                    for block in response.content:
                        if getattr(block, "type", None) == "tool_use":
                            with instrument._lock:
                                instrument._pending[block.id] = {
                                    "tool_name": block.name,
                                    "input_prompt": last_prompt or block.name,
                                    "arguments": dict(block.input) if block.input else {},
                                    "start_time": time.time(),
                                }

                return response

            _mod.Messages.create = patched_create
            return True
        except Exception as e:
            print(f"[AEGIS] Anthropic auto-patch failed: {e}")
            return False

    # ── OpenAI ─────────────────────────────────────────────────────────────

    def patch_openai(self) -> bool:
        try:
            import openai.resources.chat.completions as _mod
            original = _mod.Completions.create

            instrument = self

            def patched_create(self_comp, **kwargs):
                messages = kwargs.get("messages", [])

                # ① Collect tool results from incoming messages
                for msg in messages:
                    if msg.get("role") == "tool":
                        tid = msg.get("tool_call_id")
                        result = msg.get("content", "")
                        with instrument._lock:
                            pending = instrument._pending.pop(tid, None)
                        if pending:
                            instrument._send_trace(
                                tool_name=pending["tool_name"],
                                input_prompt=pending["input_prompt"],
                                arguments=pending["arguments"],
                                result=result,
                                start_time=pending["start_time"],
                                error=None,
                            )

                response = original(self_comp, **kwargs)

                # ② Extract tool_calls from response
                choice = response.choices[0] if response.choices else None
                if choice and getattr(choice, "finish_reason", None) == "tool_calls":
                    last_prompt = next(
                        (m.get("content", "") for m in reversed(messages)
                         if m.get("role") == "user"),
                        ""
                    )
                    for tc in (choice.message.tool_calls or []):
                        import json as _json
                        try:
                            args = _json.loads(tc.function.arguments or "{}")
                        except Exception:
                            args = {}
                        with instrument._lock:
                            instrument._pending[tc.id] = {
                                "tool_name": tc.function.name,
                                "input_prompt": last_prompt or tc.function.name,
                                "arguments": args,
                                "start_time": time.time(),
                            }

                return response

            _mod.Completions.create = patched_create
            return True
        except Exception as e:
            print(f"[AEGIS] OpenAI auto-patch failed: {e}")
            return False

    # ── Send trace ─────────────────────────────────────────────────────────

    def _send_trace(
        self,
        tool_name: str,
        input_prompt: str,
        arguments: dict,
        result: Any,
        start_time: float,
        error: Optional[str],
    ):
        try:
            from agentguard_core_schema import (
                AgentActionTrace, CreateTraceRequest,
                InputContext, Observation, ThoughtChain, ToolCall,
                calculate_trace_hash,
            )
            from uuid import UUID

            duration_ms = (time.time() - start_time) * 1000
            now = datetime.utcnow()
            ctx_id = uuid4()
            cfg = self._guard.config

            agent_id = (
                UUID(cfg.agent_id)
                if self._guard._is_valid_uuid(cfg.agent_id)
                else uuid4()
            )

            trace_request = CreateTraceRequest(
                agent_id=agent_id,
                sequence_number=self._guard._sequence_counter,
                input_context=InputContext(prompt=input_prompt),
                thought_chain=ThoughtChain(
                    raw_tokens="Auto-captured via SDK interceptor",
                    parsed_steps=[],
                ),
                tool_call=ToolCall(
                    tool_name=tool_name,
                    function=tool_name,
                    arguments=arguments,
                    timestamp=now,
                ),
                observation=Observation(
                    raw_output=result,
                    error=error,
                    duration_ms=max(duration_ms, 0.001),
                ),
                previous_hash=self._guard._previous_hash,
                environment=cfg.environment,
            )

            self._guard._sequence_counter += 1

            td = trace_request.model_dump()
            td["trace_id"] = str(ctx_id)
            integrity_hash = calculate_trace_hash(td)

            trace = AgentActionTrace(
                **trace_request.model_dump(),
                trace_id=ctx_id,
                integrity_hash=integrity_hash,
            )

            self._guard._transport.send_trace(trace)
            self._guard._previous_hash = integrity_hash

        except Exception as e:
            print(f"[AEGIS] Failed to send auto-trace: {e}")
