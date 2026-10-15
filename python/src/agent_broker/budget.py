"""Budget top-up. Ports ``src/budget/add-budget.ts``.

Requires an existing pool rather than silently creating one — mirroring ``register_root``'s own
first-creation-wins semantics (a pool is created via ``register_root(budget_key=...,
initial_budget=...)``, not via an ambient top-up call), and specifically preventing a typo'd
``budget_key`` from silently spinning up a new, disconnected pool nobody intended.

This needs to be a script, not a plain EXISTS-then-INCRBY from Python: ``INCRBY`` on a missing
key does not error, it silently creates the key (the exact same hazard closed in ADR-0003 for
``resolve_reservation``'s refund path). A TOCTOU gap between a separate EXISTS check and INCRBY
— the pool deleted by something else in between — would reopen that same silent-recreation bug
at a new call site. One atomic EXISTS-then-INCRBY (the shared ``ADD_BUDGET`` script) closes it
the same way ADR-0003 did.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from . import keys
from ._script_runner import define_script, run_script_async
from ._scripts import ADD_BUDGET_NUM_KEYS, ADD_BUDGET_SOURCE
from .config import ResolvedConfig
from .errors import BrokerArgumentError

_ADD_BUDGET_SCRIPT = define_script(ADD_BUDGET_SOURCE, ADD_BUDGET_NUM_KEYS)

AddBudgetDenialReason = Literal["unknown_budget"]


@dataclass(frozen=True)
class AddBudgetResult:
    added: Literal[True]
    new_balance: int


@dataclass(frozen=True)
class AddBudgetDenial:
    added: Literal[False]
    reason: AddBudgetDenialReason


async def add_budget(
    config: ResolvedConfig,
    budget_key: str,
    amount: int,
) -> AddBudgetResult | AddBudgetDenial:
    if not isinstance(budget_key, str) or len(budget_key) == 0:
        raise BrokerArgumentError("budget_key must be a non-empty string")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise BrokerArgumentError(f"amount must be a positive integer, got {amount!r}")

    reply = await run_script_async(config.redis, _ADD_BUDGET_SCRIPT, [keys.budget(budget_key)], [amount])

    if isinstance(reply, (list, tuple)):
        status = reply[0]
        if status == 0:
            reason = _decode(reply[1]) if len(reply) > 1 else None
            if reason == "unknown_budget":
                return AddBudgetDenial(added=False, reason="unknown_budget")
        if status == 1 and len(reply) > 1:
            return AddBudgetResult(added=True, new_balance=int(reply[1]))

    raise RuntimeError(f"unexpected reply from add-budget script: {reply!r}")


def _decode(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if value is None:
        return None
    return str(value)
