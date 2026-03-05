"""Main AgentGuard tracer implementation."""

import asyncio
import functools
import json
import time
import traceback
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from uuid import UUID, uuid4

from agentguard_core_schema import (
    AgentActionTrace,
    CreateTraceRequest,
    InputContext,
    Observation,
    ThoughtChain,
    ToolCall,
    calculate_trace_hash,
)

from .config import AgentGuardConfig
from ..crypto import SigningService, load_private_key
from ..interceptors import LLMInterceptor, StdioInterceptor
from ..transport import TransportService
from ..telemetry import TelemetryService


class TraceContext:
    """Context for a single trace operation."""

    def __init__(
        self,
        trace_id: UUID,
        parent_trace_id: Optional[UUID] = None,
        sequence_number: int = 0,
    ):
        self.trace_id = trace_id
        self.parent_trace_id = parent_trace_id
        self.sequence_number = sequence_number
        self.start_time = time.time()
        self.captured_stdout: Optional[str] = None
        self.captured_stderr: Optional[str] = None
        self.captured_llm_calls: List[Dict[str, Any]] = []
        self.exception: Optional[Exception] = None


class AgentGuard:
    """Main class for AgentGuard SDK."""

    def __init__(self, config: Optional[AgentGuardConfig] = None):
        self.config = config or self._load_default_config()
        self._sequence_counter = 0
        self._previous_hash: Optional[str] = None
        self._trace_stack: List[TraceContext] = []

        # Initialize components
        self._signing_service = self._init_signing_service()
        self._transport = TransportService(self.config)
        self._telemetry = TelemetryService(self.config)
        self._llm_interceptor = LLMInterceptor()

        # Apply patches
        if self.config.capture_llm_calls:
            self._llm_interceptor.patch_openai()
            self._llm_interceptor.patch_anthropic()
            self._llm_interceptor.patch_langchain()
            self._llm_interceptor.patch_claude_agent_sdk()

        # Start background workers
        if self.config.enable_async:
            self._start_background_workers()

    def _load_default_config(self) -> AgentGuardConfig:
        """Load default configuration."""
        # Try to load from environment or config file
        agent_id = os.environ.get("AGENTGUARD_AGENT_ID", str(uuid4()))
        gateway_url = os.environ.get("AGENTGUARD_GATEWAY_URL", "http://localhost:8080")

        return AgentGuardConfig(
            agent_id=agent_id,
            gateway_url=gateway_url,
        )

    def _init_signing_service(self) -> Optional[SigningService]:
        """Initialize signing service if enabled."""
        if not self.config.enable_signing or not self.config.private_key_path:
            return None

        try:
            private_key = load_private_key(
                Path(self.config.private_key_path),
                self.config.private_key_password.get_secret_value()
                if self.config.private_key_password
                else None,
            )
            return SigningService(private_key)
        except Exception as e:
            print(f"Warning: Failed to load signing key: {e}")
            return None

    def _start_background_workers(self):
        """Start background workers for async processing."""
        # This would start the transport service's background queue processor
        pass

    def trace(
        self,
        func: Optional[Callable] = None,
        *,
        tool_name: Optional[str] = None,
        capture_thought_chain: bool = True,
    ):
        """
        Decorator to trace function execution.

        Usage:
            @agent_guard.trace()
            def my_function():
                pass

            @agent_guard.trace(tool_name="custom_tool")
            def another_function():
                pass
        """
        def decorator(f: Callable) -> Callable:
            actual_tool_name = tool_name or f.__name__

            @functools.wraps(f)
            def sync_wrapper(*args, **kwargs):
                with self._create_trace_context() as ctx:
                    return self._execute_traced_function(
                        f, ctx, actual_tool_name, capture_thought_chain, *args, **kwargs
                    )

            @functools.wraps(f)
            async def async_wrapper(*args, **kwargs):
                with self._create_trace_context() as ctx:
                    return await self._execute_traced_function_async(
                        f, ctx, actual_tool_name, capture_thought_chain, *args, **kwargs
                    )

            return async_wrapper if asyncio.iscoroutinefunction(f) else sync_wrapper

        return decorator if func is None else decorator(func)

    @contextmanager
    def _create_trace_context(self):
        """Create a new trace context."""
        parent_id = self._trace_stack[-1].trace_id if self._trace_stack else None
        ctx = TraceContext(
            trace_id=uuid4(),
            parent_trace_id=parent_id,
            sequence_number=self._sequence_counter,
        )
        self._sequence_counter += 1

        self._trace_stack.append(ctx)
        try:
            yield ctx
        finally:
            self._trace_stack.pop()

    def _execute_traced_function(
        self,
        func: Callable,
        ctx: TraceContext,
        tool_name: str,
        capture_thought_chain: bool,
        *args,
        **kwargs,
    ) -> Any:
        """Execute a function with tracing."""
        # Clear LLM interceptor
        if self.config.capture_llm_calls:
            self._llm_interceptor.clear_captured_calls()

        # Capture input context
        input_context = self._capture_input_context(func, args, kwargs)

        # Start capturing stdout/stderr
        if self.config.capture_stdout or self.config.capture_stderr:
            with StdioInterceptor.capture() as (stdout_io, stderr_io):
                try:
                    # Execute the function
                    result = func(*args, **kwargs)

                    # Capture output
                    ctx.captured_stdout, ctx.captured_stderr = StdioInterceptor.get_captured_output(
                        stdout_io, stderr_io
                    )

                except Exception as e:
                    ctx.exception = e
                    ctx.captured_stdout, ctx.captured_stderr = StdioInterceptor.get_captured_output(
                        stdout_io, stderr_io
                    )
                    raise
        else:
            try:
                result = func(*args, **kwargs)
            except Exception as e:
                ctx.exception = e
                raise

        # Capture LLM calls
        if self.config.capture_llm_calls:
            ctx.captured_llm_calls = self._llm_interceptor.get_captured_calls()

        # Create and send trace
        duration_ms = (time.time() - ctx.start_time) * 1000
        self._create_and_send_trace(
            ctx, tool_name, input_context, result, duration_ms, capture_thought_chain
        )

        return result

    async def _execute_traced_function_async(
        self,
        func: Callable,
        ctx: TraceContext,
        tool_name: str,
        capture_thought_chain: bool,
        *args,
        **kwargs,
    ) -> Any:
        """Execute an async function with tracing."""
        # Similar to sync version but with await
        # (Implementation omitted for brevity - follows same pattern)
        pass

    def _capture_input_context(
        self, func: Callable, args: tuple, kwargs: dict
    ) -> InputContext:
        """Capture input context from function arguments."""
        # Extract prompt from args/kwargs
        prompt = self._extract_prompt(func, args, kwargs)

        return InputContext(
            prompt=prompt,
            system_context={
                "function": func.__name__,
                "module": func.__module__,
                "args_count": len(args),
                "kwargs_keys": list(kwargs.keys()),
            },
        )

    def _extract_prompt(self, func: Callable, args: tuple, kwargs: dict) -> str:
        """Extract prompt from function arguments."""
        # Look for common parameter names
        prompt_params = ["prompt", "message", "query", "input", "question"]

        # Check kwargs first
        for param in prompt_params:
            if param in kwargs:
                return str(kwargs[param])

        # Check positional args if we can map them
        try:
            import inspect

            sig = inspect.signature(func)
            params = list(sig.parameters.keys())

            for i, (param_name, arg_value) in enumerate(zip(params, args)):
                if param_name in prompt_params:
                    return str(arg_value)
        except Exception:
            pass

        # Default: concatenate all string args
        str_args = [str(arg) for arg in args if isinstance(arg, (str, int, float))]
        return " ".join(str_args) if str_args else "No prompt captured"

    def _create_and_send_trace(
        self,
        ctx: TraceContext,
        tool_name: str,
        input_context: InputContext,
        result: Any,
        duration_ms: float,
        capture_thought_chain: bool,
    ):
        """Create and send a trace."""
        # Create thought chain
        thought_chain = self._create_thought_chain(ctx, capture_thought_chain)

        # Create tool call
        tool_call = ToolCall(
            tool_name=tool_name,
            function=tool_name,
            arguments={},  # Could be enhanced to capture actual args
            timestamp=datetime.utcnow(),
        )

        # Create observation
        observation = Observation(
            raw_output=result,
            error=str(ctx.exception) if ctx.exception else None,
            duration_ms=duration_ms,
            metadata={
                "stdout": ctx.captured_stdout,
                "stderr": ctx.captured_stderr,
                "llm_calls": len(ctx.captured_llm_calls),
            },
        )

        # Create trace request
        trace_request = CreateTraceRequest(
            agent_id=UUID(self.config.agent_id) if self._is_valid_uuid(self.config.agent_id) else uuid4(),
            parent_trace_id=ctx.parent_trace_id,
            sequence_number=ctx.sequence_number,
            input_context=input_context,
            thought_chain=thought_chain,
            tool_call=tool_call,
            observation=observation,
            previous_hash=self._previous_hash,
            environment=self.config.environment,
        )

        # Calculate hash and create full trace
        trace_dict = trace_request.model_dump()
        trace_dict["trace_id"] = str(ctx.trace_id)
        integrity_hash = calculate_trace_hash(trace_dict)

        # Create full trace
        trace = AgentActionTrace(
            **trace_request.model_dump(),
            trace_id=ctx.trace_id,
            integrity_hash=integrity_hash,
        )

        # Sign if enabled
        if self._signing_service:
            trace_bytes = json.dumps(trace.model_dump(), sort_keys=True).encode()
            trace.signature = self._signing_service.sign(trace_bytes)

        # Send trace
        self._transport.send_trace(trace)

        # Update previous hash
        self._previous_hash = integrity_hash

        # Record telemetry
        self._telemetry.record_trace(trace)

    # ── @guard.tool — shorthand decorator, no arguments needed ───────────

    @property
    def tool(self):
        """
        Shorthand decorator — uses the function name as tool_name automatically.

        Usage:
            @guard.tool                    # instead of @guard.trace(tool_name="web_search")
            def web_search(query): ...
        """
        def decorator(f: Callable) -> Callable:
            return self.trace(f, tool_name=f.__name__)
        return decorator

    # ── guard.tools — class decorator, traces every public method ─────────

    def tools(self, cls):
        """
        Class decorator — traces all public methods automatically.

        Usage:
            @guard.tools
            class MyTools:
                def web_search(self, query): ...
                def execute_sql(self, sql): ...

            t = MyTools()
            t.web_search(query="hello")  # auto-traced
        """
        import inspect
        for name, method in inspect.getmembers(cls, predicate=inspect.isfunction):
            if not name.startswith("_"):
                setattr(cls, name, self.trace(method, tool_name=name))
        return cls

    # ── guard.watch(locals()) — scan a namespace and wrap in-place ────────

    def watch(self, namespace: Dict[str, Any]) -> Dict[str, Callable]:
        """
        Scan a namespace (dict of names→values) and wrap all callables in-place.
        Returns a new dict with all callables traced.

        Usage:
            def web_search(query): ...
            def execute_sql(sql): ...

            # At the end of your tool definitions:
            tool_fn = guard.watch(locals())

            # tool_fn now has all callables traced, ready to use
        """
        wrapped: Dict[str, Callable] = {}
        for name, obj in namespace.items():
            if callable(obj) and not name.startswith("_") and not isinstance(obj, type):
                wrapped[name] = self.trace(obj, tool_name=name)
            else:
                wrapped[name] = obj
        return wrapped

    # ── wrap_tools — wrap an explicit dict ────────────────────────────────

    def wrap_tools(self, tool_dict: Dict[str, Callable]) -> Dict[str, Callable]:
        """
        Wrap a dict of tool functions with tracing — no decorators needed.

        Usage:
            tools = guard.wrap_tools({
                "web_search":  web_search,
                "execute_sql": execute_sql,
            })
        """
        return {
            name: self.trace(fn, tool_name=name)
            for name, fn in tool_dict.items()
        }

    def _is_valid_uuid(self, value: str) -> bool:
        try:
            UUID(value)
            return True
        except ValueError:
            return False

    def _create_thought_chain(
        self, ctx: TraceContext, capture_thought_chain: bool
    ) -> ThoughtChain:
        """Create thought chain from captured data."""
        raw_tokens = ""

        if capture_thought_chain and ctx.captured_llm_calls:
            # Extract reasoning from LLM calls
            for call in ctx.captured_llm_calls:
                if call.get("success") and "response" in call:
                    choices = call["response"].get("choices", [])
                    for choice in choices:
                        message = choice.get("message", {})
                        content = message.get("content", "")
                        raw_tokens += content + "\n"

        return ThoughtChain(
            raw_tokens=raw_tokens or "No thought chain captured",
            parsed_steps=[],
            confidence_score=None,
        )


# Import os at module level
import os