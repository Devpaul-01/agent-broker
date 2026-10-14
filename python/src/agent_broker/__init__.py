"""Agent Broker — Redis-coordinated admission control for independent agent processes.

This is the Python implementation, a genuine port (not a Node.js wrapper) of the TypeScript
Agent Broker library in this same repository. See ``docs/python-port/`` at the repository root
for the architecture, feature-parity status, and implementation plan.

Public API, as of Milestone 1 (package foundation only — coordination logic lands in later
milestones per ``docs/python-port/IMPLEMENTATION_PLAN.md``):

- ``parse_config`` / ``BrokerOptions`` / ``ResolvedConfig`` / ``CircuitBreakerOptions`` /
  ``BrokerHooks`` — configuration.
- ``BrokerConfigError`` / ``BrokerArgumentError`` / ``BrokerError`` — error classes.
- ``keys`` — Redis key construction (importable as ``agent_broker.keys``), part of the
  cross-language shared protocol.

``create_broker`` (the top-level factory tying coordination logic together, mirroring
``createBroker`` in the TS package) is intentionally not exported yet — it depends on modules
not implemented until Milestone 4.
"""

from __future__ import annotations

from . import keys as keys
from .config import (
    BrokerHooks,
    BrokerOptions,
    CircuitBreakerOptions,
    ResolvedCircuitBreakerConfig,
    ResolvedConfig,
    parse_config,
)
from .errors import BrokerArgumentError, BrokerConfigError, BrokerError

__all__ = [
    "BrokerArgumentError",
    "BrokerConfigError",
    "BrokerError",
    "BrokerHooks",
    "BrokerOptions",
    "CircuitBreakerOptions",
    "ResolvedCircuitBreakerConfig",
    "ResolvedConfig",
    "keys",
    "parse_config",
]

__version__ = "0.1.0"
