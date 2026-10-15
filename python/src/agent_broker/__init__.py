"""Agent Broker — Redis-coordinated admission control for independent agent processes.

This is the Python implementation, a genuine port (not a Node.js wrapper) of the TypeScript
Agent Broker library in this same repository. See ``docs/python-port/`` at the repository root
for the architecture, feature-parity status, and implementation plan.

Public API, as of Milestone 2 (core coordination — the shared Redis protocol surface;
delegation/queue-mode/hooks-as-a-public-concept/the top-level ``create_broker`` factory land in
Milestones 3-4 per ``docs/python-port/IMPLEMENTATION_PLAN.md``):

- ``parse_config`` / ``BrokerOptions`` / ``ResolvedConfig`` / ``CircuitBreakerOptions`` /
  ``BrokerHooks`` — configuration.
- ``BrokerConfigError`` / ``BrokerArgumentError`` / ``BrokerError`` — error classes.
- ``keys`` — Redis key construction (importable as ``agent_broker.keys``), part of the
  cross-language shared protocol.
- ``request_permission`` / ``RequestPermissionInput`` / ``Admitted`` / ``Denied`` — core
  admission (``agent_broker.admission``).
- ``resolve_reservation`` / ``ResolveParams`` / ``ResolveOutcome`` / ``ResolveSkipped`` —
  reservation resolution (``agent_broker.resolution``).
- ``sweep_expired_reservations`` — lazy cleanup, called automatically by ``request_permission``
  (``agent_broker.cleanup``).
- ``register_root`` / ``RegisterRootInput`` / ``RootAgent`` — root agent registration
  (``agent_broker.agents``). Child/delegated-agent registration lands in Milestone 3.

``create_broker`` (the top-level factory tying every module together, mirroring ``createBroker``
in the TS package) is intentionally not exported yet — it depends on modules not implemented
until Milestone 4 (queue mode, hooks wiring, the remaining public surface).
"""

from __future__ import annotations

from . import keys as keys
from .admission import Admitted, Denied, RequestPermissionInput, request_permission
from .agents import RegisterRootInput, RegisterRootResult, RootAgent, register_root
from .cleanup import sweep_expired_reservations
from .config import (
    BrokerHooks,
    BrokerOptions,
    CircuitBreakerOptions,
    ResolvedCircuitBreakerConfig,
    ResolvedConfig,
    parse_config,
)
from .errors import BrokerArgumentError, BrokerConfigError, BrokerError
from .resolution import ResolveOutcome, ResolveParams, ResolveSkipped, resolve_reservation

__all__ = [
    "Admitted",
    "BrokerArgumentError",
    "BrokerConfigError",
    "BrokerError",
    "BrokerHooks",
    "BrokerOptions",
    "CircuitBreakerOptions",
    "Denied",
    "RegisterRootInput",
    "RegisterRootResult",
    "ResolveOutcome",
    "ResolveParams",
    "ResolveSkipped",
    "ResolvedCircuitBreakerConfig",
    "ResolvedConfig",
    "RequestPermissionInput",
    "RootAgent",
    "keys",
    "parse_config",
    "register_root",
    "request_permission",
    "resolve_reservation",
    "sweep_expired_reservations",
]

__version__ = "0.1.0"
