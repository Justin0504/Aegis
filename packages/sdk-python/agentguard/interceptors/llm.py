"""Interceptor for capturing LLM API calls."""

import functools
import json
from typing import Any, Callable, Dict, Optional, List
import time
import inspect
from datetime import datetime


class LLMInterceptor:
    """Captures LLM API calls (OpenAI, Anthropic, etc.)."""

    def __init__(self):
        self.captured_calls: List[Dict[str, Any]] = []

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

            original_create = anthropic.Anthropic.messages.create

            @functools.wraps(original_create)
            def wrapped_create(self, *args, **kwargs):
                start_time = time.time()
                call_data = {
                    "provider": "anthropic",
                    "method": "messages.create",
                    "timestamp": datetime.utcnow().isoformat(),
                    "args": args,
                    "kwargs": self._sanitize_kwargs(kwargs),
                }

                try:
                    result = original_create(*args, **kwargs)
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = True
                    call_data["response"] = self._extract_anthropic_response(result)
                except Exception as e:
                    call_data["duration_ms"] = (time.time() - start_time) * 1000
                    call_data["success"] = False
                    call_data["error"] = str(e)
                    raise
                finally:
                    self.captured_calls.append(call_data)

                return result

            anthropic.Anthropic.messages.create = wrapped_create

        except ImportError:
            pass

    def _patch_openai_v1(self):
        """Patch OpenAI v1.0+ client."""
        import openai

        # Patch chat completions
        original_create = openai.resources.chat.completions.Completions.create

        @functools.wraps(original_create)
        def wrapped_create(self, *args, **kwargs):
            start_time = time.time()
            call_data = {
                "provider": "openai",
                "method": "chat.completions.create",
                "timestamp": datetime.utcnow().isoformat(),
                "args": args,
                "kwargs": self._sanitize_kwargs(kwargs),
            }

            try:
                result = original_create(self, *args, **kwargs)
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

        openai.resources.chat.completions.Completions.create = wrapped_create

    def _patch_openai_legacy(self):
        """Patch legacy OpenAI client."""
        import openai

        original_create = openai.ChatCompletion.create

        @functools.wraps(original_create)
        def wrapped_create(*args, **kwargs):
            start_time = time.time()
            call_data = {
                "provider": "openai",
                "method": "ChatCompletion.create",
                "timestamp": datetime.utcnow().isoformat(),
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

    def clear_captured_calls(self):
        """Clear captured calls."""
        self.captured_calls.clear()

    def get_captured_calls(self) -> List[Dict[str, Any]]:
        """Get all captured calls."""
        return self.captured_calls.copy()