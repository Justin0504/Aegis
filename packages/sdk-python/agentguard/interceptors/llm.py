"""Interceptor for capturing LLM API calls."""

import functools
import json
from typing import Any, Callable, Dict, Optional, List
import time
import inspect
from datetime import datetime, timezone


class LLMInterceptor:
    """Captures LLM API calls (OpenAI, Anthropic, etc.)."""

    def __init__(self, context_reporter: Any = None, session_id: Optional[str] = None):
        self.captured_calls: List[Dict[str, Any]] = []
        # Instruction provenance. The messages array passed to every model
        # call already contains the whole conversation, so the channel
        # split the gateway needs can be derived here with nothing extra
        # for the host application to instrument. Absent reporter =>
        # nothing is sent and provenance rules stay inert.
        self._context_reporter = context_reporter
        self._session_id = session_id

    def set_context_reporter(self, reporter: Any, session_id: Optional[str] = None) -> None:
        self._context_reporter = reporter
        if session_id:
            self._session_id = session_id

    def _report_context(self, kwargs: Dict[str, Any]) -> None:
        """Derive and report trust channels from an outgoing model call.

        Wrapped in a blanket except on purpose: this runs inside the
        caller's LLM request path, and a telemetry bug must never be able
        to fail someone's agent. The cost of swallowing is that provenance
        degrades to `unknown`, which is the fail-soft direction.
        """
        reporter = self._context_reporter
        if reporter is None or not self._session_id:
            return
        try:
            messages = kwargs.get("messages")
            if messages:
                reporter.report_messages(self._session_id, messages)
        except Exception:  # noqa: BLE001
            pass

    def patch_openai(self):
        """Monkey-patch OpenAI client to capture calls."""
        try:
            import openai

            # Patch the newer OpenAI client (v1.0+)
            if hasattr(openai, "OpenAI"):
                self._patch_openai_v1()
            else:
                # Legacy client
                self._patch_openai_legacy()

        except ImportError:
            pass

    def patch_anthropic(self):
        """Monkey-patch Anthropic client to capture calls."""
        try:
            import anthropic

            interceptor = self
            original_create = anthropic.resources.Messages.create

            @functools.wraps(original_create)
            def wrapped_create(client_self, *args, **kwargs):
                start_time = time.time()
                interceptor._report_context(kwargs)
                call_data = {
                    "provider": "anthropic",
                    "method": "messages.create",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "kwargs": interceptor._sanitize_kwargs(kwargs),
                }

                try:
                    result = original_create(client_self, *args, **kwargs)
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = True
                    call_data["response"] = interceptor._extract_anthropic_response(result)
                except Exception as e:
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = False
                    call_data["error"] = str(e)
                    raise
                finally:
                    interceptor.captured_calls.append(call_data)

                return result

            anthropic.resources.Messages.create = wrapped_create

        except ImportError:
            pass

    def _patch_openai_v1(self):
        """Patch OpenAI v1.0+ client."""
        import openai

        interceptor = self
        # Patch chat completions
        original_create = openai.resources.chat.completions.Completions.create

        @functools.wraps(original_create)
        def wrapped_create(self, *args, **kwargs):
            start_time = time.time()
            interceptor._report_context(kwargs)
            call_data = {
                "provider": "openai",
                "method": "chat.completions.create",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "args": args,
                "kwargs": interceptor._sanitize_kwargs(kwargs),
            }

            try:
                result = original_create(self, *args, **kwargs)
                call_data["duration_ms"] = (time.time() - start_time) * 1000
                call_data["success"] = True
                call_data["response"] = interceptor._extract_openai_response(result)
            except Exception as e:
                call_data["duration_ms"] = (time.time() - start_time) * 1000
                call_data["success"] = False
                call_data["error"] = str(e)
                raise
            finally:
                interceptor.captured_calls.append(call_data)

            return result

        openai.resources.chat.completions.Completions.create = wrapped_create

    def _patch_openai_legacy(self):
        """Patch legacy OpenAI client."""
        import openai

        original_create = openai.ChatCompletion.create
        interceptor = self

        @functools.wraps(original_create)
        def wrapped_create(*args, **kwargs):
            start_time = time.time()
            interceptor._report_context(kwargs)
            call_data = {
                "provider": "openai",
                "method": "ChatCompletion.create",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "args": args,
                "kwargs": self._sanitize_kwargs(kwargs),
            }

            try:
                result = original_create(*args, **kwargs)
                call_data["duration_ms"] = (time.time() - start_time) * 1000
                call_data["success"] = True
                call_data["response"] = self._extract_openai_response(result)
            except Exception as e:
                call_data["duration_ms"] = (time.time() - start_time) * 1000
                call_data["success"] = False
                call_data["error"] = str(e)
                raise
            finally:
                self.captured_calls.append(call_data)

            return result

        openai.ChatCompletion.create = wrapped_create

    def _sanitize_kwargs(self, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """Remove sensitive information from kwargs."""
        sanitized = kwargs.copy()

        # Remove API keys and sensitive headers
        sensitive_keys = {"api_key", "api_base", "headers", "auth"}
        for key in sensitive_keys:
            if key in sanitized:
                sanitized[key] = "[REDACTED]"

        return sanitized

    def _extract_openai_response(self, response: Any) -> Dict[str, Any]:
        """Extract relevant data from OpenAI response."""
        try:
            if hasattr(response, "model_dump"):
                # New client
                data = response.model_dump()
            else:
                # Legacy client
                data = response.to_dict() if hasattr(response, "to_dict") else dict(response)

            # Extract key information
            return {
                "model": data.get("model"),
                "usage": data.get("usage"),
                "choices": [
                    {
                        "message": choice.get("message"),
                        "finish_reason": choice.get("finish_reason"),
                    }
                    for choice in data.get("choices", [])
                ],
            }
        except Exception:
            return {"raw_response": str(response)}

    def _extract_anthropic_response(self, response: Any) -> Dict[str, Any]:
        """Extract relevant data from Anthropic response."""
        try:
            return {
                "model": getattr(response, "model", None),
                "usage": {
                    "input_tokens": getattr(response, "usage", {}).get("input_tokens"),
                    "output_tokens": getattr(response, "usage", {}).get("output_tokens"),
                },
                "content": getattr(response, "content", []),
                "stop_reason": getattr(response, "stop_reason", None),
            }
        except Exception:
            return {"raw_response": str(response)}

    def patch_langchain(self):
        """Monkey-patch LangChain LLM invoke calls."""
        try:
            from langchain_core.language_models.base import BaseLanguageModel

            interceptor = self
            original_invoke = BaseLanguageModel.invoke

            @functools.wraps(original_invoke)
            def wrapped_invoke(client_self, input, *args, **kwargs):
                start_time = time.time()
                call_data = {
                    "provider": "langchain",
                    "method": f"{type(client_self).__name__}.invoke",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "kwargs": interceptor._sanitize_kwargs(kwargs),
                }

                try:
                    result = original_invoke(client_self, input, *args, **kwargs)
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = True
                    call_data["response"] = {"content": getattr(result, "content", str(result))}
                except Exception as e:
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = False
                    call_data["error"] = str(e)
                    raise
                finally:
                    interceptor.captured_calls.append(call_data)

                return result

            BaseLanguageModel.invoke = wrapped_invoke

        except ImportError:
            pass

    def patch_claude_agent_sdk(self):
        """Monkey-patch Claude Agent SDK (claude_agent_sdk) calls."""
        try:
            import claude_agent_sdk

            interceptor = self
            original_run = claude_agent_sdk.run

            @functools.wraps(original_run)
            def wrapped_run(*args, **kwargs):
                start_time = time.time()
                call_data = {
                    "provider": "claude_agent_sdk",
                    "method": "run",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "kwargs": interceptor._sanitize_kwargs(kwargs),
                }

                try:
                    result = original_run(*args, **kwargs)
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = True
                    call_data["response"] = {"result": str(result)[:500]}
                except Exception as e:
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = False
                    call_data["error"] = str(e)
                    raise
                finally:
                    interceptor.captured_calls.append(call_data)

                return result

            claude_agent_sdk.run = wrapped_run

        except (ImportError, AttributeError):
            # claude_agent_sdk >= 0.1 exposes query()/ClaudeSDKClient, not run();
            # the supported integration is the PreToolUse hook in
            # agentguard.integrations.claude_agent_sdk. Never let a missing
            # attribute take down auto() for every other framework.
            pass

    def clear_captured_calls(self):
        """Clear captured calls."""
        self.captured_calls.clear()

    def get_captured_calls(self) -> List[Dict[str, Any]]:
        """Get all captured calls."""
        return self.captured_calls.copy()