"""
Auto-instrumentation: patches Anthropic/OpenAI at SDK level.
Zero user code changes required. Supports both sync and async APIs.
"""

import os
import time
import asyncio
import threading
import urllib.request
import urllib.error
import json as _json_mod
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, Optional
from uuid import uuid4


def _debug_env() -> bool:
    return os.environ.get('AEGIS_DEBUG', '').lower() in ('1', 'true', 'yes')


# Known outbound HTTP sinks — URL prefix → tool name prefix.
# Order matters: longer prefixes should win, so if you add a sub-path
# override put it BEFORE its parent prefix in insertion order.
HTTP_TOOL_ENDPOINTS: Dict[str, str] = {
    # Payments / money movement
    'https://api.stripe.com/':      'stripe',
    'https://api.circle.com/':      'circle_usdc',
    'https://api.coinbase.com/':    'coinbase',
    'https://api.brex.com/':        'brex',
    'https://production.plaid.com/':'plaid',
    'https://sandbox.plaid.com/':   'plaid',
    'https://api.paypal.com/':      'paypal',

    # Comms
    'https://slack.com/api/':       'slack',
    'https://api.slack.com/':       'slack',
    'https://api.twilio.com/':      'twilio',
    'https://api.sendgrid.com/':    'sendgrid',
    'https://api.resend.com/':      'resend',
    'https://api.postmarkapp.com/': 'postmark',

    # Storage / infra
    'https://api.github.com/':      'github',
    'https://api.digitalocean.com/':'digitalocean',
    'https://api.aws.amazon.com/':  'aws',
    'https://s3.amazonaws.com/':    's3',

    # AI providers (fallback — usually caught by SDK patches above)
    'https://api.openai.com/':      'openai',
    'https://api.anthropic.com/':   'anthropic',
    'https://generativelanguage.googleapis.com/': 'gemini',
    'https://api.cohere.ai/':       'cohere',
    'https://api.mistral.ai/':      'mistral',
    'https://api.deepseek.com/':    'deepseek',
    'https://openrouter.ai/':       'openrouter',

    # Healthcare
    'https://fhir.epic.com/':       'fhir_epic',

    # Data / observability
    'https://api.segment.io/':      'segment',
}


def _build_identity_headers(cfg) -> Dict[str, str]:
    """
    Header set that pins agent identity on every gateway call.

      x-api-key             — tenant key (config or env)
      x-aegis-agent-id      — this SDK instance's agent UUID
      x-aegis-agent-secret  — when the agent is registered with a secret
      x-aegis-session-id    — optional cross-call correlation
    """
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    api_key = (
        getattr(cfg, "api_key", None)
        or os.environ.get("AEGIS_API_KEY")
        or os.environ.get("AGENTGUARD_API_KEY")
    )
    if api_key:
        headers["x-api-key"] = api_key
    agent_id = getattr(cfg, "agent_id", None)
    if agent_id:
        headers["x-aegis-agent-id"] = str(agent_id)
    agent_secret = (
        getattr(cfg, "agent_secret", None)
        or os.environ.get("AEGIS_AGENT_SECRET")
        or os.environ.get("AGENTGUARD_AGENT_SECRET")
    )
    if agent_secret:
        headers["x-aegis-agent-secret"] = agent_secret
    agent_token = (
        getattr(cfg, "agent_token", None)
        or os.environ.get("AEGIS_AGENT_TOKEN")
    )
    if agent_token:
        headers["x-aegis-agent-token"] = agent_token
    session_id = (
        getattr(cfg, "session_id", None)
        or os.environ.get("AEGIS_SESSION_ID")
    )
    if session_id:
        headers["x-aegis-session-id"] = session_id
    build_artifact = (
        getattr(cfg, "build_artifact", None)
        or os.environ.get("AEGIS_BUILD_ARTIFACT")
        or os.environ.get("BUILD_ARTIFACT")
    )
    if build_artifact:
        headers["x-aegis-build-artifact"] = build_artifact
    source_commit = (
        getattr(cfg, "source_commit", None)
        or os.environ.get("AEGIS_SOURCE_COMMIT")
        or os.environ.get("GIT_COMMIT_SHA")
    )
    if source_commit:
        headers["x-aegis-source-commit"] = source_commit
    return headers

