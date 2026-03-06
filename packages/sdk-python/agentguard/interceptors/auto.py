"""
Auto-instrumentation: patches Anthropic/OpenAI at SDK level.
Zero user code changes required.
"""

import time
import threading
import urllib.request
import urllib.error
import json as _json_mod
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, Optional
from uuid import uuid4

if TYPE_CHECKING:
    from ..core.tracer import AgentGuard


class AgentGuardBlockedError(RuntimeError):
    """Raised when blocking mode is on and the gateway denies a tool call."""
    def __init__(self, tool_name: str, reason: str, risk_level: str, check_id: str):
        super().__init__(f"[AgentGuard] Blocked: '{tool_name}' — {reason}")
        self.tool_name = tool_name
        self.reason = reason
        self.risk_level = risk_level
        self.check_id = check_id


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

    # ── Blocking check ─────────────────────────────────────────────────────

    def _check_block(self, tool_name: str, arguments: dict) -> None:
        """
        Call /api/v1/check synchronously.

        Three possible responses:
          decision=allow   → proceed immediately
          decision=block   → raise AgentGuardBlockedError
          decision=pending → poll until human approves/rejects (blocking mode)

        On network error → fail-open or fail-closed depending on config.
        """
        cfg = self._guard.config
        if not getattr(cfg, 'blocking_mode', False):
            return

        gateway_url = cfg.gateway_url.rstrip('/')
        timeout_s   = getattr(cfg, 'blocking_timeout_ms', 3000) / 1000
        fail_open   = getattr(cfg, 'fail_open', True)
        overrides   = getattr(cfg, 'tool_categories', {})

        payload = _json_mod.dumps({
            "agent_id":               str(self._guard._agent_uuid),
            "tool_name":              tool_name,
            "arguments":              arguments,
            "environment":            getattr(cfg, 'environment', 'DEVELOPMENT'),
            "blocking":               True,
            "user_category_overrides": overrides,
        }).encode()

        try:
            req = urllib.request.Request(
                f"{gateway_url}/api/v1/check",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                result = _json_mod.loads(resp.read())

            decision   = result.get("decision", "allow")
            risk_level = result.get("risk_level", "LOW")
            check_id   = result.get("check_id", "")
            category   = result.get("category", "unknown")

            if decision == "block":
                raise AgentGuardBlockedError(
                    tool_name=tool_name,
                    reason=result.get("reason", "Policy violation"),
                    risk_level=risk_level,
                    check_id=check_id,
                )

            if decision == "pending":
                print(f"[AEGIS] ⏳ '{tool_name}' ({category}, {risk_level}) awaiting human approval…")
                self._poll_for_decision(gateway_url, check_id, tool_name, risk_level)

        except AgentGuardBlockedError:
            raise
        except Exception as e:
            if not fail_open:
                raise AgentGuardBlockedError(
                    tool_name=tool_name,
                    reason=f"Gateway unreachable and fail_open=False: {e}",
                    risk_level="CRITICAL",
                    check_id="gateway-unreachable",
                )
            # fail-open: allow

    def _poll_for_decision(
        self, gateway_url: str, check_id: str, tool_name: str, risk_level: str
    ) -> None:
        """
        Poll GET /api/v1/check/:checkId/decision until human decides or timeout.
        Raises AgentGuardBlockedError on block or timeout.
        """
        import time as _time
        cfg           = self._guard.config
        timeout_s     = getattr(cfg, 'human_approval_timeout_s', 300)
        poll_interval = getattr(cfg, 'poll_interval_s', 2.0)
        deadline      = _time.time() + timeout_s

        while _time.time() < deadline:
            _time.sleep(poll_interval)
            try:
                req = urllib.request.Request(
                    f"{gateway_url}/api/v1/check/{check_id}/decision",
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    result = _json_mod.loads(resp.read())
                decision = result.get("decision", "pending")

                if decision == "allow":
                    print(f"[AEGIS] ✅ '{tool_name}' approved by {result.get('decided_by', 'human')}")
                    return
                if decision == "block":
                    raise AgentGuardBlockedError(
                        tool_name=tool_name,
                        reason="Rejected by human reviewer",
                        risk_level=risk_level,
                        check_id=check_id,
                    )
                # still pending — keep polling
            except AgentGuardBlockedError:
                raise
            except Exception:
                pass  # network blip — keep polling

        # Timed out — fail-safe: block
        raise AgentGuardBlockedError(
            tool_name=tool_name,
            reason=f"Human approval timed out after {timeout_s}s",
            risk_level=risk_level,
            check_id=check_id,
        )

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
                                    token_usage=pending.get("token_usage"),
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

                    # Capture token usage from this response
                    usage = getattr(response, "usage", None)
                    token_usage = {}
                    if usage:
                        token_usage = {
                            "input_tokens":  getattr(usage, "input_tokens",  0),
                            "output_tokens": getattr(usage, "output_tokens", 0),
                            "model": getattr(response, "model", None),
                        }

                    for block in response.content:
                        if getattr(block, "type", None) == "tool_use":
                            args = dict(block.input) if block.input else {}
                            # Blocking check before registering pending
                            instrument._check_block(block.name, args)
                            with instrument._lock:
                                instrument._pending[block.id] = {
                                    "tool_name": block.name,
                                    "input_prompt": last_prompt or block.name,
                                    "arguments": args,
                                    "start_time": time.time(),
                                    "token_usage": token_usage,
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
                                token_usage=pending.get("token_usage"),
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
                    # Capture token usage from response
                    usage = getattr(response, "usage", None)
                    token_usage = {}
                    if usage:
                        token_usage = {
                            "input_tokens":  getattr(usage, "prompt_tokens",     0),
                            "output_tokens": getattr(usage, "completion_tokens", 0),
                            "model": getattr(response, "model", None),
                        }
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
                                "token_usage": token_usage,
                            }

                return response

            _mod.Completions.create = patched_create
            return True
        except Exception as e:
            print(f"[AEGIS] OpenAI auto-patch failed: {e}")
            return False

    # ── LangGraph / LangChain ──────────────────────────────────────────────

    def patch_langgraph(self) -> bool:
        """
        Patches langchain_core.tools.base.BaseTool.invoke.
        Covers LangChain tools used in LangGraph, LCEL chains, and agents.
        """
        try:
            import langchain_core.tools.base as _mod
            original_invoke = _mod.BaseTool.invoke
            instrument = self

            def patched_invoke(self_tool, input, config=None, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                # Normalise input to string for prompt
                if isinstance(input, dict):
                    import json as _json
                    input_str = _json.dumps(input)
                    args = input
                else:
                    input_str = str(input)
                    args = {"input": input_str}

                # Blocking check
                instrument._check_block(tool_name, args)

                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = original_invoke(self_tool, input, config, **kwargs)
                    return result
                except Exception as e:
                    error = str(e)
                    raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name,
                        input_prompt=input_str,
                        arguments=args,
                        result=result,
                        start_time=start,
                        error=error,
                    )

            _mod.BaseTool.invoke = patched_invoke
            return True
        except Exception as e:
            print(f"[AEGIS] LangGraph auto-patch failed: {e}")
            return False

    # ── CrewAI ─────────────────────────────────────────────────────────────

    def patch_crewai(self) -> bool:
        """
        Patches crewai.tools.base_tool.BaseTool.run / _run.
        """
        try:
            import crewai.tools.base_tool as _mod
            original_run = _mod.BaseTool.run
            instrument = self

            def patched_run(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                input_val = args[0] if args else kwargs.get("tool_input", "")
                if isinstance(input_val, dict):
                    import json as _json
                    input_str = _json.dumps(input_val)
                    tool_args = input_val
                else:
                    input_str = str(input_val)
                    tool_args = {"input": input_str}

                # Blocking check
                instrument._check_block(tool_name, tool_args)

                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = original_run(self_tool, *args, **kwargs)
                    return result
                except Exception as e:
                    error = str(e)
                    raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name,
                        input_prompt=input_str,
                        arguments=tool_args,
                        result=result,
                        start_time=start,
                        error=error,
                    )

            _mod.BaseTool.run = patched_run
            return True
        except Exception as e:
            print(f"[AEGIS] CrewAI auto-patch failed: {e}")
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
        token_usage: Optional[dict] = None,
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

            agent_id = self._guard._agent_uuid

            # Build observation metadata with token usage if available
            obs_metadata: dict = {}
            if token_usage:
                obs_metadata["token_usage"] = token_usage

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
                    metadata=obs_metadata if obs_metadata else None,
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

            # Attach session_id if configured (sent as extra field for gateway to store)
            session_id = getattr(cfg, 'session_id', None)
            if session_id:
                trace_dict = trace.model_dump(mode="json")
                trace_dict['session_id'] = session_id
                self._guard._transport.send_trace_dict(trace_dict)
            else:
                self._guard._transport.send_trace(trace)
            self._guard._previous_hash = integrity_hash

        except Exception as e:
            print(f"[AEGIS] Failed to send auto-trace: {e}")
