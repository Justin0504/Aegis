"""Trust-channel classification of agent context.

The gateway decides whether a tool call was authorised by the principal
or only by something that crossed the trust boundary. It can only do that
if it knows which is which, and the SDK is the only component positioned
to tell it: the whole conversation passes through the model call the SDK
already intercepts.
"""

from .channels import ContextSpan, derive_spans
from .reporter import ContextReporter

__all__ = ["ContextSpan", "derive_spans", "ContextReporter"]
