"""AgentGuard: High-integrity auditing system for AI Agents."""

import os
from .core.tracer import AgentGuard
from .core.config import AgentGuardConfig
from .interceptors.auto import AgentGuardBlockedError
from typing import Optional

# Lazy default instance (only created on first use)
_default_guard: Optional[AgentGuard] = None


def _get_default_guard() -> AgentGuard:
    global _default_guard
    if _default_guard is None:
        _default_guard = AgentGuard()
    return _default_guard


def trace(func=None, *, tool_name=None, **kwargs):
    """Module-level trace decorator using the default guard instance."""
    return _get_default_guard().trace(func, tool_name=tool_name, **kwargs)


def wrap_tools(tool_dict: dict) -> dict:
    """Wrap a dict of tool functions with tracing."""
    return _get_default_guard().wrap_tools(tool_dict)


def watch(namespace: dict) -> dict:
    """
    Scan a namespace and wrap all callables with tracing in-place.

    Usage:
        def web_search(query): ...
        def execute_sql(sql): ...
        tool_fn = agentguard.watch(locals())
    """
    return _get_default_guard().watch(namespace)


def patch(
    gateway_url: str = "http://localhost:8080",
    agent_id: Optional[str] = None,
    enable_signing: bool = False,
) -> AgentGuard:
    """
    One-liner setup — patches the default guard and returns it.

    Usage:
        import agentguard
        guard = agentguard.patch("http://localhost:8080", agent_id="my-agent")
        tools = guard.wrap_tools({"search": my_search_fn})
    """
    from uuid import uuid4
    global _default_guard

    config = AgentGuardConfig(
        agent_id=agent_id or str(uuid4()),
        gateway_url=gateway_url,
        enable_signing=enable_signing,
    )
    _default_guard = AgentGuard(config)
    return _default_guard


def dev(
    port: int = 8080,
    db_path: str = ":memory:",
    background: bool = False,
    quiet: bool = False,
):
    """
    Start an in-process AEGIS dev gateway — zero docker, zero setup.

    Usage:
        import agentguard
        agentguard.dev(background=True)          # non-blocking
        agentguard.auto("http://localhost:8080")  # then instrument
    """
    from .dev_server import start
    return start(port=port, db_path=db_path, background=background, quiet=quiet)


