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
from ._hmget2 import hmget_budget_key_and_target
from ._unavailable import is_redis_unavailable_error
from .config import ResolvedConfig
from .errors import BrokerArgumentError, BrokerError

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


# --- report_outcome: the public, validating wrapper around resolve_reservation --------------

ReportDenialReason = Literal["unknown_reservation", "already_resolved"]


@dataclass(frozen=True)
class ReportOutcomeInput:
    """``reservation_id=None`` is a defined no-op: pass the ``reservation_id`` you got back from
    a degraded admission (``request_permission`` with ``on_redis_unavailable='allow'`` during a
    Redis outage), where no reservation was ever created. Calling ``report_outcome`` with
    ``reservation_id=None`` resolves immediately with no Redis call, rather than requiring
    callers to remember not to call it at all.
    """

    reservation_id: str | None
    success: bool
    actual_cost: int | None = None
    # Required when success is False: was this failure the target's fault and worth retrying
    # (timeout, 5xx), or not (a local validation error, a 4xx)? Only retryable failures count
    # toward the circuit breaker's sliding window.
    retryable: bool | None = None


@dataclass(frozen=True)
class Resolved:
    allowed: Literal[True]
    cost_unknown: bool
    # True when the refund could not be applied because the budget pool no longer existed
    # (deleted externally - the pool has no TTL of its own and nothing in the library deletes
    # it, so this means something outside the broker removed it). The reservation still
    # resolves normally: concurrency is released and it will not be reported on again.
    pool_missing: bool = False
    # True only for the reservation_id=None no-op path, or for a genuine Redis outage with
    # on_redis_unavailable='allow' - this report could not actually be applied to Redis.
    degraded: bool = False


@dataclass(frozen=True)
class ReportDenial:
    allowed: Literal[False]
    reason: ReportDenialReason


def _validate_report_outcome(input: ReportOutcomeInput) -> None:
    """Mirrors validate() in src/admission/report-outcome.ts, minus the "extra field rejection"
    check (meaningless for a typed dataclass - there is no way to pass an extra field at all,
    unlike a plain object literal in TS) and minus the reservation_id=None case, which the
    caller handles before validation ever runs (see report_outcome's own docstring for why that
    ordering is load-bearing, not incidental).
    """
    if input.reservation_id is not None and (
        not isinstance(input.reservation_id, str) or len(input.reservation_id) == 0
    ):
        raise BrokerArgumentError(
            "reservation_id must be a non-empty string (or exactly None for the degraded no-op case)"
        )
    if not isinstance(input.success, bool):
        raise BrokerArgumentError(f"success must be a boolean, got {input.success!r}")
    if input.actual_cost is not None:
        c = input.actual_cost
        if isinstance(c, bool) or not isinstance(c, int) or c < 0:
            raise BrokerArgumentError(f"actual_cost must be a non-negative integer, got {c!r}")
    if input.success is False and not isinstance(input.retryable, bool):
        raise BrokerArgumentError(
            "retryable (boolean) is required when success is False: the circuit breaker needs "
            "to know whether this failure was the target's fault"
        )
    if input.success is True and input.retryable is not None:
        raise BrokerArgumentError("retryable is only meaningful when success is False")


async def report_outcome(
    config: ResolvedConfig,
    input: ReportOutcomeInput,
) -> Resolved | ReportDenial:
    """The public, validating entry point for resolving a reservation. Ports ``reportOutcome``
    in ``src/admission/report-outcome.ts``: looks up the reservation's ``budget_key``/``target``
    (so callers never need to remember or pass them back), then delegates to
    ``resolve_reservation`` with ``feeds_circuit=True`` always (only an explicit, real-caller
    report can tell the circuit breaker about a genuine target failure — lazy cleanup never
    does, see ``cleanup.py``).
    """
    # Explicit no-op for a degraded admission that never created a reservation. Checked before
    # full validation (which would otherwise reject None as "not a non-empty string") - this
    # ordering is load-bearing, not incidental. Still validates `success`'s shape so a
    # genuinely malformed call doesn't silently succeed via this path.
    if input.reservation_id is None:
        if not isinstance(input.success, bool):
            raise BrokerArgumentError(f"success must be a boolean, got {input.success!r}")
        result: Resolved = Resolved(allowed=True, cost_unknown=True, pool_missing=False, degraded=True)
        fire_hook(config.hooks.on_outcome, {"reservationId": None, "result": result})
        return result

    _validate_report_outcome(input)
    reservation_id = input.reservation_id

    fields = await hmget_budget_key_and_target(config.redis, keys.reservation(reservation_id))
    if fields is None:
        denial: ReportDenial = ReportDenial(allowed=False, reason="unknown_reservation")
        fire_hook(config.hooks.on_outcome, {"reservationId": reservation_id, "result": denial})
        return denial

    try:
        outcome = await resolve_reservation(
            config,
            ResolveParams(
                reservation_id=reservation_id,
                budget_key=fields["budgetKey"],
                target=fields["target"],
                success=input.success,
                actual_cost=input.actual_cost,
                retryable=input.retryable if input.retryable is not None else False,
                feeds_circuit=True,
                window_ms=config.circuit_breaker.window_ms,
                hard_threshold=config.circuit_breaker.hard_threshold,
            ),
        )
    except Exception as error:  # noqa: BLE001 - re-raised below unless it's a Redis-unavailable condition
        if not is_redis_unavailable_error(error):
            raise  # real bugs still propagate, never swallowed here

        # Redis is unreachable: we cannot refund, release concurrency, or mark this resolved
        # right now. If on_redis_unavailable is "allow", accept the loss rather than raise - the
        # original reservation stays unresolved in Redis and will eventually be picked up by
        # lazy cleanup once Redis is healthy again, the same path as a crashed caller that never
        # reported at all. If "deny", raising is correct: the caller explicitly opted into
        # fail-closed behavior and should know this report did not land.
        if config.on_redis_unavailable == "deny":
            raise BrokerError(
                "report_outcome failed: Redis unreachable and on_redis_unavailable is 'deny'"
            ) from error
        degraded_result: Resolved = Resolved(allowed=True, cost_unknown=True, pool_missing=False, degraded=True)
        fire_hook(config.hooks.on_outcome, {"reservationId": reservation_id, "result": degraded_result})
        return degraded_result

    if isinstance(outcome, ResolveSkipped):
        skip_denial: ReportDenial = ReportDenial(allowed=False, reason=outcome.reason)
        fire_hook(config.hooks.on_outcome, {"reservationId": reservation_id, "result": skip_denial})
        return skip_denial

    resolved: Resolved = Resolved(
        allowed=True, cost_unknown=outcome.cost_unknown, pool_missing=outcome.pool_missing
    )
    fire_hook(config.hooks.on_outcome, {"reservationId": reservation_id, "result": resolved})
    return resolved
