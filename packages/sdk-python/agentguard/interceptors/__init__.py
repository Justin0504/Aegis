"""Interceptors for capturing agent behavior."""

from .stdio import StdioInterceptor
from .llm import LLMInterceptor

__all__ = ["StdioInterceptor", "LLMInterceptor"]