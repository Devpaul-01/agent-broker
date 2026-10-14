"""Error classes for Agent Broker.

Mirrors ``src/errors/index.ts`` in the TypeScript implementation: three distinct exception
types with distinct meanings. Ordinary admission/resolution denials are *not* exceptions in
either language — they are returned as regular result objects (see ``admission.py`` /
``resolution.py``) with a ``reason`` field. These exceptions are reserved for genuine errors:
bad configuration, bad per-call arguments, or a real runtime failure.
"""

from __future__ import annotations


class BrokerConfigError(Exception):
    """Raised by ``create_broker``/``parse_config`` when options are missing or inconsistent.

    Never raised after startup — configuration is validated once and frozen.
    """


class BrokerArgumentError(Exception):
    """Raised when a per-call argument is malformed or forbidden.

    This is distinct from an ordinary denial (e.g. ``{"allowed": False, "reason": "..."}"`):
    a ``BrokerArgumentError`` means the call itself was invalid, not that admission was refused.
    """


class BrokerError(Exception):
    """Raised for a genuine runtime failure (Redis/script failure, unexpected reply shape).

    Never raised for an ordinary denial.
    """