def auto(
    gateway_url: str = "http://localhost:8080",
    agent_id: Optional[str] = None,
    blocking_mode: bool = False,
    fail_open: bool = True,
    blocking_timeout_ms: int = 3000,
    human_approval_timeout_s: int = 300,
    poll_interval_s: float = 2.0,
    session_id: Optional[str] = None,
    tool_categories: Optional[dict] = None,
    # ── Precision controls ─────────────────────────────────────────────────
    block_threshold: str = "HIGH",
    enforce_at: str = "response",
    allow_tools: Optional[list] = None,
    allow_categories: Optional[list] = None,
    audit_only: bool = False,
) -> AgentGuard:
    """
    Fully automatic instrumentation — zero code changes to your agent.

    Patches Anthropic and OpenAI SDK at the message level:
    - Detects tool_use/tool_calls in LLM responses
    - Captures tool arguments automatically
    - Captures tool results from the next API call
    - Sends complete traces to AEGIS gateway

    Usage:
        import agentguard
        agentguard.auto("http://localhost:8080", agent_id="my-agent")

        # Everything below is UNCHANGED — no decorators, no wrap_tools
        client = anthropic.Anthropic()
        response = client.messages.create(model=..., tools=..., messages=...)
    """
    from uuid import uuid4
    from .interceptors.auto import AutoInstrument
    global _default_guard

    config = AgentGuardConfig(
        agent_id=agent_id or str(uuid4()),
        gateway_url=gateway_url,
        enable_signing=False,
        blocking_mode=blocking_mode,
        fail_open=fail_open,
        blocking_timeout_ms=blocking_timeout_ms,
        human_approval_timeout_s=human_approval_timeout_s,
        poll_interval_s=poll_interval_s,
        # One ledger per process unless the host names its sessions. The
        # request-side provenance hook needs a session to report into, and
        # "two lines" must not mean "two lines plus a session id".
        session_id=session_id or f"auto-{uuid4().hex[:12]}",
        tool_categories=tool_categories or {},
        block_threshold=block_threshold,
        enforce_at=enforce_at,
        allow_tools=allow_tools or [],
        allow_categories=allow_categories or [],
        audit_only=audit_only,
    )
    guard = AgentGuard(config)
    _default_guard = guard

    instrument = AutoInstrument(guard)
    global _default_instrument
    _default_instrument = instrument
    anthropic_ok       = instrument.patch_anthropic()
    anthropic_async_ok = instrument.patch_anthropic_async()
    instrument.patch_anthropic_beta_context()
    openai_ok          = instrument.patch_openai()
    openai_async_ok    = instrument.patch_openai_async()
    openai_responses_ok = instrument.patch_openai_responses()
    google_genai_ok     = instrument.patch_google_genai()
    openai_agents_ok    = instrument.patch_openai_agents()
    langgraph_ok       = instrument.patch_langgraph()
    crewai_ok          = instrument.patch_crewai()
    gemini_ok          = instrument.patch_gemini()
    bedrock_ok         = instrument.patch_bedrock()
    mistral_ok         = instrument.patch_mistral()
    llamaindex_ok      = instrument.patch_llamaindex()
    smolagents_ok      = instrument.patch_smolagents()
    pydantic_ai_ok     = instrument.patch_pydantic_ai()
    autogen_ok         = instrument.patch_autogen()
    litellm_ok         = instrument.patch_litellm()
    http_tools_ok      = instrument.patch_http_tools()

    patched = []
    if anthropic_ok or anthropic_async_ok: patched.append("Anthropic")
    if openai_ok or openai_async_ok:       patched.append("OpenAI")
    if langgraph_ok:                       patched.append("LangGraph")
    if crewai_ok:                          patched.append("CrewAI")
    if gemini_ok:                          patched.append("Gemini")
    if bedrock_ok:                         patched.append("Bedrock")
    if mistral_ok:                         patched.append("Mistral")
    if llamaindex_ok:                      patched.append("LlamaIndex")
    if smolagents_ok:                      patched.append("smolagents")
    if pydantic_ai_ok:                     patched.append("Pydantic-AI")
    if autogen_ok:                         patched.append("AutoGen")
    if litellm_ok:                         patched.append("LiteLLM")
    if http_tools_ok:                      patched.append("HTTP-tools")

    if patched:
        print(f"[AEGIS] Auto-instrumented: {', '.join(patched)} → {gateway_url}")
    else:
        print("[AEGIS] No supported SDK found (install anthropic, openai, langchain-core, or crewai)")

    return guard


# ── Explicit check for stacks without a tool-execution hook ─────────────────
# Plain SDK loops, LiteLLM and the Google GenAI client execute tools in the
# agent's own code, so there is no framework method for auto() to patch at the
# tool. These helpers put the decision in that code with one line:
#
#     agentguard.auto(url, agent_id="ops", blocking_mode=True, enforce_at="tool")
#     execute_tool = agentguard.guarded(execute_tool)   # fn(tool_name, arguments)
#
# A blocked call then returns the refusal as the tool's own result — the
# in-band slot — instead of raising out of the model call.
_default_instrument = None
_REFUSAL_PREFIX = "[AEGIS] Tool call blocked before execution: "


def check(tool_name: str, arguments: dict) -> None:
    """Decide one tool call before it runs.

    Returns on allow (after any human hold is resolved), raises
    ``AgentGuardBlockedError`` on block, human rejection or approval
    timeout. Honours the ``auto()`` configuration: ``blocking_mode``,
    ``fail_open``, ``human_approval_timeout_s`` and the allow-lists.
    """
    if _default_instrument is None:
        raise RuntimeError("agentguard.check() needs agentguard.auto(...) to have run first")
    _default_instrument._check_block(tool_name, dict(arguments or {}))


