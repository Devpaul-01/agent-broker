"""Reservation resolution: ``resolve_reservation``. Ports ``src/admission/resolve-reservation.ts``.

The single script that closes a reservation's lifecycle, called from two places: the public
``report_outcome`` (Milestone 4 — not yet implemented) and the lazy-cleanup sweep in
``cleanup.py`` (reservation never reported, logically expired). Extracting this once, rather
than writing cleanup as a second independent script, means the idempotency guarantee (the
``resolved`` flag, checked and set atomically inside the script) automatically covers races
between an explicit report and cleanup racing on the same reservation — there is structurally
only one place a reservation can be resolved.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from . import keys
from ._hooks import fire_hook
from ._script_runner import define_script, run_script_async
from ._scripts import RESOLVE_RESERVATION_NUM_KEYS, RESOLVE_RESERVATION_SOURCE
from .config import ResolvedConfig
from .errors import BrokerError

_RESOLVE_RESERVATION_SCRIPT = define_script(RESOLVE_RESERVATION_SOURCE, RESOLVE_RESERVATION_NUM_KEYS)

ResolveSkipReason = Literal["unknown_reservation", "already_resolved"]


@dataclass(frozen=True)
class ResolveOutcome:
    resolved: Literal[True]
    cost_unknown: bool
    pool_missing: bool
    circuit_closed: bool


@dataclass(frozen=True)
class ResolveSkipped:
    resolved: Literal[False]
    reason: ResolveSkipReason


@dataclass(frozen=True)
class ResolveParams:
    reservation_id: str
    budget_key: str
    target: str
    success: bool
    feeds_circuit: bool
    window_ms: int
    # Required even when feeds_circuit is False (cleanup): the script only reads this when it's
    # about to write a retryable failure into the window, which never happens for cleanup, but
    # the ARGV slot is always present so callers always supply the current configured value.
    hard_threshold: int
    actual_cost: int | None = None
    retryable: bool = False


async def resolve_reservation(
    config: ResolvedConfig,
    params: ResolveParams,
) -> ResolveOutcome | ResolveSkipped:
    try:
        reply = await run_script_async(
            config.redis,
            _RESOLVE_RESERVATION_SCRIPT,
            [
                keys.reservation(params.reservation_id),
                keys.budget(params.budget_key),
                keys.concurrency(params.target, params.budget_key),
                keys.reservations_expiring(),
                keys.circuit(params.target),
                keys.circuit_state(params.target),
            ],
            [
                params.reservation_id,
                "1" if params.success else "0",
                "1" if params.actual_cost is not None else "0",
                params.actual_cost if params.actual_cost is not None else 0,
                int(time.time() * 1000),
                "1" if params.retryable else "0",
                params.window_ms,
                "1" if params.feeds_circuit else "0",
                params.hard_threshold,
            ],
        )
    except Exception as error:  # noqa: BLE001 - always re-wrapped as BrokerError below
        raise BrokerError(f"resolve_reservation failed unexpectedly: {error}") from error

    if isinstance(reply, (list, tuple)):
        status = reply[0]
        # {1, costUnknown, poolMissing, '1'|'0', opened} - costUnknown/poolMissing are Lua
        # integers (0/1, i.e. real ints over the wire), while the circuit-state flags are the
        # literal strings '1'/'0' — matching the TS script's own mixed return-type reply array
        # exactly (see RESOLVE_RESERVATION_SOURCE's final `return` statements).
        a_raw = reply[1] if len(reply) > 1 else None
        b_raw = reply[2] if len(reply) > 2 else None
        c = _decode(reply[3]) if len(reply) > 3 else None
        d = _decode(reply[4]) if len(reply) > 4 else None

        if status == 0:
            reason = _decode(a_raw)
            if reason in ("unknown_reservation", "already_resolved"):
                return ResolveSkipped(resolved=False, reason=reason)  # type: ignore[arg-type]
        if status == 1:
            if c == "1":
                fire_hook(config.hooks.on_circuit_state_change, {"target": params.target, "state": "closed"})
            if d == "1":
                fire_hook(config.hooks.on_circuit_state_change, {"target": params.target, "state": "open"})
            return ResolveOutcome(
                resolved=True,
                cost_unknown=_as_int(a_raw) == 1,
                pool_missing=_as_int(b_raw) == 1,
                circuit_closed=c == "1",
            )

    raise BrokerError(f"unexpected reply from resolve-reservation script: {reply!r}")


def _decode(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if value is None:
        return None
    return str(value)


def _as_int(value: object) -> int:
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if not isinstance(value, (str, int, float)):
        raise BrokerError(f"unexpected numeric field in resolve-reservation reply: {value!r}")
    return int(value)
