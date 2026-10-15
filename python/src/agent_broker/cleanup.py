"""Lazy cleanup of expired, unresolved reservations. Ports ``src/admission/cleanup.ts``.

Triggered from inside ``request_permission`` (``admission.py``), not from a background timer
(ADR-0001: lazy, not event-driven) — this module must never be run on a timer/thread in this
port either, or Python's behavior would diverge from the documented TS contract.

An abandoned reservation is resolved as ``success=False``, no ``actual_cost`` (full refund) —
the conservative choice, since the broker has no evidence either way about whether the call
actually succeeded. This also means ``feeds_circuit=False``: a crash is evidence about the
*caller*, not the target, so cleanup must never count toward the circuit breaker regardless of
outcome.
"""

from __future__ import annotations

import asyncio
import time

from . import keys
from ._hooks import fire_hook
from .config import ResolvedConfig
from .resolution import ResolveParams, resolve_reservation

# Bounded per-call work: each request_permission call sweeps at most this many expired-but-
# unresolved reservations. Matches CLEANUP_BATCH_SIZE in src/admission/cleanup.ts exactly.
_CLEANUP_BATCH_SIZE = 5


async def _hmget_budget_key_and_target(redis: object, key: str) -> dict[str, str] | None:
    """Python equivalent of hmgetBudgetKeyAndTarget (src/redis/hmget2.ts).

    TypeScript needed this as a narrow-typing helper; Python's structural typing has no
    equivalent need, but the function is kept as its own unit for the same reason the TS
    version is: a single place that defines "a reservation hash with both required fields
    present" so every call site gets the same None-safety guarantee.
    """
    result = await redis.hmget(key, "budgetKey", "target")  # type: ignore[attr-defined]
    budget_key, target = result[0], result[1]
    if budget_key is None or target is None:
        return None
    if isinstance(budget_key, bytes):
        budget_key = budget_key.decode("utf-8")
    if isinstance(target, bytes):
        target = target.decode("utf-8")
    return {"budgetKey": budget_key, "target": target}


async def sweep_expired_reservations(config: ResolvedConfig) -> None:
    """Find reservations whose logical expiry has passed and resolve any never reported.

    A candidate whose hash is already gone (past its grace-period TTL) or already resolved
    (``report_outcome`` won the race, or a prior sweep already handled it) is simply removed
    from the sorted set with no refund — ``resolve_reservation``'s own idempotency check (not
    this function) is what makes that safe under concurrent cleanup/report_outcome calls.

    ``on_cleanup`` fires only when a sweep actually resolves a genuine orphan, not on every
    sweep.
    """
    now = int(time.time() * 1000)
    candidates = await config.redis.zrangebyscore(
        keys.reservations_expiring(),
        "-inf",
        now,
        start=0,
        num=_CLEANUP_BATCH_SIZE,
    )
    if not candidates:
        return

    async def _handle_one(reservation_id_raw: object) -> None:
        reservation_id = (
            reservation_id_raw.decode("utf-8")
            if isinstance(reservation_id_raw, bytes)
            else str(reservation_id_raw)
        )
        fields = await _hmget_budget_key_and_target(config.redis, keys.reservation(reservation_id))
        if fields is None:
            # Hash already gone (past grace period) — nothing to refund, just drop the stale
            # sorted-set entry so future sweeps don't keep rediscovering it.
            await config.redis.zrem(keys.reservations_expiring(), reservation_id)
            return
        outcome = await resolve_reservation(
            config,
            ResolveParams(
                reservation_id=reservation_id,
                budget_key=fields["budgetKey"],
                target=fields["target"],
                success=False,
                feeds_circuit=False,
                window_ms=config.circuit_breaker.window_ms,
                hard_threshold=config.circuit_breaker.hard_threshold,
            ),
        )
        if outcome.resolved:
            fire_hook(
                config.hooks.on_cleanup,
                {"reservationId": reservation_id, "target": fields["target"], "budgetKey": fields["budgetKey"]},
            )

    await asyncio.gather(*(_handle_one(c) for c in candidates))