async def acheck(tool_name: str, arguments: dict) -> None:
    """Async form of :func:`check`."""
    if _default_instrument is None:
        raise RuntimeError("agentguard.acheck() needs agentguard.auto(...) to have run first")
    await _default_instrument._async_check_block(tool_name, dict(arguments or {}))


def refusal(err: "AgentGuardBlockedError") -> str:
    """The in-band refusal text for a blocked call, as the tool-level patches return it."""
    return f"{_REFUSAL_PREFIX}{err.reason}"


def guarded(dispatch, *, tool_name_arg: int = 0, arguments_arg: int = 1):
    """Wrap an agent's tool dispatcher ``dispatch(tool_name, arguments, ...)``.

    The wrapper runs :func:`check` first; on allow it calls ``dispatch``
    unchanged, on block it returns :func:`refusal` so the model sees why
    the tool did not run, in the slot its result would have occupied.
    Works for sync and async dispatchers.
    """
    import asyncio
    import functools

    def _pick(args, kwargs):
        name = args[tool_name_arg] if len(args) > tool_name_arg else kwargs.get("tool_name") or kwargs.get("name")
        arguments = args[arguments_arg] if len(args) > arguments_arg else kwargs.get("arguments") or kwargs.get("args") or {}
        return str(name), arguments

    if asyncio.iscoroutinefunction(dispatch):
        @functools.wraps(dispatch)
        async def _async_wrapper(*args, **kwargs):
            name, arguments = _pick(args, kwargs)
            try:
                await acheck(name, arguments)
            except AgentGuardBlockedError as e:
                return refusal(e)
            return await dispatch(*args, **kwargs)
        return _async_wrapper

    @functools.wraps(dispatch)
    def _wrapper(*args, **kwargs):
        name, arguments = _pick(args, kwargs)
        try:
            check(name, arguments)
        except AgentGuardBlockedError as e:
            return refusal(e)
        return dispatch(*args, **kwargs)
    return _wrapper


# ── Zero-code env-var activation ────────────────────────────────────────────
# Set AGENTGUARD_URL=http://localhost:8080 and agentguard auto-instruments on import.
# No code changes needed — just set env vars.
#
#   AGENTGUARD_URL=http://localhost:8080        required to activate
#   AGENTGUARD_BLOCKING=1                       enable blocking mode (default: off)
#   AGENTGUARD_BLOCK_LEVEL=CRITICAL             threshold: LOW|MEDIUM|HIGH|CRITICAL (default: HIGH)
#   AGENTGUARD_AUDIT_ONLY=1                     log but never block (default: off)
#   AGENTGUARD_ALLOW_TOOLS=fetch_page,crawl_url      tool name allow-list (case-insensitive, comma-sep)
#   AGENTGUARD_ALLOW_CATEGORIES=network,file          category allow-list (comma-separated)
#   AGENTGUARD_AGENT_ID=my-agent                      agent identifier (default: random uuid)
#
_env_url = os.environ.get("AGENTGUARD_URL", "").strip()
if _env_url:
    def _csv(key: str):
        raw = os.environ.get(key, "").strip()
        return [t.strip() for t in raw.split(",") if t.strip()] if raw else []
    auto(
        gateway_url=_env_url,
        agent_id=os.environ.get("AGENTGUARD_AGENT_ID") or None,
        blocking_mode=os.environ.get("AGENTGUARD_BLOCKING", "").lower() in ("1", "true", "yes"),
        block_threshold=os.environ.get("AGENTGUARD_BLOCK_LEVEL", "HIGH"),
        audit_only=os.environ.get("AGENTGUARD_AUDIT_ONLY", "").lower() in ("1", "true", "yes"),
        allow_tools=_csv("AGENTGUARD_ALLOW_TOOLS"),
        allow_categories=_csv("AGENTGUARD_ALLOW_CATEGORIES"),
    )


__all__ = [
    "AgentGuard",
    "AgentGuardConfig",
    "AgentGuardBlockedError",
    "auto",
    "check",
    "acheck",
    "guarded",
    "refusal",
    "dev",
    "patch",
    "trace",
    "watch",
    "wrap_tools",
]

__version__ = "1.2.0"