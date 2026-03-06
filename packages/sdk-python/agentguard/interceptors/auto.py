"""
Auto-instrumentation: patches Anthropic/OpenAI at SDK level.
Zero user code changes required. Supports both sync and async APIs.
"""

import time
import asyncio
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
    Supports both sync (Messages.create) and async (AsyncMessages.create).

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

    # ── Shared payload builder ──────────────────────────────────────────────

    def _build_check_payload(self, tool_name: str, arguments: dict) -> bytes:
        cfg = self._guard.config
        return _json_mod.dumps({
            "agent_id":                str(self._guard._agent_uuid),
            "tool_name":               tool_name,
            "arguments":               arguments,
            "environment":             getattr(cfg, 'environment', 'DEVELOPMENT'),
            "blocking":                True,
            "user_category_overrides": getattr(cfg, 'tool_categories', {}),
        }).encode()

    def _raise_if_blocked(self, tool_name: str, result: dict) -> Optional[tuple]:
        """Returns (check_id, risk_level, category) if pending, raises if blocked."""
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
            return check_id, risk_level, category
        return None

    # ── Shared pre-check helpers ────────────────────────────────────────────

    _SEV = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}

    def _should_skip(self, tool_name: str) -> bool:
        """Return True if this tool is on the allow-list → skip all checks."""
        cfg         = self._guard.config
        allow_tools = getattr(cfg, 'allow_tools', [])
        return tool_name in allow_tools

    def _is_above_threshold(self, risk_level: str) -> bool:
        """Return True if risk_level meets or exceeds block_threshold."""
        cfg       = self._guard.config
        threshold = getattr(cfg, 'block_threshold', 'HIGH')
        return self._SEV.get(risk_level, 0) >= self._SEV.get(threshold, 2)

    # ── Sync blocking check ─────────────────────────────────────────────────

    def _check_block(self, tool_name: str, arguments: dict) -> None:
        """
        Call /api/v1/check synchronously.
        decision=allow   → return
        decision=block   → raise AgentGuardBlockedError (unless audit_only)
        decision=pending → poll synchronously until human decides or timeout
        On network error → fail-open or fail-closed per config.
        """
        cfg = self._guard.config
        if not getattr(cfg, 'blocking_mode', False):
            return
        if self._should_skip(tool_name):
            return  # whitelisted tool — always allow

        gateway_url = cfg.gateway_url.rstrip('/')
        timeout_s   = getattr(cfg, 'blocking_timeout_ms', 3000) / 1000
        fail_open   = getattr(cfg, 'fail_open', True)
        audit_only  = getattr(cfg, 'audit_only', False)

        try:
            req = urllib.request.Request(
                f"{gateway_url}/api/v1/check",
                data=self._build_check_payload(tool_name, arguments),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                result = _json_mod.loads(resp.read())

            risk_level = result.get("risk_level", "LOW")

            # Threshold check — below threshold → audit only, don't block
            if not self._is_above_threshold(risk_level):
                if result.get("decision") == "block":
                    print(f"[AEGIS] 📋 '{tool_name}' ({risk_level}) below threshold — audited, not blocked")
                return

            if audit_only:
                decision = result.get("decision", "allow")
                if decision == "block":
                    print(f"[AEGIS] 📋 AUDIT '{tool_name}' would be {decision} ({risk_level}) — audit_only=True, allowing")
                return

            pending_info = self._raise_if_blocked(tool_name, result)
            if pending_info:
                check_id, risk_level, category = pending_info
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

    def _poll_for_decision(
        self, gateway_url: str, check_id: str, tool_name: str, risk_level: str
    ) -> None:
        """Sync poll. Raises AgentGuardBlockedError on block or timeout."""
        cfg           = self._guard.config
        timeout_s     = getattr(cfg, 'human_approval_timeout_s', 300)
        poll_interval = getattr(cfg, 'poll_interval_s', 2.0)
        deadline      = time.time() + timeout_s

        while time.time() < deadline:
            time.sleep(poll_interval)
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
            except AgentGuardBlockedError:
                raise
            except Exception:
                pass  # network blip — keep polling

        raise AgentGuardBlockedError(
            tool_name=tool_name,
            reason=f"Human approval timed out after {timeout_s}s",
            risk_level=risk_level,
            check_id=check_id,
        )

    # ── Async blocking check ────────────────────────────────────────────────

    async def _async_check_block(self, tool_name: str, arguments: dict) -> None:
        """Async version of _check_block."""
        cfg = self._guard.config
        if not getattr(cfg, 'blocking_mode', False):
            return
        if self._should_skip(tool_name):
            return

        gateway_url = cfg.gateway_url.rstrip('/')
        timeout_s   = getattr(cfg, 'blocking_timeout_ms', 3000) / 1000
        fail_open   = getattr(cfg, 'fail_open', True)
        audit_only  = getattr(cfg, 'audit_only', False)

        try:
            # Use asyncio-friendly HTTP (run blocking urllib in thread pool)
            loop = asyncio.get_event_loop()
            payload = self._build_check_payload(tool_name, arguments)

            def _do_check():
                req = urllib.request.Request(
                    f"{gateway_url}/api/v1/check",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                    return _json_mod.loads(resp.read())

            result = await loop.run_in_executor(None, _do_check)

            risk_level = result.get("risk_level", "LOW")

            if not self._is_above_threshold(risk_level):
                return

            if audit_only:
                decision = result.get("decision", "allow")
                if decision == "block":
                    print(f"[AEGIS] 📋 AUDIT '{tool_name}' would be {decision} ({risk_level}) — audit_only=True, allowing")
                return

            pending_info = self._raise_if_blocked(tool_name, result)
            if pending_info:
                check_id, risk_level, category = pending_info
                print(f"[AEGIS] ⏳ '{tool_name}' ({category}, {risk_level}) awaiting human approval…")
                await self._async_poll_for_decision(gateway_url, check_id, tool_name, risk_level)

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

    async def _async_poll_for_decision(
        self, gateway_url: str, check_id: str, tool_name: str, risk_level: str
    ) -> None:
        """Async poll. Uses asyncio.sleep — does not block the event loop."""
        cfg           = self._guard.config
        timeout_s     = getattr(cfg, 'human_approval_timeout_s', 300)
        poll_interval = getattr(cfg, 'poll_interval_s', 2.0)
        deadline      = time.time() + timeout_s
        loop          = asyncio.get_event_loop()

        while time.time() < deadline:
            await asyncio.sleep(poll_interval)
            try:
                def _do_poll():
                    req = urllib.request.Request(
                        f"{gateway_url}/api/v1/check/{check_id}/decision",
                        method="GET",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        return _json_mod.loads(resp.read())

                result   = await loop.run_in_executor(None, _do_poll)
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
            except AgentGuardBlockedError:
                raise
            except Exception:
                pass

        raise AgentGuardBlockedError(
            tool_name=tool_name,
            reason=f"Human approval timed out after {timeout_s}s",
            risk_level=risk_level,
            check_id=check_id,
        )

    # ── Shared helpers ──────────────────────────────────────────────────────

    def _extract_last_prompt(self, messages: list) -> str:
        for msg in reversed(messages):
            c = msg.get("content", "")
            if isinstance(c, str) and msg.get("role") == "user":
                return c
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "text":
                        return b.get("text", "")
        return ""

    def _collect_tool_results_anthropic(self, messages: list) -> None:
        for msg in messages:
            content = msg.get("content", [])
            if not isinstance(content, list):
                continue
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tid    = block.get("tool_use_id")
                    result = block.get("content", "")
                    if isinstance(result, list):
                        result = " ".join(
                            b.get("text", "") for b in result if isinstance(b, dict)
                        )
                    with self._lock:
                        pending = self._pending.pop(tid, None)
                    if pending:
                        self._send_trace(
                            tool_name=pending["tool_name"],
                            input_prompt=pending["input_prompt"],
                            arguments=pending["arguments"],
                            result=result,
                            start_time=pending["start_time"],
                            error=None,
                            token_usage=pending.get("token_usage"),
                        )

    def _register_tool_use_blocks(self, response: Any, last_prompt: str, token_usage: dict) -> None:
        for block in response.content:
            if getattr(block, "type", None) == "tool_use":
                args = dict(block.input) if block.input else {}
                self._check_block(block.name, args)
                with self._lock:
                    self._pending[block.id] = {
                        "tool_name":    block.name,
                        "input_prompt": last_prompt or block.name,
                        "arguments":    args,
                        "start_time":   time.time(),
                        "token_usage":  token_usage,
                    }

    async def _async_register_tool_use_blocks(self, response: Any, last_prompt: str, token_usage: dict) -> None:
        for block in response.content:
            if getattr(block, "type", None) == "tool_use":
                args = dict(block.input) if block.input else {}
                await self._async_check_block(block.name, args)
                with self._lock:
                    self._pending[block.id] = {
                        "tool_name":    block.name,
                        "input_prompt": last_prompt or block.name,
                        "arguments":    args,
                        "start_time":   time.time(),
                        "token_usage":  token_usage,
                    }

    @staticmethod
    def _get_token_usage_anthropic(response: Any) -> dict:
        usage = getattr(response, "usage", None)
        if not usage:
            return {}
        return {
            "input_tokens":  getattr(usage, "input_tokens",  0),
            "output_tokens": getattr(usage, "output_tokens", 0),
            "model":         getattr(response, "model", None),
        }

    # ── Anthropic sync ──────────────────────────────────────────────────────

    def patch_anthropic(self) -> bool:
        try:
            import anthropic.resources.messages as _mod
            original  = _mod.Messages.create
            instrument = self

            def patched_create(self_msg, **kwargs):
                messages = kwargs.get("messages", [])
                instrument._collect_tool_results_anthropic(messages)
                response = original(self_msg, **kwargs)
                if getattr(response, "stop_reason", None) == "tool_use":
                    token_usage = instrument._get_token_usage_anthropic(response)
                    last_prompt = instrument._extract_last_prompt(messages)
                    instrument._register_tool_use_blocks(response, last_prompt, token_usage)
                return response

            _mod.Messages.create = patched_create
            return True
        except Exception as e:
            print(f"[AEGIS] Anthropic sync auto-patch failed: {e}")
            return False

    # ── Anthropic async ─────────────────────────────────────────────────────

    def patch_anthropic_async(self) -> bool:
        try:
            import anthropic.resources.messages as _mod
            original_async = _mod.AsyncMessages.create
            instrument     = self

            async def patched_async_create(self_msg, **kwargs):
                messages = kwargs.get("messages", [])
                instrument._collect_tool_results_anthropic(messages)
                response = await original_async(self_msg, **kwargs)
                if getattr(response, "stop_reason", None) == "tool_use":
                    token_usage = instrument._get_token_usage_anthropic(response)
                    last_prompt = instrument._extract_last_prompt(messages)
                    await instrument._async_register_tool_use_blocks(response, last_prompt, token_usage)
                return response

            _mod.AsyncMessages.create = patched_async_create
            return True
        except Exception as e:
            print(f"[AEGIS] Anthropic async auto-patch failed: {e}")
            return False

    # ── OpenAI sync ─────────────────────────────────────────────────────────

    def patch_openai(self) -> bool:
        try:
            import openai.resources.chat.completions as _mod
            original   = _mod.Completions.create
            instrument = self

            def patched_create(self_comp, **kwargs):
                messages = kwargs.get("messages", [])
                for msg in messages:
                    if msg.get("role") == "tool":
                        tid    = msg.get("tool_call_id")
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
                choice   = response.choices[0] if response.choices else None
                if choice and getattr(choice, "finish_reason", None) == "tool_calls":
                    last_prompt = next(
                        (m.get("content", "") for m in reversed(messages)
                         if m.get("role") == "user"), ""
                    )
                    usage = getattr(response, "usage", None)
                    token_usage = {
                        "input_tokens":  getattr(usage, "prompt_tokens",     0),
                        "output_tokens": getattr(usage, "completion_tokens", 0),
                        "model":         getattr(response, "model", None),
                    } if usage else {}
                    for tc in (choice.message.tool_calls or []):
                        import json as _j
                        try:
                            args = _j.loads(tc.function.arguments or "{}")
                        except Exception:
                            args = {}
                        instrument._check_block(tc.function.name, args)
                        with instrument._lock:
                            instrument._pending[tc.id] = {
                                "tool_name":    tc.function.name,
                                "input_prompt": last_prompt or tc.function.name,
                                "arguments":    args,
                                "start_time":   time.time(),
                                "token_usage":  token_usage,
                            }
                return response

            _mod.Completions.create = patched_create
            return True
        except Exception as e:
            print(f"[AEGIS] OpenAI sync auto-patch failed: {e}")
            return False

    # ── OpenAI async ────────────────────────────────────────────────────────

    def patch_openai_async(self) -> bool:
        try:
            import openai.resources.chat.completions as _mod
            original_async = _mod.AsyncCompletions.create
            instrument     = self

            async def patched_async_create(self_comp, **kwargs):
                messages = kwargs.get("messages", [])
                for msg in messages:
                    if msg.get("role") == "tool":
                        tid    = msg.get("tool_call_id")
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

                response = await original_async(self_comp, **kwargs)
                choice   = response.choices[0] if response.choices else None
                if choice and getattr(choice, "finish_reason", None) == "tool_calls":
                    last_prompt = next(
                        (m.get("content", "") for m in reversed(messages)
                         if m.get("role") == "user"), ""
                    )
                    usage = getattr(response, "usage", None)
                    token_usage = {
                        "input_tokens":  getattr(usage, "prompt_tokens",     0),
                        "output_tokens": getattr(usage, "completion_tokens", 0),
                        "model":         getattr(response, "model", None),
                    } if usage else {}
                    for tc in (choice.message.tool_calls or []):
                        import json as _j
                        try:
                            args = _j.loads(tc.function.arguments or "{}")
                        except Exception:
                            args = {}
                        await instrument._async_check_block(tc.function.name, args)
                        with instrument._lock:
                            instrument._pending[tc.id] = {
                                "tool_name":    tc.function.name,
                                "input_prompt": last_prompt or tc.function.name,
                                "arguments":    args,
                                "start_time":   time.time(),
                                "token_usage":  token_usage,
                            }
                return response

            _mod.AsyncCompletions.create = patched_async_create
            return True
        except Exception as e:
            print(f"[AEGIS] OpenAI async auto-patch failed: {e}")
            return False

    # ── LangGraph / LangChain ──────────────────────────────────────────────

    def patch_langgraph(self) -> bool:
        """Patches BaseTool.invoke (sync) and BaseTool.ainvoke (async)."""
        patched_any = False
        try:
            import langchain_core.tools.base as _mod
            original_invoke = _mod.BaseTool.invoke
            instrument      = self

            def patched_invoke(self_tool, input, config=None, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                if isinstance(input, dict):
                    import json as _j
                    args = input
                    input_str = _j.dumps(input)
                else:
                    input_str = str(input)
                    args = {"input": input_str}

                instrument._check_block(tool_name, args)
                start  = time.time()
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
                        tool_name=tool_name, input_prompt=input_str,
                        arguments=args, result=result,
                        start_time=start, error=error,
                    )

            _mod.BaseTool.invoke = patched_invoke
            patched_any = True
        except Exception as e:
            print(f"[AEGIS] LangGraph sync auto-patch failed: {e}")

        # async ainvoke
        try:
            import langchain_core.tools.base as _mod
            original_ainvoke = _mod.BaseTool.ainvoke
            instrument       = self

            async def patched_ainvoke(self_tool, input, config=None, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                if isinstance(input, dict):
                    import json as _j
                    args = input
                    input_str = _j.dumps(input)
                else:
                    input_str = str(input)
                    args = {"input": input_str}

                await instrument._async_check_block(tool_name, args)
                start  = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = await original_ainvoke(self_tool, input, config, **kwargs)
                    return result
                except Exception as e:
                    error = str(e)
                    raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=input_str,
                        arguments=args, result=result,
                        start_time=start, error=error,
                    )

            _mod.BaseTool.ainvoke = patched_ainvoke
        except Exception as e:
            print(f"[AEGIS] LangGraph async auto-patch failed: {e}")

        return patched_any

    # ── CrewAI ─────────────────────────────────────────────────────────────

    def patch_crewai(self) -> bool:
        try:
            import crewai.tools.base_tool as _mod
            original_run = _mod.BaseTool.run
            instrument   = self

            def patched_run(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                input_val = args[0] if args else kwargs.get("tool_input", "")
                if isinstance(input_val, dict):
                    import json as _j
                    input_str = _j.dumps(input_val)
                    tool_args = input_val
                else:
                    input_str = str(input_val)
                    tool_args = {"input": input_str}

                instrument._check_block(tool_name, tool_args)
                start  = time.time()
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
                        tool_name=tool_name, input_prompt=input_str,
                        arguments=tool_args, result=result,
                        start_time=start, error=error,
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

            duration_ms = (time.time() - start_time) * 1000
            now         = datetime.utcnow()
            ctx_id      = uuid4()
            cfg         = self._guard.config
            agent_id    = self._guard._agent_uuid

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
            td["trace_id"]      = str(ctx_id)
            integrity_hash      = calculate_trace_hash(td)

            trace = AgentActionTrace(
                **trace_request.model_dump(),
                trace_id=ctx_id,
                integrity_hash=integrity_hash,
            )

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
