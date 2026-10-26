"""
Auto-instrumentation: patches Anthropic/OpenAI at SDK level.
Zero user code changes required. Supports both sync and async APIs.
"""

import os
from collections import OrderedDict
import time
import asyncio
import threading
import urllib.request
import urllib.error
import json as _json_mod
from datetime import datetime, timezone
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


# Receipts of allowed calls, by (tool, arguments) key, kept for the executor
# to fetch right after the check (agentguard.receipt_for). Bounded.
_RECEIPTS: "OrderedDict[str, str]" = OrderedDict()
_RECEIPTS_MAX = 256


def receipt_for(tool_name: str, arguments: Any) -> Optional[str]:
    """The gateway's signed receipt for the most recent allow of this exact
    call, or None. Verify with agentguard.receipts.verify_receipt."""
    key = AutoInstrument._decision_key(tool_name, arguments)
    return _RECEIPTS.get(key)


def _build_identity_headers(cfg, guard=None) -> Dict[str, str]:
    """
    Header set that pins agent identity on every gateway call.

      x-api-key                        — tenant key (config or env)
      x-aegis-agent-id                 — this SDK instance's agent UUID
      x-aegis-agent-secret             — when the agent is registered with a secret
      x-aegis-session-id               — optional cross-call correlation
      x-aegis-workflow-node-id         — Phase 1.3 workflow anchor (if guard
                                         has an active workflow_scope())
      x-aegis-workflow-binding-id      — Phase 1.3 workflow anchor (ditto)

    `guard` is optional to preserve the pre-Phase-1.3 callsite contract.
    When present, we read the top of its workflow stack so DSL rules
    written against `workflow.node_id` fire on the corresponding
    `/check` and `/llm-proxy/*` calls without the user threading state
    manually.
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

    # Phase 1.3 / 4a — workflow anchors on the innermost active scope.
    # Read defensively: guard is optional, the stack is optional, and
    # stack entries are (node_id, binding_id) tuples where either may
    # be None. A bad shape must not break the header build.
    if guard is not None:
        try:
            stack = getattr(guard, "_workflow_stack", None) or []
            if stack:
                node_id, binding_id = stack[-1]
                if node_id:
                    headers["x-aegis-workflow-node-id"] = str(node_id)
                if binding_id:
                    headers["x-aegis-workflow-binding-id"] = str(binding_id)
        except Exception:
            # Header attachment is best-effort — never fail a gateway
            # call because workflow context couldn't be read.
            pass
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
        # Gateway decisions keyed by (tool, args), consumed by _send_trace so
        # every decision — allow, block, hold and its resolution — is written
        # into the trace's safety_validation / approval_status, not only into
        # the gateway's violations table. "Every decision becomes a trace."
        self._decisions: Dict[str, Dict[str, Any]] = {}
        # Instruction provenance (§2.3 of the paper). The request-side hook:
        # every patched model call hands its messages array here, the
        # spans are classified by trust channel and the new ones are
        # posted to /api/v1/context, so that by the time the response's
        # tool_use reaches /check the gateway knows which turn could have
        # authorised it. This reporter existed in the legacy
        # LLMInterceptor and was never wired into auto(); the S4 row of
        # the compatibility matrix found that the ledger stayed empty on
        # every path, and the provenance pack never fired.
        from ..context.reporter import ContextReporter
        # Late-bound so a host (or a test) can replace _post_context after
        # construction and the reporter follows.
        self._context_reporter = ContextReporter(lambda path, payload: self._post_context(path, payload))

    # ── Instruction provenance: request-side hook ───────────────────────────

    def _session_id(self) -> Optional[str]:
        cfg = self._guard.config
        return getattr(cfg, "session_id", None) or os.environ.get("AEGIS_SESSION_ID") or None

    def _post_context(self, path: str, payload: Dict[str, Any]) -> None:
        """Small, synchronous, short timeout: it runs on the model-call
        path. Failure raises into the reporter, which swallows it and lets
        provenance degrade to `unknown` rather than fail the agent."""
        cfg = self._guard.config
        req = urllib.request.Request(
            f"{cfg.gateway_url.rstrip('/')}{path}",
            data=_json_mod.dumps(payload).encode(),
            headers=_build_identity_headers(cfg, self._guard),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            resp.read()

    def _report_context(self, messages: Any) -> int:
        """Report the trust channels of an outgoing model call. Never raises."""
        sid = self._session_id()
        if not sid or not messages:
            return 0
        try:
            agent_id = self._guard.config.agent_id or str(self._guard._agent_uuid)
            return self._context_reporter.report_messages(sid, messages, agent_id)
        except Exception:  # noqa: BLE001
            return 0

    @staticmethod
    def _messages_from_contents(contents: Any) -> Any:
        """google-genai takes `contents`: a string, or a list of Content
        objects / dicts with role + parts. A bare string is the principal."""
        if isinstance(contents, str):
            return [{"role": "user", "content": contents}]
        return contents

    # ── Shared payload builder ──────────────────────────────────────────────

    def _build_check_payload(self, tool_name: str, arguments: dict) -> bytes:
        cfg = self._guard.config
        agent_id = self._guard.config.agent_id or str(self._guard._agent_uuid)
        payload: Dict[str, Any] = {
            "agent_id":                agent_id,
            "tool_name":               tool_name,
            "arguments":               arguments,
            "environment":             getattr(cfg, 'environment', 'DEVELOPMENT'),
            "blocking":                True,
            "user_category_overrides": getattr(cfg, 'tool_categories', {}),
        }
        # The ledger is keyed by session; without this the gateway cannot
        # find the context the request-side hook reported.
        sid = self._session_id()
        if sid:
            payload["session_id"] = sid
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

    @staticmethod
    def _decision_key(tool_name: str, arguments: Any) -> str:
        try:
            return f"{tool_name}|{_json_mod.dumps(arguments, sort_keys=True, default=str)}"
        except Exception:
            return f"{tool_name}|{arguments!r}"

    def _note_decision(self, tool_name: str, arguments: Any, result: dict) -> None:
        decision = result.get("decision", "allow")
        self._decisions[self._decision_key(tool_name, arguments)] = {
            "passed":     decision != "block",
            "risk_level": result.get("risk_level", "LOW"),
            "approval":   {"allow": "AUTO_APPROVED", "pending": "PENDING_APPROVAL"}.get(decision, "REJECTED"),
            "reason":     result.get("reason") if decision in ("block", "pending") else None,
            "check_id":   result.get("check_id"),
            # The gateway's signed proof that it allowed this call; an executor
            # verifies it with agentguard.receipts.verify_receipt.
            "receipt":    result.get("receipt"),
            # Who decided: the gateway's /check, or a refusal made before it
            # (the MCP proxy's tool pin), which the gateway counts separately.
            "policy":     result.get("policy_name") or "gateway",
        }
        if result.get("receipt"):
            _RECEIPTS[self._decision_key(tool_name, arguments)] = result["receipt"]

    def _resolve_hold(self, tool_name: str, approved: bool, reason: Optional[str], receipt: Optional[str] = None) -> None:
        for key, d in self._decisions.items():
            if key.startswith(tool_name + "|") and d.get("approval") == "PENDING_APPROVAL":
                d["approval"] = "APPROVED" if approved else "REJECTED"
                d["passed"] = approved
                d["reason"] = None if approved else reason
                if receipt:
                    d["receipt"] = receipt
                    _RECEIPTS[key] = receipt

    def _pop_decision(self, tool_name: str, arguments: Any):
        d = self._decisions.pop(self._decision_key(tool_name, arguments), None)
        if not d:
            return None, None
        from agentguard_core_schema import SafetyValidation
        sv = SafetyValidation(policy_name=d.get("policy", "gateway"), passed=bool(d["passed"]),
                              violations=[d["reason"]] if d.get("reason") else None,
                              risk_level=d.get("risk_level") if d.get("risk_level") in ("LOW", "MEDIUM", "HIGH", "CRITICAL") else "LOW",
                              check_id=d.get("check_id"), receipt=d.get("receipt"))
        return sv, d.get("approval")

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
                headers=_build_identity_headers(cfg, self._guard),
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                result = _json_mod.loads(resp.read())
            self._note_decision(tool_name, arguments, result)

            risk_level = result.get("risk_level", "LOW")
            category   = result.get("category", "unknown")

            # Category allow-list — e.g. allow_categories=["network"]
            if self._should_skip_by_category(category):
                print(f"[AEGIS] ⬜ '{tool_name}' ({category}) in allow_categories — skipped")
                return

            # Threshold check — below threshold → audit only, don't block.
            # The threshold is a precision control over the gateway's
            # risk-level verdicts; it must never override an explicit
            # policy decision. A `pending` is a person's turn to decide,
            # whatever the risk tier, and a `block` from a DSL rule is the
            # operator's own rule. Before this guard, a LOW-risk hold was
            # returned as allow: the tool ran, the agent never waited, and
            # the approval queue filled with decisions nobody was waiting
            # for — every S3 row of the compatibility matrix "held" a call
            # that had already executed (found 2026-10-13).
            explicit = result.get("decision") == "pending" or bool(result.get("dsl"))
            if not self._is_above_threshold(risk_level) and not explicit:
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
                    headers=_build_identity_headers(self._guard.config, self._guard),
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    result = _json_mod.loads(resp.read())
                decision = result.get("decision", "pending")

                if decision == "allow":
                    print(f"[AEGIS] ✅ '{tool_name}' approved by {result.get('decided_by', 'human')}")
                    self._resolve_hold(tool_name, True, None, result.get("receipt"))
                    return
                if decision == "block":
                    self._resolve_hold(tool_name, False, "Rejected by human reviewer")
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

        self._resolve_hold(tool_name, False, f"Human approval timed out after {timeout_s}s")
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
                    headers=_build_identity_headers(cfg, self._guard),
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                    return _json_mod.loads(resp.read())

            result = await loop.run_in_executor(None, _do_check)
            self._note_decision(tool_name, arguments, result)

            risk_level = result.get("risk_level", "LOW")
            category   = result.get("category", "unknown")

            if self._should_skip_by_category(category):
                print(f"[AEGIS] ⬜ '{tool_name}' ({category}) in allow_categories — skipped")
                return

            # The threshold is a precision control over the gateway's
            # risk-level verdicts; it must never override an explicit
            # policy decision. A `pending` is a person's turn to decide,
            # whatever the risk tier, and a `block` from a DSL rule is the
            # operator's own rule. Before this guard, a LOW-risk hold was
            # returned as allow: the tool ran, the agent never waited, and
            # the approval queue filled with decisions nobody was waiting
            # for — every S3 row of the compatibility matrix "held" a call
            # that had already executed (found 2026-10-13).
            explicit = result.get("decision") == "pending" or bool(result.get("dsl"))
            if not self._is_above_threshold(risk_level) and not explicit:
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
                        headers=_build_identity_headers(self._guard.config, self._guard),
                        method="GET",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        return _json_mod.loads(resp.read())

                result   = await loop.run_in_executor(None, _do_poll)
                decision = result.get("decision", "pending")

                if decision == "allow":
                    print(f"[AEGIS] ✅ '{tool_name}' approved by {result.get('decided_by', 'human')}")
                    self._resolve_hold(tool_name, True, None, result.get("receipt"))
                    return
                if decision == "block":
                    self._resolve_hold(tool_name, False, "Rejected by human reviewer")
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

        self._resolve_hold(tool_name, False, f"Human approval timed out after {timeout_s}s")
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
                self._model_check(block.name, args)
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
                await self._async_model_check(block.name, args)
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
                instrument._report_context(messages)
                response = original(self_msg, **kwargs)
                if kwargs.get("stream"):
                    return instrument._wrap_anthropic_stream(response, instrument._extract_last_prompt(messages), is_async=False)
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

    # ── Anthropic beta endpoint: request-side provenance only ──────────────

    def patch_anthropic_beta_context(self) -> bool:
        """`client.beta.messages.create` is a separate resource from
        `client.messages.create`, and frameworks call it directly —
        Pydantic AI does, for every request. The tool-level patch still
        decides those calls, but without this hook their conversation never
        reached the context ledger, so the provenance layer had nothing to
        assess and every S4 call through Pydantic AI was decided without it
        (found 2026-10-13). This patch only reports context; it registers
        no tool_use and blocks nothing, because enforcement for those
        frameworks happens at the tool."""
        try:
            import anthropic.resources.beta.messages.messages as _mod
        except Exception:
            try:
                import anthropic.resources.beta.messages as _mod  # older layout
            except Exception:
                return False
        instrument = self
        ok = False
        if hasattr(_mod, "Messages"):
            original = _mod.Messages.create

            def patched_beta_create(self_msg, *args, **kwargs):
                instrument._report_context(kwargs.get("messages", []))
                return original(self_msg, *args, **kwargs)
            _mod.Messages.create = patched_beta_create
            ok = True
        if hasattr(_mod, "AsyncMessages"):
            original_async = _mod.AsyncMessages.create

            async def patched_beta_async_create(self_msg, *args, **kwargs):
                instrument._report_context(kwargs.get("messages", []))
                return await original_async(self_msg, *args, **kwargs)
            _mod.AsyncMessages.create = patched_beta_async_create
            ok = True
        return ok

    # ── Anthropic async ─────────────────────────────────────────────────────

    def patch_anthropic_async(self) -> bool:
        try:
            import anthropic.resources.messages as _mod
            original_async = _mod.AsyncMessages.create
            instrument     = self

            async def patched_async_create(self_msg, **kwargs):
                messages = kwargs.get("messages", [])
                instrument._collect_tool_results_anthropic(messages)
                instrument._report_context(messages)
                response = await original_async(self_msg, **kwargs)
                if kwargs.get("stream"):
                    return instrument._wrap_anthropic_stream(response, instrument._extract_last_prompt(messages), is_async=True)
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

                instrument._report_context(messages)
                response = original(self_comp, **kwargs)
                if kwargs.get("stream"):
                    lp = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
                    return instrument._wrap_openai_stream(response, lp if isinstance(lp, str) else "", is_async=False)
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
                        instrument._model_check(tc.function.name, args)
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




    # ── model-level enforcement switch ────────────────────────────────────────
    def _model_check(self, tool_name: str, arguments: dict) -> None:
        """Blocking check at the model boundary. With enforce_at="tool" the
        model-level patches only observe and the framework's tool-level patch
        (LangGraph, CrewAI, AutoGen, LlamaIndex, smolagents, Pydantic AI)
        enforces, returning the refusal as the tool's own result."""
        if getattr(self._guard.config, "enforce_at", "response") == "tool":
            return
        self._model_check(tool_name, arguments)

    async def _async_model_check(self, tool_name: str, arguments: dict) -> None:
        if getattr(self._guard.config, "enforce_at", "response") == "tool":
            return
        await self._async_model_check(tool_name, arguments)

    # ── streaming support for the Anthropic patches ───────────────────────────
    def _wrap_anthropic_stream(self, stream, last_prompt: str, is_async: bool):
        """messages.create(stream=True) yields events; tool_use blocks arrive as
        content_block_start + input_json_delta fragments. Yield events unchanged,
        assemble the calls, and run the blocking check at message_stop — before
        the application dispatches any tool."""
        instrument = self
        import json as _j
        blocks: dict = {}

        def _accumulate(ev):
            et = getattr(ev, "type", None)
            if et == "content_block_start":
                cb = getattr(ev, "content_block", None)
                if getattr(cb, "type", None) == "tool_use":
                    blocks[ev.index] = {"id": cb.id, "name": cb.name, "json": ""}
            elif et == "content_block_delta":
                d = getattr(ev, "delta", None)
                if getattr(d, "type", None) == "input_json_delta" and ev.index in blocks:
                    blocks[ev.index]["json"] += d.partial_json or ""

        def _parsed():
            for b in blocks.values():
                try:
                    args = _j.loads(b["json"] or "{}")
                except Exception:
                    args = {}
                yield b, args

        def _register(b, args):
            with instrument._lock:
                instrument._pending[b["id"]] = {"tool_name": b["name"], "input_prompt": last_prompt or b["name"],
                                                "arguments": args, "start_time": time.time(), "token_usage": {}}

        if is_async:
            async def agen():
                async for ev in stream:
                    _accumulate(ev)
                    yield ev
                for b, args in _parsed():
                    await instrument._async_model_check(b["name"], args)
                    _register(b, args)
            return agen()

        def gen():
            for ev in stream:
                _accumulate(ev)
                yield ev
            for b, args in _parsed():
                instrument._model_check(b["name"], args)
                _register(b, args)
        return gen()

    # ── streaming support for the OpenAI chat patches ─────────────────────────
    def _wrap_openai_stream(self, stream, last_prompt: str, is_async: bool):
        """Yield chunks unchanged, accumulate tool_call fragments, and run the
        blocking check once the stream ends — the framework only dispatches
        tools after the last chunk, so a block raised here still precedes
        execution."""
        instrument = self
        import json as _j
        calls: dict = {}

        def _accumulate(chunk):
            try:
                delta = chunk.choices[0].delta if chunk.choices else None
            except Exception:
                return
            for tc in (getattr(delta, "tool_calls", None) or []):
                slot = calls.setdefault(tc.index, {"id": None, "name": "", "args": ""})
                if getattr(tc, "id", None):
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    if getattr(fn, "name", None):
                        slot["name"] += fn.name
                    if getattr(fn, "arguments", None):
                        slot["args"] += fn.arguments

        def _finish_sync():
            for slot in calls.values():
                try:
                    args = _j.loads(slot["args"] or "{}")
                except Exception:
                    args = {}
                instrument._model_check(slot["name"], args)
                with instrument._lock:
                    instrument._pending[slot["id"]] = {"tool_name": slot["name"], "input_prompt": last_prompt or slot["name"],
                                                       "arguments": args, "start_time": time.time(), "token_usage": {}}

        async def _finish_async():
            for slot in calls.values():
                try:
                    args = _j.loads(slot["args"] or "{}")
                except Exception:
                    args = {}
                await instrument._async_model_check(slot["name"], args)
                with instrument._lock:
                    instrument._pending[slot["id"]] = {"tool_name": slot["name"], "input_prompt": last_prompt or slot["name"],
                                                       "arguments": args, "start_time": time.time(), "token_usage": {}}

        if is_async:
            async def agen():
                async for chunk in stream:
                    _accumulate(chunk)
                    yield chunk
                await _finish_async()
            return agen()

        def gen():
            for chunk in stream:
                _accumulate(chunk)
                yield chunk
            _finish_sync()
        return gen()

    # ── OpenAI Agents SDK: tool-level patch via the function_tool decorator ──
    def patch_openai_agents(self) -> bool:
        """Wraps agents.function_tool so every FunctionTool it creates runs the
        gateway check in on_invoke_tool and returns the refusal as the tool's
        output. The Responses/chat patches see the same call at the model
        boundary; with enforce_at="tool" they only observe and this enforces,
        which is what lets the Agents SDK deliver the refusal in-band."""
        try:
            import agents as _ag  # type: ignore
            import agents.tool as _at  # type: ignore
        except Exception as e:
            print(f"[AEGIS] OpenAI Agents auto-patch skipped: {e}")
            return False
        instrument = self
        import json as _j
        original = _at.function_tool

        def _guard(tool):
            orig_invoke = tool.on_invoke_tool

            async def guarded(ctx, input_json):
                try:
                    args = _j.loads(input_json or "{}")
                except Exception:
                    args = {"input": str(input_json)}
                try:
                    await instrument._async_check_block(tool.name, args)
                except AgentGuardBlockedError as e:
                    return f"[AEGIS] Tool call blocked before execution: {e}"
                return await orig_invoke(ctx, input_json)
            try:
                tool.on_invoke_tool = guarded
            except Exception:
                object.__setattr__(tool, "on_invoke_tool", guarded)
            return tool

        def patched_function_tool(func=None, **kwargs):
            if func is None:
                deco = original(**kwargs)
                return lambda f: _guard(deco(f))
            return _guard(original(func, **kwargs))

        _at.function_tool = patched_function_tool
        if getattr(_ag, "function_tool", None) is original:
            _ag.function_tool = patched_function_tool
        return True

    # ── Google GenAI (google-genai, the current SDK) ─────────────────────────
    def patch_google_genai(self) -> bool:
        """Patches google.genai Models.generate_content / AsyncModels.generate_content.
        A tool call is a Part with `function_call` (name, args) on the first
        candidate; the legacy google.generativeai patch does not see this client."""
        try:
            import google.genai.models as _mod  # type: ignore
        except Exception as e:
            print(f"[AEGIS] google-genai auto-patch skipped: {e}")
            return False
        instrument = self

        def _calls(response):
            try:
                parts = response.candidates[0].content.parts or []
            except Exception:
                return []
            out = []
            for part in parts:
                fc = getattr(part, "function_call", None)
                if fc is not None and getattr(fc, "name", None):
                    out.append((fc.name, dict(fc.args or {})))
            return out

        def _prompt(kwargs):
            c = kwargs.get("contents")
            if isinstance(c, str):
                return c[:500]
            try:
                last = c[-1]
                txt = " ".join(getattr(p, "text", "") or "" for p in getattr(last, "parts", []) or [])
                return txt[:500]
            except Exception:
                return ""

        def _register(response, last_prompt):
            for name, args in _calls(response):
                with instrument._lock:
                    instrument._pending[f"genai:{name}:{time.time()}"] = {
                        "tool_name": name, "input_prompt": last_prompt or name, "arguments": args,
                        "start_time": time.time(), "token_usage": {},
                    }

        ok = False
        try:
            original = _mod.Models.generate_content

            def patched(self_m, *args, **kwargs):
                instrument._report_context(instrument._messages_from_contents(kwargs.get("contents")))
                response = original(self_m, *args, **kwargs)
                for name, fargs in _calls(response):
                    instrument._model_check(name, fargs)
                _register(response, _prompt(kwargs))
                return response
            _mod.Models.generate_content = patched
            ok = True
        except Exception as e:
            print(f"[AEGIS] google-genai sync auto-patch failed: {e}")
        try:
            original_async = _mod.AsyncModels.generate_content

            async def patched_async(self_m, *args, **kwargs):
                instrument._report_context(instrument._messages_from_contents(kwargs.get("contents")))
                response = await original_async(self_m, *args, **kwargs)
                for name, fargs in _calls(response):
                    await instrument._async_model_check(name, fargs)
                _register(response, _prompt(kwargs))
                return response
            _mod.AsyncModels.generate_content = patched_async
            ok = True
        except Exception as e:
            print(f"[AEGIS] google-genai async auto-patch failed: {e}")
        return ok

    # ── OpenAI Responses API (used by the OpenAI Agents SDK) ─────────────────
    def patch_openai_responses(self) -> bool:
        """Patches openai.resources.responses.Responses.create / AsyncResponses.create.

        The Agents SDK talks to the Responses API by default; a tool call
        arrives as an output item of type `function_call` (name, arguments,
        call_id) and its result comes back as an input item of type
        `function_call_output` (call_id, output). The compatibility matrix
        showed the chat-completions patch alone leaves this path unguarded."""
        try:
            import openai.resources.responses as _mod  # type: ignore
        except Exception as e:
            print(f"[AEGIS] OpenAI Responses auto-patch skipped: {e}")
            return False
        instrument = self
        import json as _j

        def _collect_results(kwargs):
            inp = kwargs.get("input")
            if not isinstance(inp, list):
                return
            for item in inp:
                if isinstance(item, dict) and item.get("type") == "function_call_output":
                    cid = item.get("call_id")
                    with instrument._lock:
                        pending = instrument._pending.pop(cid, None)
                    if pending:
                        instrument._send_trace(
                            tool_name=pending["tool_name"], input_prompt=pending["input_prompt"],
                            arguments=pending["arguments"], result=item.get("output", ""),
                            start_time=pending["start_time"], error=None,
                            token_usage=pending.get("token_usage"),
                        )

        def _last_prompt(kwargs):
            inp = kwargs.get("input")
            if isinstance(inp, str):
                return inp
            if isinstance(inp, list):
                for item in reversed(inp):
                    if isinstance(item, dict) and item.get("role") == "user":
                        c = item.get("content")
                        return c if isinstance(c, str) else _j.dumps(c)[:500]
            return ""

        def _calls(response):
            for item in getattr(response, "output", None) or []:
                if getattr(item, "type", None) == "function_call":
                    try:
                        args = _j.loads(getattr(item, "arguments", "") or "{}")
                    except Exception:
                        args = {}
                    yield item, args

        def _register(response, last_prompt):
            usage = getattr(response, "usage", None)
            token_usage = {"input_tokens": getattr(usage, "input_tokens", 0),
                           "output_tokens": getattr(usage, "output_tokens", 0),
                           "model": getattr(response, "model", None)} if usage else {}
            for item, args in _calls(response):
                with instrument._lock:
                    instrument._pending[getattr(item, "call_id", None) or item.id] = {
                        "tool_name": item.name, "input_prompt": last_prompt or item.name,
                        "arguments": args, "start_time": time.time(), "token_usage": token_usage,
                    }

        ok = False
        try:
            original = _mod.Responses.create

            def patched_create(self_r, **kwargs):
                _collect_results(kwargs)
                instrument._report_context(instrument._messages_from_contents(kwargs.get("input")))
                response = original(self_r, **kwargs)
                for item, args in _calls(response):
                    instrument._model_check(item.name, args)
                _register(response, _last_prompt(kwargs))
                return response
            _mod.Responses.create = patched_create
            ok = True
        except Exception as e:
            print(f"[AEGIS] OpenAI Responses sync auto-patch failed: {e}")
        try:
            original_async = _mod.AsyncResponses.create

            async def patched_async_create(self_r, **kwargs):
                _collect_results(kwargs)
                instrument._report_context(instrument._messages_from_contents(kwargs.get("input")))
                response = await original_async(self_r, **kwargs)
                for item, args in _calls(response):
                    await instrument._async_model_check(item.name, args)
                _register(response, _last_prompt(kwargs))
                return response
            _mod.AsyncResponses.create = patched_async_create
            ok = True
        except Exception as e:
            print(f"[AEGIS] OpenAI Responses async auto-patch failed: {e}")
        return ok

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

                instrument._report_context(messages)
                response = await original_async(self_comp, **kwargs)
                if kwargs.get("stream"):
                    lp = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
                    return instrument._wrap_openai_stream(response, lp if isinstance(lp, str) else "", is_async=True)
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
                        await instrument._async_model_check(tc.function.name, args)
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
                    # LangGraph's ToolNode invokes with the ToolCall envelope
                    # ({name, args, id, type: "tool_call"}); the call's
                    # arguments are inside `args`, which is what policies match on.
                    args = input.get("args") if input.get("type") == "tool_call" and isinstance(input.get("args"), dict) else input
                    input_str = _j.dumps(args)
                else:
                    input_str = str(input)
                    args = {"input": input_str}

                try:
                    instrument._check_block(tool_name, args)
                except AgentGuardBlockedError as e:
                    # LangGraph's ToolNode converts ToolException into an error
                    # ToolMessage the model sees — the in-band refusal.
                    from langchain_core.tools import ToolException
                    raise ToolException(str(e)) from e
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
                    # LangGraph's ToolNode invokes with the ToolCall envelope
                    # ({name, args, id, type: "tool_call"}); the call's
                    # arguments are inside `args`, which is what policies match on.
                    args = input.get("args") if input.get("type") == "tool_call" and isinstance(input.get("args"), dict) else input
                    input_str = _j.dumps(args)
                else:
                    input_str = str(input)
                    args = {"input": input_str}

                try:
                    await instrument._async_check_block(tool_name, args)
                except AgentGuardBlockedError as e:
                    from langchain_core.tools import ToolException
                    raise ToolException(str(e)) from e
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
        # CrewAI >= 1.0 runs tools through CrewStructuredTool.invoke(input=…)
        try:
            import crewai.tools.structured_tool as _st  # type: ignore
            _orig_invoke = _st.CrewStructuredTool.invoke
            _instr = self

            def _patched_invoke(self_tool, input, config=None, **kwargs):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                if isinstance(input, dict):
                    args = input
                else:
                    try:
                        import json as _j
                        args = _j.loads(input) if isinstance(input, str) else {"input": str(input)}
                    except Exception:
                        args = {"input": str(input)}
                try:
                    _instr._check_block(tool_name, args)
                except AgentGuardBlockedError as e:
                    return f"[AEGIS] Tool call blocked before execution: {e}"
                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = _orig_invoke(self_tool, input, config, **kwargs)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    _instr._send_trace(tool_name=tool_name, input_prompt=tool_name, arguments=args,
                                       result=str(result)[:500] if result is not None else None,
                                       start_time=start, error=error)
            _st.CrewStructuredTool.invoke = _patched_invoke
        except Exception as e:
            print(f"[AEGIS] CrewAI structured-tool auto-patch skipped: {e}")
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

                try:
                    instrument._check_block(tool_name, tool_args)
                except AgentGuardBlockedError as e:
                    # CrewAI feeds a tool's return value to the model: the refusal
                    # goes back in the slot the result would have occupied.
                    return f"[AEGIS] Tool call blocked before execution: {e}"
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
            # The @tool decorator builds crewai.tools.base_tool.Tool, which
            # overrides run(); patch it too or the executor path bypasses us.
            _tool_cls = getattr(_mod, "Tool", None)
            if _tool_cls is not None and "run" in _tool_cls.__dict__:
                _orig_tool_run = _tool_cls.run

                def patched_tool_run(self_tool, *args, **kwargs):
                    tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                    tool_args = dict(kwargs) if kwargs else ({"input": str(args[0])} if args else {})
                    try:
                        instrument._check_block(tool_name, tool_args)
                    except AgentGuardBlockedError as e:
                        return f"[AEGIS] Tool call blocked before execution: {e}"
                    start = time.time()
                    error: Optional[str] = None
                    result = None
                    try:
                        result = _orig_tool_run(self_tool, *args, **kwargs)
                        return result
                    except Exception as e:
                        error = str(e); raise
                    finally:
                        instrument._send_trace(tool_name=tool_name, input_prompt=tool_name, arguments=tool_args,
                                               result=str(result)[:500] if result is not None else None,
                                               start_time=start, error=error)
                _tool_cls.run = patched_tool_run
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
                instrument._report_context(messages)
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
                    instrument._report_context(messages)
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
            original_call = getattr(_mod.FunctionTool, '_call', None) or _mod.FunctionTool.call
            instrument = self

            def patched_call(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool.metadata, "name", self_tool.__class__.__name__)
                tool_args = {"args": str(args)[:200], **kwargs}
                try:
                    instrument._check_block(tool_name, tool_args)
                except AgentGuardBlockedError as e:
                    from llama_index.core.tools.types import ToolOutput
                    return ToolOutput(content=f"[AEGIS] Tool call blocked before execution: {e}", tool_name=tool_name,
                                      raw_input=tool_args, raw_output=None, is_error=True)
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

            setattr(_mod.FunctionTool, '_call' if hasattr(_mod.FunctionTool, '_call') else 'call', patched_call)
            patched_any = True
        except Exception as e:
            print(f"[AEGIS] LlamaIndex sync auto-patch failed: {e}")

        try:
            import llama_index.core.tools.function_tool as _mod
            original_acall = getattr(_mod.FunctionTool, '_acall', None) or _mod.FunctionTool.acall
            instrument = self

            async def patched_acall(self_tool, *args, **kwargs):
                tool_name = getattr(self_tool.metadata, "name", self_tool.__class__.__name__)
                tool_args = {"args": str(args)[:200], **kwargs}
                try:
                    await instrument._async_check_block(tool_name, tool_args)
                except AgentGuardBlockedError as e:
                    from llama_index.core.tools.types import ToolOutput
                    return ToolOutput(content=f"[AEGIS] Tool call blocked before execution: {e}", tool_name=tool_name,
                                      raw_input=tool_args, raw_output=None, is_error=True)
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

            setattr(_mod.FunctionTool, '_acall' if hasattr(_mod.FunctionTool, '_acall') else 'acall', patched_acall)
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
        """Patches the toolset dispatch (FunctionToolset.call_tool) so the
        gateway sees the TOOL call — name and arguments — not the user prompt.

        Earlier versions wrapped Agent.run and sent the prompt as if it were
        a tool argument, which both mis-identified the tool (`pydantic_ai:…`)
        and scanned the wrong text; the compatibility matrix caught it."""
        try:
            import pydantic_ai.toolsets.function as _fn  # type: ignore
            toolset_cls = _fn.FunctionToolset
            original_call = toolset_cls.call_tool
            instrument = self

            async def patched_call_tool(self_ts, name, tool_args, ctx, tool):
                args = dict(tool_args) if isinstance(tool_args, dict) else {"input": str(tool_args)}
                try:
                    await instrument._async_check_block(name, args)
                except AgentGuardBlockedError as e:
                    return f"[AEGIS] Tool call blocked before execution: {e}"
                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = await original_call(self_ts, name, tool_args, ctx, tool)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=name, input_prompt=name, arguments=args,
                        result=str(result)[:500] if result is not None else None,
                        start_time=start, error=error,
                    )
            toolset_cls.call_tool = patched_call_tool
            return True
        except Exception as e:
            print(f"[AEGIS] Pydantic-AI auto-patch failed: {e}")
            return False

    # ── AutoGen 0.4+ ────────────────────────────────────────────────────────

    def patch_autogen(self) -> bool:
        """Patches autogen_core.tools.BaseTool.run_json — the entry point
        autogen-agentchat calls. (FunctionTool overrides `run`, so a patch
        on BaseTool.run never fired; the compatibility matrix showed it.)
        A block is returned as the tool's result, in-band."""
        try:
            import autogen_core.tools as _at  # type: ignore
            base = _at.BaseTool
            original_run_json = base.run_json
            instrument = self

            async def patched_run_json(self_tool, args, cancellation_token, call_id=None):
                tool_name = getattr(self_tool, "name", self_tool.__class__.__name__)
                args_dict = dict(args) if isinstance(args, dict) else {"input": str(args)}
                try:
                    await instrument._async_check_block(tool_name, args_dict)
                except AgentGuardBlockedError as e:
                    return f"[AEGIS] Tool call blocked before execution: {e}"
                start = time.time()
                error: Optional[str] = None
                result = None
                try:
                    result = await original_run_json(self_tool, args, cancellation_token, call_id)
                    return result
                except Exception as e:
                    error = str(e); raise
                finally:
                    instrument._send_trace(
                        tool_name=tool_name, input_prompt=tool_name, arguments=args_dict,
                        result=str(result)[:500] if result is not None else None,
                        start_time=start, error=error,
                    )
            base.run_json = patched_run_json
            return True
        except Exception as e:
            print(f"[AEGIS] AutoGen auto-patch failed: {e}")
            return False

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
                        instrument._model_check(name, args)
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
                instrument._report_context(messages)
                response = original_sync(**kwargs)
                try:
                    _register_tool_calls(response, messages)
                except Exception as e:
                    print(f'[AEGIS] LiteLLM sync post-hook failed: {e}')
                return response

            async def patched_async(**kwargs):
                messages = kwargs.get('messages', [])
                _capture_tool_result(messages)
                instrument._report_context(messages)
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

        # Defensive exclusion — the AEGIS SDK's own transport uses
        # httpx to POST /api/v1/traces to the gateway. That URL must
        # NEVER match the tool allowlist (it wouldn't today, since
        # gateway URLs are usually `http://localhost` or an internal
        # host that isn't on HTTP_TOOL_ENDPOINTS, but future misuse
        # like a customer routing traces through `api.stripe.com` as
        # a proxy would cause infinite recursion). We compare the URL
        # prefix directly against the configured gateway_url.
        gateway_prefix = ''
        try:
            gw = getattr(self._guard.config, 'gateway_url', None)
            if isinstance(gw, str):
                gateway_prefix = gw.rstrip('/').lower()
        except Exception:
            gateway_prefix = ''

        def _match_tool(url: str, method: str) -> Optional[str]:
            """Return a tool_name if the URL matches a known sink, else None."""
            if not url:
                return None
            u = url.lower()
            # Never intercept the SDK's own gateway traffic — this
            # is the recursion guard mentioned above.
            if gateway_prefix and u.startswith(gateway_prefix):
                return None
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
            now         = datetime.now(timezone.utc)
            ctx_id      = uuid4()
            cfg         = self._guard.config
            agent_id    = self._guard._agent_uuid
            if not self._guard._chain_resumed:
                self._guard.resume_chain()   # continue the agent's chain across restarts

            obs_metadata: dict = {}
            if token_usage:
                obs_metadata["token_usage"] = token_usage

            safety_validation, approval_status = self._pop_decision(tool_name, arguments)
            trace_request = CreateTraceRequest(
                agent_id=agent_id,
                sequence_number=self._guard._sequence_counter,
                safety_validation=safety_validation,
                approval_status=approval_status,
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

            # Beside the schema's UUID, the operator's name for the agent —
            # the identity /check, policies and the Cockpit key on — so the
            # gateway registers one agent, not a name and a UUID.
            trace_dict = trace.model_dump(mode="json")
            session_id = getattr(cfg, 'session_id', None)
            if session_id:
                trace_dict['session_id'] = session_id
            name = cfg.agent_id if cfg.agent_id and cfg.agent_id != str(self._guard._agent_uuid) else None
            if name:
                trace_dict['agent_name'] = name
            self._guard._transport.send_trace_dict(trace_dict)

            self._guard._previous_hash = integrity_hash

        except Exception as e:
            print(f"[AEGIS] Failed to send auto-trace: {e}")