if TYPE_CHECKING:
    from ..core.tracer import AgentGuard

from ..notifier import notify_block, notify_pending


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
        agent_id = str(self._guard._agent_uuid)
        payload: Dict[str, Any] = {
            "agent_id":                agent_id,
            "tool_name":               tool_name,
            "arguments":               arguments,
            "environment":             getattr(cfg, 'environment', 'DEVELOPMENT'),
            "blocking":                True,
            "user_category_overrides": getattr(cfg, 'tool_categories', {}),
        }
        # If a LangChain AlignmentCallback (or any other observer) has
        # buffered a fresh verdict for this agent, splice it in so the
        # gateway's DSL rules can react on the same /check round-trip.
        # Import is lazy so the interceptor doesn't depend on
        # LangChain being installed.
        try:
            from ..integrations import _alignment_state
            verdict = _alignment_state.consume(agent_id)
        except ImportError:
            verdict = None
        if verdict:
            alignment_payload = _alignment_state.to_check_payload(verdict)
            if alignment_payload:
                payload["alignment"] = alignment_payload

        # Same pattern for CodeShield — agents that call
        # `code_shield.scan(...)` get the worst severity / rules
        # delivered to /check on the same hop, no manual wiring.
        try:
            from ..integrations import _code_shield_state
            cs_result = _code_shield_state.consume(agent_id)
        except ImportError:
            cs_result = None
        if cs_result:
            cs_payload = _code_shield_state.to_check_payload(cs_result)
            if cs_payload:
                payload["code_shield"] = cs_payload
        return _json_mod.dumps(payload).encode()

    def _raise_if_blocked(self, tool_name: str, result: dict) -> Optional[tuple]:
        """Returns (check_id, risk_level, category) if pending, raises if blocked."""
        decision   = result.get("decision", "allow")
        risk_level = result.get("risk_level", "LOW")
        check_id   = result.get("check_id", "")
        category   = result.get("category", "unknown")
        reason     = result.get("reason", "Policy violation")

        if decision == "block":
            notify_block(tool_name, risk_level, reason)
            raise AgentGuardBlockedError(
                tool_name=tool_name,
                reason=reason,
                risk_level=risk_level,
                check_id=check_id,
            )
        if decision == "pending":
            notify_pending(tool_name, risk_level)
            return check_id, risk_level, category
        return None

    # ── Shared pre-check helpers ────────────────────────────────────────────

    _SEV = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}

    def _should_skip_by_name(self, tool_name: str) -> bool:
        """Return True if tool name is on the allow-list (case-insensitive)."""
        cfg         = self._guard.config
        allow_tools = [t.lower() for t in getattr(cfg, 'allow_tools', [])]
        return tool_name.lower() in allow_tools

    def _should_skip_by_category(self, category: str) -> bool:
        """Return True if the tool's category is on the allow-list."""
        cfg              = self._guard.config
        allow_categories = getattr(cfg, 'allow_categories', [])
        return category in allow_categories

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
        if self._should_skip_by_name(tool_name):
            print(f"[AEGIS] ⬜ '{tool_name}' in allow_tools — skipped")
            return

        gateway_url = cfg.gateway_url.rstrip('/')
        timeout_s   = getattr(cfg, 'blocking_timeout_ms', 3000) / 1000
        fail_open   = getattr(cfg, 'fail_open', True)
        audit_only  = getattr(cfg, 'audit_only', False)

        try:
            req = urllib.request.Request(
                f"{gateway_url}/api/v1/check",
                data=self._build_check_payload(tool_name, arguments),
                headers=_build_identity_headers(cfg),
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                result = _json_mod.loads(resp.read())

            risk_level = result.get("risk_level", "LOW")
            category   = result.get("category", "unknown")

            # Category allow-list — e.g. allow_categories=["network"]
            if self._should_skip_by_category(category):
                print(f"[AEGIS] ⬜ '{tool_name}' ({category}) in allow_categories — skipped")
                return

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
                    headers=_build_identity_headers(self._guard.config),
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
        if self._should_skip_by_name(tool_name):
            print(f"[AEGIS] ⬜ '{tool_name}' in allow_tools — skipped")
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
                    headers=_build_identity_headers(cfg),
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                    return _json_mod.loads(resp.read())

            result = await loop.run_in_executor(None, _do_check)

            risk_level = result.get("risk_level", "LOW")
            category   = result.get("category", "unknown")

            if self._should_skip_by_category(category):
                print(f"[AEGIS] ⬜ '{tool_name}' ({category}) in allow_categories — skipped")
                return

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
                        headers=_build_identity_headers(self._guard.config),
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

    # ── Google Gemini ───────────────────────────────────────────────────────

    def patch_gemini(self) -> bool:
        """Patches google.generativeai GenerativeModel (sync + async)."""
        patched_any = False
        try:
            import google.generativeai.generative_models as _mod
            original_generate = _mod.GenerativeModel.generate_content
            instrument = self

            def patched_generate(self_model, contents, **kwargs):
                # Extract function calls from previous response if present
                tool_name = "gemini_generate"
                args = {"contents": str(contents)[:500]}
                instrument._check_block(tool_name, args)
                start = time.time()
                response = original_generate(self_model, contents, **kwargs)
                # Detect function calls in response
                for candidate in getattr(response, "candidates", []):
                    for part in getattr(candidate.content, "parts", []):
                        fc = getattr(part, "function_call", None)
                        if fc and fc.name:
                            import json as _j
                            fc_args = dict(fc.args) if fc.args else {}
                            instrument._check_block(fc.name, fc_args)
                            instrument._send_trace(
                                tool_name=fc.name, input_prompt=str(contents)[:500],
                                arguments=fc_args, result=None,
                                start_time=start, error=None,
                            )
                return response

            _mod.GenerativeModel.generate_content = patched_generate
            patched_any = True
        except Exception as e:
            print(f"[AEGIS] Gemini sync auto-patch failed: {e}")

        try:
            import google.generativeai.generative_models as _mod
            original_async = _mod.GenerativeModel.generate_content_async
            instrument = self

            async def patched_generate_async(self_model, contents, **kwargs):
                start = time.time()
                response = await original_async(self_model, contents, **kwargs)
                for candidate in getattr(response, "candidates", []):
                    for part in getattr(candidate.content, "parts", []):
                        fc = getattr(part, "function_call", None)
                        if fc and fc.name:
                            fc_args = dict(fc.args) if fc.args else {}
                            await instrument._async_check_block(fc.name, fc_args)
                            instrument._send_trace(
                                tool_name=fc.name, input_prompt=str(contents)[:500],
                                arguments=fc_args, result=None,
                                start_time=start, error=None,
                            )
                return response

            _mod.GenerativeModel.generate_content_async = patched_generate_async
        except Exception as e:
            print(f"[AEGIS] Gemini async auto-patch failed: {e}")

        return patched_any

    # ── AWS Bedrock ─────────────────────────────────────────────────────────

    def patch_bedrock(self) -> bool:
        """Patches boto3 bedrock-runtime client converse() method."""
        try:
            import boto3
            import botocore.client as _bc
            original_make_api_call = _bc.ClientCreator._create_api_method
            instrument = self

            # Patch at the session level — intercept converse calls
            original_make_call = None
            try:
                import botocore.endpoint as _ep
                original_http = _ep.BotocoreHTTPSession.send
            except Exception:
                pass

            # Simpler approach: patch via event system
            session = boto3.Session()
            original_create = session.__class__.client

            def patched_client(self_sess, service_name, **kwargs):
                client = original_create(self_sess, service_name, **kwargs)
                if service_name == "bedrock-runtime":
                    orig_converse = client.converse

                    def patched_converse(**kw):
                        msgs = kw.get("messages", [])
                        tool_name = "bedrock_converse"
                        args = {"model": kw.get("modelId", ""), "messages": len(msgs)}
                        instrument._check_block(tool_name, args)
                        start = time.time()
                        resp = orig_converse(**kw)
                        # Detect toolUse in output
                        output = resp.get("output", {}).get("message", {})
                        for block in output.get("content", []):
                            if "toolUse" in block:
                                tu = block["toolUse"]
                                instrument._check_block(tu.get("name", ""), tu.get("input", {}))
                                instrument._send_trace(
                                    tool_name=tu.get("name", "bedrock_tool"),
                                    input_prompt=str(msgs[-1] if msgs else ""),
                                    arguments=tu.get("input", {}),
                                    result=None, start_time=start, error=None,
                                )
                        return resp

                    client.converse = patched_converse
                return client

            session.__class__.client = patched_client
            return True
        except Exception as e:
            print(f"[AEGIS] Bedrock auto-patch failed: {e}")
            return False

    # ── Mistral ─────────────────────────────────────────────────────────────

    def patch_mistral(self) -> bool:
        """Patches mistralai SDK chat.complete (sync + async)."""
        patched_any = False
        try:
            import mistralai.client as _mod
            original_complete = _mod.MistralClient.chat
            instrument = self

            def patched_chat(self_client, messages, **kwargs):
                start = time.time()
                resp = original_complete(self_client, messages, **kwargs)
                choice = resp.choices[0] if resp.choices else None
                if choice and getattr(choice.message, "tool_calls", None):
                    import json as _j
                    for tc in choice.message.tool_calls:
                        try:
                            args = _j.loads(tc.function.arguments or "{}")
                        except Exception:
                            args = {}
                        instrument._check_block(tc.function.name, args)
                        instrument._send_trace(
                            tool_name=tc.function.name,
                            input_prompt=str(messages[-1] if messages else ""),
                            arguments=args, result=None,
                            start_time=start, error=None,
                        )
                return resp

            _mod.MistralClient.chat = patched_chat
            patched_any = True
        except Exception:
            pass

        # mistralai >= 1.0 uses Mistral client
        try:
            import mistralai as _mistral
            if hasattr(_mistral, "Mistral"):
                original_complete = _mistral.Mistral.chat.complete
                instrument = self

                def patched_complete(self_chat, messages=None, **kwargs):
                    start = time.time()
                    resp = original_complete(self_chat, messages=messages, **kwargs)
                    choice = resp.choices[0] if resp.choices else None
                    if choice and getattr(choice.message, "tool_calls", None):
                        import json as _j
                        for tc in choice.message.tool_calls:
                            try:
                                args = _j.loads(tc.function.arguments or "{}")
                            except Exception:
                                args = {}
                            instrument._check_block(tc.function.name, args)
                            instrument._send_trace(
                                tool_name=tc.function.name,
                                input_prompt="mistral_chat",
                                arguments=args, result=None,
                                start_time=start, error=None,
                            )
                    return resp

                _mistral.Mistral.chat.complete = patched_complete
                patched_any = True
        except Exception as e:
            print(f"[AEGIS] Mistral auto-patch failed: {e}")

        return patched_any

    # ── LlamaIndex ──────────────────────────────────────────────────────────

    def patch_llamaindex(self) -> bool:
        """Patches llama_index.core.tools FunctionTool._call and _acall."""
        patched_any = False
        try:
            import llama_index.core.tools.function_tool as _mod
            original_call = _mod.FunctionTool._call
            instrument = self

            def patched_call(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool.metadata, "name", self_tool.__class__.__name__)
                tool_args = {"args": str(args)[:200], **kwargs}
                instrument._check_block(tool_name, tool_args)
                start  = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = original_call(self_tool, *args, **kwargs)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(args)[:500],
                        arguments=tool_args, result=str(result) if result else None,
                        start_time=start, error=error,
                    )

            _mod.FunctionTool._call = patched_call
            patched_any = True
        except Exception as e:
            print(f"[AEGIS] LlamaIndex sync auto-patch failed: {e}")

        try:
            import llama_index.core.tools.function_tool as _mod
            original_acall = _mod.FunctionTool._acall
            instrument = self

            async def patched_acall(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool.metadata, "name", self_tool.__class__.__name__)
                tool_args = {"args": str(args)[:200], **kwargs}
                await instrument._async_check_block(tool_name, tool_args)
                start  = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = await original_acall(self_tool, *args, **kwargs)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(args)[:500],
                        arguments=tool_args, result=str(result) if result else None,
                        start_time=start, error=error,
                    )

            _mod.FunctionTool._acall = patched_acall
        except Exception as e:
            print(f"[AEGIS] LlamaIndex async auto-patch failed: {e}")

        return patched_any

    # ── smolagents (Hugging Face) ────────────────────────────────────────────

    def patch_smolagents(self) -> bool:
        """Patches smolagents.tools.Tool.__call__."""
        try:
            import smolagents.tools as _mod
            original_call = _mod.Tool.__call__
            instrument = self

            def patched_call(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                import json as _j
                tool_args = kwargs if kwargs else ({"input": str(args[0])} if args else {})
                instrument._check_block(tool_name, tool_args)
                start  = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = original_call(self_tool, *args, **kwargs)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name,
                        input_prompt=str(args[0])[:500] if args else tool_name,
                        arguments=tool_args, result=str(result) if result else None,
                        start_time=start, error=error,
                    )

            _mod.Tool.__call__ = patched_call
            return True
        except Exception as e:
            print(f"[AEGIS] smolagents auto-patch failed: {e}")
            return False

    # ── Pydantic-AI ─────────────────────────────────────────────────────────

    def patch_pydantic_ai(self) -> bool:
        """Patches pydantic_ai.Agent.run + run_sync — traces every tool the
        agent triggers. Pydantic-AI registers tools via @agent.tool; the
        framework dispatches them inside Agent.run, so wrapping Agent.run
        gives us per-tool traces via the inner tool-call hook."""
        try:
            import pydantic_ai as _pa  # type: ignore
            agent_cls = _pa.Agent
            original_run = agent_cls.run
            original_run_sync = getattr(agent_cls, 'run_sync', None)
            instrument = self

            async def patched_run(self_agent, user_prompt: str = '', **kw):
                start = time.time()
                error: Optional[str] = None
                result = None
                tool_name = f"pydantic_ai:{getattr(self_agent, 'name', 'agent')}"
                args = {'user_prompt': str(user_prompt)[:500]}
                await instrument._async_check_block(tool_name, args)
                try:
                    result = await original_run(self_agent, user_prompt, **kw)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(user_prompt)[:500],
                        arguments=args, result=str(result)[:500] if result else None,
                        start_time=start, error=error,
                    )

            def patched_run_sync(self_agent, user_prompt: str = '', **kw):
                start = time.time()
                error: Optional[str] = None
                result = None
                tool_name = f"pydantic_ai:{getattr(self_agent, 'name', 'agent')}"
                args = {'user_prompt': str(user_prompt)[:500]}
                instrument._check_block(tool_name, args)
                try:
                    result = original_run_sync(self_agent, user_prompt, **kw) if original_run_sync else None
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(user_prompt)[:500],
                        arguments=args, result=str(result)[:500] if result else None,
                        start_time=start, error=error,
                    )

            agent_cls.run = patched_run
            if original_run_sync:
                agent_cls.run_sync = patched_run_sync
            return True
        except Exception as e:
            print(f"[AEGIS] Pydantic-AI auto-patch failed: {e}")
            return False

    # ── AutoGen 0.4+ ────────────────────────────────────────────────────────

    def patch_autogen(self) -> bool:
        """Patches autogen_core.tools.BaseTool.run / FunctionTool.run.
        AutoGen 0.4+ standardized tool execution through BaseTool.run, so a
        single hook covers every tool the agent invokes."""
        try:
            import autogen_core.tools as _at  # type: ignore
            target_cls = getattr(_at, 'BaseTool', None) or getattr(_at, 'FunctionTool', None)
            if not target_cls or not hasattr(target_cls, 'run'):
                return False
            original_run = target_cls.run
            instrument = self

            async def patched_run(self_tool, args=None, cancellation_token=None):
                tool_name = getattr(self_tool, 'name', self_tool.__class__.__name__)
                try:
                    args_dict = args.model_dump() if hasattr(args, 'model_dump') else (args or {})
                except Exception:
                    args_dict = {'_raw': str(args)[:500]}
                await instrument._async_check_block(tool_name, args_dict)
                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = await original_run(self_tool, args, cancellation_token)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=tool_name,
                        arguments=args_dict, result=str(result)[:500] if result else None,
                        start_time=start, error=error,
                    )

            target_cls.run = patched_run
            return True
        except Exception as e:
            print(f"[AEGIS] AutoGen auto-patch failed: {e}")
            return False

    # ── LiteLLM (module-level completion + acompletion) ────────────────────

    def patch_litellm(self) -> bool:
        """Patches litellm.completion / litellm.acompletion at the module
        level. LiteLLM routes 100+ providers through one OpenAI-shaped
        API, so a lot of teams sit behind it. Same tool-call handshake
        as our OpenAI patch: intercept tool_calls in the choice, gate
        via _check_block, capture the follow-up tool message to close
        the trace.
        """
        try:
            import litellm  # type: ignore
            original_sync  = getattr(litellm, 'completion',  None)
            original_async = getattr(litellm, 'acompletion', None)
            if not original_sync and not original_async:
                return False
            instrument = self

            def _capture_tool_result(messages):
                """Close pending traces when the follow-up tool message arrives."""
                for msg in messages or []:
                    if msg.get('role') != 'tool':
                        continue
                    tid    = msg.get('tool_call_id')
                    result = msg.get('content', '')
                    with instrument._lock:
                        pending = instrument._pending.pop(tid, None)
                    if pending:
                        instrument._send_trace(
                            tool_name=pending['tool_name'],
                            input_prompt=pending['input_prompt'],
                            arguments=pending['arguments'],
                            result=result,
                            start_time=pending['start_time'],
                            error=None,
                            token_usage=pending.get('token_usage'),
                        )

            def _register_tool_calls(response, messages):
                """Gate + record any tool_calls the LLM emitted."""
                choices = getattr(response, 'choices', None) or []
                if not choices:
                    return
                choice = choices[0]
                finish = getattr(choice, 'finish_reason', None) or (
                    choice.get('finish_reason') if isinstance(choice, dict) else None
                )
                if finish != 'tool_calls':
                    return
                # LiteLLM returns either an OpenAI-style object or a dict.
                message = getattr(choice, 'message', None) or (
                    choice.get('message') if isinstance(choice, dict) else None
                )
                tool_calls = (
                    getattr(message, 'tool_calls', None) or
                    (message.get('tool_calls') if isinstance(message, dict) else None) or []
                )
                last_prompt = next(
                    (m.get('content', '') for m in reversed(messages or [])
                     if m.get('role') == 'user'), ''
                )
                usage = getattr(response, 'usage', None) or (
                    response.get('usage') if isinstance(response, dict) else None
                )
                token_usage = {}
                if usage:
                    token_usage = {
                        'input_tokens':  getattr(usage, 'prompt_tokens', None)
                                         or (usage.get('prompt_tokens') if isinstance(usage, dict) else 0) or 0,
                        'output_tokens': getattr(usage, 'completion_tokens', None)
                                         or (usage.get('completion_tokens') if isinstance(usage, dict) else 0) or 0,
                        'model':         getattr(response, 'model', None)
                                         or (response.get('model') if isinstance(response, dict) else None),
                    }
                import json as _j
                for tc in tool_calls:
                    fn = getattr(tc, 'function', None) or (tc.get('function') if isinstance(tc, dict) else None)
                    if fn is None:
                        continue
                    name = getattr(fn, 'name', None) or (fn.get('name') if isinstance(fn, dict) else None)
                    args_raw = getattr(fn, 'arguments', None) or (fn.get('arguments') if isinstance(fn, dict) else '{}')
                    try:
                        args = _j.loads(args_raw or '{}')
                    except Exception:
                        args = {}
                    tc_id = getattr(tc, 'id', None) or (tc.get('id') if isinstance(tc, dict) else None) or f'tc_{id(tc)}'
                    if name:
                        instrument._check_block(name, args)
                        with instrument._lock:
                            instrument._pending[tc_id] = {
                                'tool_name':    name,
                                'input_prompt': last_prompt or name,
                                'arguments':    args,
                                'start_time':   time.time(),
                                'token_usage':  token_usage,
                            }

            def patched_sync(**kwargs):
                messages = kwargs.get('messages', [])
                _capture_tool_result(messages)
                response = original_sync(**kwargs)
                try:
                    _register_tool_calls(response, messages)
                except Exception as e:
                    print(f'[AEGIS] LiteLLM sync post-hook failed: {e}')
                return response

            async def patched_async(**kwargs):
                messages = kwargs.get('messages', [])
                _capture_tool_result(messages)
                response = await original_async(**kwargs)
                try:
                    _register_tool_calls(response, messages)
                except Exception as e:
                    print(f'[AEGIS] LiteLLM async post-hook failed: {e}')
                return response

            if original_sync:  litellm.completion  = patched_sync
            if original_async: litellm.acompletion = patched_async
            return True
        except Exception as e:
            print(f'[AEGIS] LiteLLM auto-patch failed: {e}')
            return False

    # ── HTTP tool-endpoint interception ───────────────────────────────────
    #
    # Any outbound HTTP call whose URL is on the "known tool endpoint"
    # allow-list (Stripe / Circle / Coinbase / Twilio / Slack / SendGrid /
    # GitHub API / Anthropic + OpenAI proxy paths, etc.) gets gated via
    # _check_block, then a trace is emitted with the tool name we derive
    # from the host + path. Zero code change — patches `requests.request`
    # and `httpx.request` (both sync + async) once at instrument time.
    #
    # Non-tool calls (any URL not on the allow-list) are NEVER
    # intercepted — this can't accidentally wrap the SDK's own POST
    # /traces call.
    #
    # Registry is intentionally small + curated. Extend
    # HTTP_TOOL_ENDPOINTS below to add new sinks.

    def patch_http_tools(self) -> bool:
        """Intercept known tool-provider HTTP endpoints.

        Returns True when at least one HTTP client library was patched.
        Failure is silent per-client — an app using httpx but not
        requests still gets httpx intercepted.
        """
        patched_any = False
        instrument = self

        def _match_tool(url: str, method: str) -> Optional[str]:
            """Return a tool_name if the URL matches a known sink, else None."""
            if not url:
                return None
            u = url.lower()
            for prefix, tool_prefix in HTTP_TOOL_ENDPOINTS.items():
                if u.startswith(prefix):
                    # Derive a compact tool name: <provider>.<verb>.<slug>
                    # e.g. https://api.stripe.com/v1/refunds → stripe.post.v1_refunds
                    path = u[len(prefix):].split('?')[0].strip('/')
                    slug = path.replace('/', '_')[:40] or 'root'
                    return f'{tool_prefix}.{method.lower()}.{slug}'
            return None

        # requests
        try:
            import requests  # type: ignore
            original = requests.Session.request
            def patched_request(self_sess, method, url, **kwargs):
                tool_name = _match_tool(url, method)
                if tool_name is None:
                    return original(self_sess, method, url, **kwargs)
                args = {
                    'method': method,
                    'url':    url,
                    'params': kwargs.get('params'),
                    'json':   kwargs.get('json'),
                    'data':   kwargs.get('data'),
                }
                instrument._check_block(tool_name, args)
                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = original(self_sess, method, url, **kwargs)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=url,
                        arguments=args,
                        result=f'HTTP {getattr(result, "status_code", "?")}' if result else None,
                        start_time=start, error=error,
                    )
            requests.Session.request = patched_request
            patched_any = True
        except Exception as e:
            if _debug_env():
                print(f'[AEGIS] requests HTTP-tool patch skipped: {e}')

        # httpx (sync + async)
        try:
            import httpx  # type: ignore
            orig_sync  = httpx.Client.request
            orig_async = httpx.AsyncClient.request

            def patched_httpx_sync(self_c, method, url, **kwargs):
                tool_name = _match_tool(str(url), method)
                if tool_name is None:
                    return orig_sync(self_c, method, url, **kwargs)
                args = {'method': method, 'url': str(url), 'params': kwargs.get('params'),
                        'json': kwargs.get('json'), 'content': str(kwargs.get('content', ''))[:400]}
                instrument._check_block(tool_name, args)
                start = time.time()
                try:
                    r = orig_sync(self_c, method, url, **kwargs)
                    return r
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(url),
                        arguments=args, result=None,
                        start_time=start, error=None,
                    )

            async def patched_httpx_async(self_c, method, url, **kwargs):
                tool_name = _match_tool(str(url), method)
                if tool_name is None:
                    return await orig_async(self_c, method, url, **kwargs)
                args = {'method': method, 'url': str(url), 'params': kwargs.get('params'),
                        'json': kwargs.get('json'), 'content': str(kwargs.get('content', ''))[:400]}
                await instrument._async_check_block(tool_name, args)
                start = time.time()
                try:
                    r = await orig_async(self_c, method, url, **kwargs)
                    return r
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=str(url),
                        arguments=args, result=None,
                        start_time=start, error=None,
                    )

            httpx.Client.request      = patched_httpx_sync
            httpx.AsyncClient.request = patched_httpx_async
            patched_any = True
        except Exception as e:
            if _debug_env():
                print(f'[AEGIS] httpx HTTP-tool patch skipped: {e}')

        return patched_any

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
