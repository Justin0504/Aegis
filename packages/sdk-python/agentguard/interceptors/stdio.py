"""Interceptor for capturing stdout and stderr."""

import io
import sys
from contextlib import contextmanager
from typing import Tuple, Optional


class StdioInterceptor:
    """Captures stdout and stderr output."""

    @staticmethod
    @contextmanager
    def capture():
        """Context manager to capture stdout and stderr."""
        old_stdout = sys.stdout
        old_stderr = sys.stderr

        stdout_capture = io.StringIO()
        stderr_capture = io.StringIO()

        try:
            sys.stdout = stdout_capture
            sys.stderr = stderr_capture

            yield stdout_capture, stderr_capture

        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

    @staticmethod
    def get_captured_output(
        stdout_io: io.StringIO,
        stderr_io: io.StringIO
    ) -> Tuple[Optional[str], Optional[str]]:
        """Get captured output from StringIO objects."""
        stdout_value = stdout_io.getvalue()
        stderr_value = stderr_io.getvalue()

        return (
            stdout_value if stdout_value else None,
            stderr_value if stderr_value else None
        )