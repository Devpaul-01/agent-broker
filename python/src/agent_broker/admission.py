"""Core admission: ``request_permission``. Ports ``src/admission/request-permission.ts``.

This is the central shared-protocol surface of the library (see
``docs/ARCHITECTURE.md`` §23): the Lua script it runs
(``_scripts.REQUEST_PERMISSION_SOURCE``) is byte-identical to the TypeScript implementation's,
and the Redis keys it touches are built by the same length-prefixing scheme in ``keys.py`` — a
reservation created by a Python caller is fully visible to, and resolvable by, a TypeScript
caller pointed at the same Redis instance, and vice versa.

Async-only (see ``docs/ARCHITECTURE.md`` §23): this module's public function is a
coroutine, taking an async Redis client (``redis.asyncio.Redis``). There is no synchronous
wrapper.
"""

from __future__ import annotations

import random
import time
import uuid
from dataclasses import dataclass
from typing import Literal

from . import keys
from ._hooks import fire_hook
from ._script_runner import define_script, run_script_async
from ._scripts import REQUEST_PERMISSION_NUM_KEYS, REQUEST_PERMISSION_SOURCE
from ._unavailable import is_redis_unavailable_error
from .cleanup import sweep_expired_reservations
from .config import ResolvedConfig
from .errors import BrokerArgumentError, BrokerError

_REQUEST_PERMISSION_SCRIPT = define_script(REQUEST_PERMISSION_SOURCE, REQUEST_PERMISSION_NUM_KEYS)

# Grace period beyond the caller's TTL before the reservation hash is physically deleted. The
# sorted-set score (expiresAt), not this Redis-level TTL, is what decides logical expiry; the
# grace period only keeps the hash's fields alive long enough for lazy cleanup to read them.
# Matches RESERVATION_GRACE_MS in src/admission/request-permission.ts exactly.
_RESERVATION_GRACE_MS = 5_000

DenialReason = Literal[
    "unknown_agent",
    "aborted",
    "budget_exceeded",
    "concurrency_exceeded",
    "circuit_open",
    "redis_unavailable",
    "queue_timeout",
]


@dataclass(frozen=True)
class RequestPermissionInput:
    agent_id: str
    target: str
    estimated_cost: int
    ttl: int | None = None


@dataclass(frozen=True)
class Admitted:
    allowed: Literal[True]
    reservation_id: str | None
    retry_after: int | None = None
    # True only when this admission bypassed all coordination because Redis was unreachable and
    # on_redis_unavailable is "allow". Budget, concurrency, and circuit state were neither
    # checked nor updated. reservation_id is None in this case — see resolution.py's handling of
    # a None reservation_id, a defined, safe no-op specifically for this case.
    degraded: bool = False


@dataclass(frozen=True)
class Denied:
    allowed: Literal[False]
    reason: DenialReason


def _validate(input: RequestPermissionInput) -> None:
    if not isinstance(input.agent_id, str) or len(input.agent_id) == 0:
        raise BrokerArgumentError("agent_id must be a non-empty string")
    if not isinstance(input.target, str) or len(input.target) == 0:
        raise BrokerArgumentError("target must be a non-empty string")
    cost = input.estimated_cost
    if isinstance(cost, bool) or not isinstance(cost, int) or cost <= 0:
        raise BrokerArgumentError(f"estimated_cost must be a positive integer, got {cost!r}")
    if input.ttl is not None:
        ttl = input.ttl
        if isinstance(ttl, bool) or not isinstance(ttl, int) or ttl <= 0:
            raise BrokerArgumentError(f"ttl must be a positive integer (ms), got {ttl!r}")


