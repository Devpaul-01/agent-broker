"""Agent Broker — Redis-coordinated admission control for independent agent processes.

This is the Python implementation, a genuine port (not a Node.js wrapper) of the TypeScript
Agent Broker library in this same repository. See ``docs/python-port/`` at the repository root
for the architecture, feature-parity status, and implementation plan.

Public API, as of Milestone 4 — feature-complete relative to the TypeScript library's own
documented public surface (cross-language and adversarial testing, docs, and packaging/release
polish remain for Milestones 5-6 per ``docs/python-port/IMPLEMENTATION_PLAN.md``, but every
operation the TS ``Broker`` interface exposes now has a Python equivalent):

- ``create_broker`` / ``Broker`` — the top-level factory, mirroring ``createBroker`` in the TS
  package (``agent_broker.broker``). The primary way most callers should use this library.
- ``parse_config`` / ``BrokerOptions`` / ``ResolvedConfig`` / ``CircuitBreakerOptions`` /
  ``BrokerHooks`` — configuration, for callers who want the lower-level functions directly
  instead of going through ``Broker``.
- ``BrokerConfigError`` / ``BrokerArgumentError`` / ``BrokerError`` — error classes.
- ``keys`` — Redis key construction (importable as ``agent_broker.keys``), part of the
  cross-language shared protocol.
- ``request_permission`` / ``RequestPermissionInput`` / ``Admitted`` / ``Denied`` — core
  admission (``agent_broker.admission``).
- ``request_permission_queued`` / ``QueueOptions`` — polling admission with backoff, cooperative
  cancellation via ``cancel_event`` (``agent_broker.queue``).
- ``report_outcome`` / ``ReportOutcomeInput`` / ``Resolved`` / ``ReportDenial`` — the public,
  validating wrapper for resolving a reservation (``agent_broker.resolution``).
- ``resolve_reservation`` / ``ResolveParams`` / ``ResolveOutcome`` / ``ResolveSkipped`` — the
  lower-level resolution engine ``report_outcome`` and lazy cleanup both delegate to.
- ``sweep_expired_reservations`` — lazy cleanup, called automatically by ``request_permission``
  (``agent_broker.cleanup``).
- ``register_root`` / ``RegisterRootInput`` / ``RootAgent`` — root agent registration.
- ``register_child`` / ``RegisterChildInput`` / ``ChildAgent`` / ``RegisterDenial`` — delegated
  child agent registration, atomic depth-cap enforcement (``agent_broker.agents``).
- ``deregister`` / ``DeregisterResult`` — immediate agent identity removal.
- ``add_budget`` / ``AddBudgetResult`` / ``AddBudgetDenial`` — budget pool top-up
  (``agent_broker.budget``).
"""

from __future__ import annotations

from . import keys as keys
from .admission import Admitted, Denied, RequestPermissionInput, request_permission
from .agents import (
    ChildAgent,
    DeregisterResult,
    RegisterChildInput,
    RegisterDenial,
    RegisterRootInput,
    RegisterRootResult,
    RootAgent,
    deregister,
    register_child,
    register_root,
)
from .broker import Broker, create_broker
from .budget import AddBudgetDenial, AddBudgetResult, add_budget
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
from .queue import QueueOptions, request_permission_queued
from .resolution import (
    ReportDenial,
    ReportOutcomeInput,
    ResolveOutcome,
    ResolveParams,
    ResolveSkipped,
    Resolved,
    report_outcome,
    resolve_reservation,
)

__all__ = [
    "Admitted",
    "AddBudgetDenial",
    "AddBudgetResult",
    "Broker",
    "BrokerArgumentError",
    "BrokerConfigError",
    "BrokerError",
    "BrokerHooks",
    "BrokerOptions",
    "ChildAgent",
    "CircuitBreakerOptions",
    "Denied",
    "DeregisterResult",
    "QueueOptions",
    "RegisterChildInput",
    "RegisterDenial",
    "RegisterRootInput",
    "RegisterRootResult",
    "ReportDenial",
    "ReportOutcomeInput",
    "ResolveOutcome",
    "ResolveParams",
    "ResolveSkipped",
    "Resolved",
    "ResolvedCircuitBreakerConfig",
    "ResolvedConfig",
    "RequestPermissionInput",
    "RootAgent",
    "add_budget",
    "create_broker",
    "deregister",
    "keys",
    "parse_config",
    "register_child",
    "register_root",
    "report_outcome",
    "request_permission",
    "request_permission_queued",
    "resolve_reservation",
    "sweep_expired_reservations",
]

__version__ = "0.1.0"
