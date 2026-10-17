"""The top-level public factory. Ports ``createBroker``/``Broker`` in ``src/broker.ts``.

Ties every coordination module into one object, matching the TS package's single entry point.
Python does not need the TS version's runtime duck-typing dispatch for ``register()``
(``"parentId" in input`` to choose between root and child registration) — ``RegisterRootInput``
and ``RegisterChildInput`` are distinct, non-overlapping dataclass types, so Python's own
``isinstance``/structural typing already disambiguates them; ``Broker.register`` here still
accepts either and dispatches, for the same ergonomic reason the TS version does (one method
name for "register something," not two the caller has to remember to pick between), but without
needing a type-narrowing trick that Python's type system doesn't need in the first place.
"""

from __future__ import annotations

from dataclasses import dataclass

from .admission import Admitted, Denied, RequestPermissionInput, request_permission
from .agents import (
    ChildAgent,
    DeregisterResult,
    RegisterChildInput,
    RegisterDenial,
    RegisterRootInput,
    RootAgent,
    deregister,
    register_child,
    register_root,
)
from .budget import AddBudgetDenial, AddBudgetResult, add_budget
from .config import BrokerOptions, ResolvedConfig, parse_config
from .queue import QueueOptions, request_permission_queued
from .resolution import ReportDenial, ReportOutcomeInput, Resolved, report_outcome

# Module-level aliases so method bodies can call the underlying functions without shadowing them
# by same-named Broker methods below (Python has no separate function/method namespace the way
# a method body can otherwise still see the outer name, but an explicit alias keeps this
# unambiguous to a reader rather than relying on that subtlety).
_register_root = register_root
_register_child = register_child
_request_permission = request_permission
_report_outcome = report_outcome
_deregister = deregister
_add_budget = add_budget


@dataclass(frozen=True)
class Broker:
    """The broker's public surface. Every method closes over one ``ResolvedConfig``, created
    once at ``create_broker`` time and never mutated — matching the TS version's own
    ``Object.freeze``'d closure object, via Python's frozen dataclass instead.
    """

    _config: ResolvedConfig

    async def register_root(self, input: RegisterRootInput) -> RootAgent:
        result = await _register_root(self._config, input)
        return result.agent

    async def register_child(self, input: RegisterChildInput) -> ChildAgent | RegisterDenial:
        return await _register_child(self._config, input)

    async def request_permission(
        self,
        input: RequestPermissionInput,
        queue_options: QueueOptions | None = None,
    ) -> Admitted | Denied:
        if queue_options is None:
            return await _request_permission(self._config, input)
        return await request_permission_queued(self._config, input, queue_options, _request_permission)

    async def report_outcome(self, input: ReportOutcomeInput) -> Resolved | ReportDenial:
        return await _report_outcome(self._config, input)

    async def deregister(self, agent_id: str) -> DeregisterResult:
        return await _deregister(self._config, agent_id)

    async def add_budget(self, budget_key: str, amount: int) -> AddBudgetResult | AddBudgetDenial:
        return await _add_budget(self._config, budget_key, amount)


def create_broker(options: BrokerOptions) -> Broker:
    """Validates ``options`` once (raising ``BrokerConfigError`` immediately on bad config,
    matching the TS version's behavior of validating at construction time, never per-call) and
    returns a ``Broker`` bound to the resulting frozen config.
    """
    config = parse_config(options)
    return Broker(_config=config)