async def request_permission(
    config: ResolvedConfig,
    input: RequestPermissionInput,
) -> Admitted | Denied:
    """Request admission for one call against ``input.target``, under ``input.agent_id``'s budget.

    Mirrors ``requestPermission`` in ``src/admission/request-permission.ts`` field-for-field:
    same validation, same TTL-exceeds-max check, same lazy-cleanup-sweep-first ordering, same
    script KEYS/ARGV layout, same denial reasons, same degraded/redis_unavailable fallback
    behavior under ``config.on_redis_unavailable``.
    """
    _validate(input)

    ttl = input.ttl if input.ttl is not None else config.default_reservation_ttl
    if ttl > config.max_reservation_ttl:
        raise BrokerArgumentError(
            f"ttl ({ttl}ms) exceeds max_reservation_ttl ({config.max_reservation_ttl}ms) "
            "configured for this broker"
        )

    try:
        # Lazy cleanup sweep, same as the TS implementation (sweeps first, same as
        # requestPermission's own ordering in src/admission/request-permission.ts).
        await sweep_expired_reservations(config)

        budget_key = await config.redis.hget(keys.agent(input.agent_id), "budgetKey")
        if budget_key is None:
            result: Denied = Denied(allowed=False, reason="unknown_agent")
            fire_hook(
                config.hooks.on_decision,
                {"agentId": input.agent_id, "target": input.target, "result": result},
            )
            return result

        # redis-py may return bytes depending on client decode_responses setting; normalize to
        # str the same way the TS side always deals in strings (ioredis is configured for
        # string replies throughout this library).
        if isinstance(budget_key, bytes):
            budget_key = budget_key.decode("utf-8")

        reservation_id = str(uuid.uuid4())
        cb = config.circuit_breaker
        reply = await run_script_async(
            config.redis,
            _REQUEST_PERMISSION_SCRIPT,
            [
                keys.agent(input.agent_id),
                keys.budget(budget_key),
                keys.reservation(reservation_id),
                keys.reservations_expiring(),
                keys.concurrency(input.target, budget_key),
                keys.circuit(input.target),
                keys.circuit_state(input.target),
            ],
            [
                input.agent_id,
                input.estimated_cost,
                input.target,
                ttl,
                int(time.time() * 1000),
                reservation_id,
                config.agent_ttl,
                budget_key,
                _RESERVATION_GRACE_MS,
                config.concurrency_limit,
                cb.window_ms,
                cb.soft_threshold,
                cb.hard_threshold,
                cb.probe_rate,
                random.random(),
            ],
        )

        if isinstance(reply, (list, tuple)):
            status = reply[0]
            a = reply[1] if len(reply) > 1 else None
            b = reply[2] if len(reply) > 2 else None

            if status == 0:
                reason = _decode(a)
                if reason == "circuit_open" and _decode(b) == "1":
                    fire_hook(
                        config.hooks.on_circuit_state_change,
                        {"target": input.target, "state": "open"},
                    )
                if reason in ("unknown_agent", "budget_exceeded", "concurrency_exceeded", "circuit_open"):
                    denied: Denied = Denied(allowed=False, reason=reason)  # type: ignore[arg-type]
                    fire_hook(
                        config.hooks.on_decision,
                        {"agentId": input.agent_id, "target": input.target, "result": denied},
                    )
                    return denied
            if status == 1:
                admitted: Admitted = (
                    Admitted(allowed=True, reservation_id=reservation_id)
                    if a is None
                    else Admitted(allowed=True, reservation_id=reservation_id, retry_after=int(a))
                )
                fire_hook(
                    config.hooks.on_decision,
                    {"agentId": input.agent_id, "target": input.target, "result": admitted},
                )
                return admitted

        raise BrokerError(f"unexpected reply from request-permission script: {reply!r}")

    except Exception as error:  # noqa: BLE001 - re-raised below unless it's a Redis-unavailable condition
        if isinstance(error, BrokerArgumentError):
            raise  # validation errors are already a clear, specific type — don't re-wrap them
        if not is_redis_unavailable_error(error):
            raise BrokerError(f"request_permission failed unexpectedly: {error}") from error

        fallback: Admitted | Denied = (
            Admitted(allowed=True, reservation_id=None, degraded=True)
            if config.on_redis_unavailable == "allow"
            else Denied(allowed=False, reason="redis_unavailable")
        )
        fire_hook(
            config.hooks.on_decision,
            {"agentId": input.agent_id, "target": input.target, "result": fallback},
        )
        return fallback


def _decode(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if value is None:
        return None
    return str(value)
