"""Agent Broker — Redis-coordinated admission control for independent agent processes.

This is the Python implementation, a genuine port (not a Node.js wrapper) of the TypeScript
Agent Broker library in this same repository. See ``docs/python-port/`` at the repository root
for the architecture, feature-parity status, and implementation plan.

The public surface mirrors ``typescript/src/index.ts`` one-to-one:

- ``create_broker`` / ``Broker`` — the factory and the object it returns, with ``register``,
  ``request_permission``, ``report_outcome``, ``deregister`` and ``add_budget``.
- ``BrokerOptions`` / ``BrokerHooks`` (plus ``CircuitBreakerOptions``, which ``BrokerOptions``
  embeds) — configuration.
- ``RegisterRootInput`` / ``RootAgent`` and ``RegisterChildInput`` / ``ChildAgent`` /
  ``RegisterDenial`` / ``RegisterDenialReason`` — agent registration.
- ``RequestPermissionInput`` / ``Admitted`` / ``Denied`` / ``DenialReason`` / ``QueueOptions`` —
  admission, including queue mode.
- ``ReportOutcomeInput`` / ``Resolved`` / ``ReportDenial`` / ``ReportDenialReason`` — resolving
  a reservation.
- ``DeregisterResult`` — agent removal.
- ``AddBudgetResult`` / ``AddBudgetDenial`` / ``AddBudgetDenialReason`` — budget top-up.
- ``BrokerError`` / ``BrokerConfigError`` / ``BrokerArgumentError`` — error classes.

Anything not listed here (the lower-level functions such as ``request_permission`` or
``register_root``, ``parse_config``, ``resolve_reservation``, ``sweep_expired_reservations``, and
the ``keys`` module) is internal plumbing, as it is in the TypeScript package. It remains
importable from its own submodule (e.g. ``agent_broker.admission``, ``agent_broker.keys``) for
tests and advanced use, but is not part of the stable public API.
"""

from __future__ import annotations

from .admission import Admitted, DenialReason, Denied, RequestPermissionInput
from .agents import (
    ChildAgent,
    DeregisterResult,
    RegisterChildInput,
    RegisterDenial,
    RegisterDenialReason,
    RegisterRootInput,
    RootAgent,
)
from .broker import Broker, create_broker
from .budget import AddBudgetDenial, AddBudgetDenialReason, AddBudgetResult
from .config import BrokerHooks, BrokerOptions, CircuitBreakerOptions
from .errors import BrokerArgumentError, BrokerConfigError, BrokerError
from .queue import QueueOptions
from .resolution import ReportDenial, ReportDenialReason, ReportOutcomeInput, Resolved

__all__ = [
    "AddBudgetDenial",
    "AddBudgetDenialReason",
    "AddBudgetResult",
    "Admitted",
    "Broker",
    "BrokerArgumentError",
    "BrokerConfigError",
    "BrokerError",
    "BrokerHooks",
    "BrokerOptions",
    "ChildAgent",
    "CircuitBreakerOptions",
    "DenialReason",
    "Denied",
    "DeregisterResult",
    "QueueOptions",
    "RegisterChildInput",
    "RegisterDenial",
    "RegisterDenialReason",
    "RegisterRootInput",
    "ReportDenial",
    "ReportDenialReason",
    "ReportOutcomeInput",
    "RequestPermissionInput",
    "Resolved",
    "RootAgent",
    "create_broker",
]

__version__ = "0.1.0"
