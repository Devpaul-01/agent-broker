"""Broker configuration: parsing, validation, and the frozen resolved-config shape.

Ports ``src/config/index.ts``. Validation rules, defaults, and error messages are kept
semantically identical to the TypeScript implementation (same fields, same bounds, same
cross-field invariants) so that behavior documented for one language holds for both — see
``docs/ARCHITECTURE.md`` §23. The *shape* is idiomatic Python (frozen
dataclasses, not a hand-rolled "parse a dict" function returning a plain dict), matching the
project's instruction not to mechanically translate TypeScript naming/structure.

Unlike the TypeScript ``ResolvedConfig``, which is produced by freezing a plain object at
runtime, Python's ``ResolvedConfig`` is a ``@dataclass(frozen=True)`` — attribute assignment
after construction raises ``dataclasses.FrozenInstanceError`` by construction, which is the
idiomatic Python equivalent of ``Object.freeze``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol

from .errors import BrokerConfigError

OnRedisUnavailable = Literal["deny", "allow"]


class RedisLike(Protocol):
    """Structural placeholder for the Redis client the caller must supply.

    Agent Broker never creates or owns its own Redis connection (mirrors ADR-0006) — the
    caller always passes one in, sync or async. This library does not pin to a concrete
    ``redis.Redis`` / ``redis.asyncio.Redis`` type here because both are acceptable depending
    on which broker factory the caller uses (see ``broker.py``, Milestone 4).
    """

    ...


@dataclass(frozen=True)
class CircuitBreakerOptions:
    """Caller-supplied circuit-breaker overrides. All fields optional; unset = use the default."""

    soft_threshold: int | None = None
    hard_threshold: int | None = None
    window_ms: int | None = None
    probe_rate: float | None = None


@dataclass(frozen=True)
class ResolvedCircuitBreakerConfig:
    """Fully-resolved circuit-breaker config: every field present, validated, frozen."""

    soft_threshold: int
    hard_threshold: int
    window_ms: int
    probe_rate: float


@dataclass(frozen=True)
class BrokerHooks:
    """Optional observability callbacks. Mirrors ``BrokerHooks`` in ``src/config/index.ts``.

    Each hook is fire-and-forget: exceptions raised inside a hook are swallowed by the caller
    (see ``hooks.py``, Milestone 4) and never affect broker behavior or propagate to the
    caller of ``request_permission``/``report_outcome``.
    """

    on_decision: Callable[[dict[str, Any]], None] | None = None
    on_outcome: Callable[[dict[str, Any]], None] | None = None
    on_circuit_state_change: Callable[[dict[str, Any]], None] | None = None
    on_cleanup: Callable[[dict[str, Any]], None] | None = None


@dataclass(frozen=True)
class BrokerOptions:
    """Caller-supplied broker configuration, before validation/defaulting."""

    redis: Any  # RedisLike — left as Any so both sync and async clients type-check here.
    max_depth: int | None = None
    agent_ttl: int | None = None
    default_reservation_ttl: int | None = None
    max_reservation_ttl: int | None = None
    concurrency_limit: int | None = None
    on_redis_unavailable: OnRedisUnavailable | None = None
    circuit_breaker: CircuitBreakerOptions | None = None
    hooks: BrokerHooks | None = None


@dataclass(frozen=True)
class ResolvedConfig:
    """Fully-resolved, validated, immutable broker configuration."""

    redis: Any
    max_depth: int
    agent_ttl: int
    default_reservation_ttl: int
    max_reservation_ttl: int
    concurrency_limit: int
    on_redis_unavailable: OnRedisUnavailable
    circuit_breaker: ResolvedCircuitBreakerConfig
    hooks: BrokerHooks = field(default_factory=BrokerHooks)


def _int_field(name: str, value: int | None, fallback: int, minimum: int) -> int:
    """Validate an integer config field. Mirrors the TS `int()` helper exactly:
    must be present-or-defaulted, a safe integer (no bool, no float, no NaN/inf), and >= minimum.
    """
    v = fallback if value is None else value
    # isinstance check first: Python's bool is an int subclass, and a bool here is a caller
    # mistake, not a valid 0/1 — the TS Number.isSafeInteger check has no such ambiguity, so
    # this extra guard is what makes the Python port's behavior match the TS *intent*, not
    # just its literal translation.
    if isinstance(v, bool) or not isinstance(v, int) or v < minimum:
        raise BrokerConfigError(f"{name} must be an integer >= {minimum}, got {v!r}")
    return v


def parse_config(options: BrokerOptions) -> ResolvedConfig:
    """Validate and resolve broker options into a frozen ``ResolvedConfig``.

    Raises ``BrokerConfigError`` for any invalid or missing required field. Every validation
    rule here has a corresponding case in ``tests/unit/test_config.py``, itself a port of
    ``test/unit/config.test.ts``.
    """
    if options is None or options.redis is None:
        raise BrokerConfigError("redis is required: pass the redis client the broker should use")

    concurrency_limit = _int_field("concurrency_limit", options.concurrency_limit, 10, 1)
    max_depth = _int_field("max_depth", options.max_depth, 5, 0)
    default_reservation_ttl = _int_field("default_reservation_ttl", options.default_reservation_ttl, 30_000, 1)
    max_reservation_ttl = _int_field("max_reservation_ttl", options.max_reservation_ttl, 300_000, 1)
    agent_ttl = _int_field("agent_ttl", options.agent_ttl, 3_600_000, 1)

    if default_reservation_ttl > max_reservation_ttl:
        raise BrokerConfigError(
            f"default_reservation_ttl ({default_reservation_ttl}) cannot exceed "
            f"max_reservation_ttl ({max_reservation_ttl})"
        )
    if agent_ttl < max_reservation_ttl:
        raise BrokerConfigError(
            f"agent_ttl ({agent_ttl}) must be >= max_reservation_ttl ({max_reservation_ttl}), "
            "or an agent could expire while its call is still in flight"
        )

    on_redis_unavailable: OnRedisUnavailable = options.on_redis_unavailable or "deny"
    if on_redis_unavailable not in ("deny", "allow"):
        raise BrokerConfigError(f"on_redis_unavailable must be 'deny' or 'allow', got {on_redis_unavailable!r}")

    cb = options.circuit_breaker or CircuitBreakerOptions()
    soft_threshold = _int_field("circuit_breaker.soft_threshold", cb.soft_threshold, 5, 1)
    hard_threshold = _int_field("circuit_breaker.hard_threshold", cb.hard_threshold, 20, 1)
    window_ms = _int_field("circuit_breaker.window_ms", cb.window_ms, 60_000, 1)
    probe_rate = cb.probe_rate if cb.probe_rate is not None else 0.1

    if hard_threshold <= soft_threshold:
        raise BrokerConfigError(
            f"circuit_breaker.hard_threshold ({hard_threshold}) must exceed soft_threshold ({soft_threshold})"
        )
    if not math.isfinite(probe_rate) or probe_rate <= 0 or probe_rate > 1:
        raise BrokerConfigError(
            "circuit_breaker.probe_rate must be in (0, 1] so recovery probes are never "
            f"disabled, got {probe_rate!r}"
        )

    hooks = options.hooks or BrokerHooks()

    return ResolvedConfig(
        redis=options.redis,
        max_depth=max_depth,
        agent_ttl=agent_ttl,
        default_reservation_ttl=default_reservation_ttl,
        max_reservation_ttl=max_reservation_ttl,
        concurrency_limit=concurrency_limit,
        on_redis_unavailable=on_redis_unavailable,
        circuit_breaker=ResolvedCircuitBreakerConfig(
            soft_threshold=soft_threshold,
            hard_threshold=hard_threshold,
            window_ms=window_ms,
            probe_rate=probe_rate,
        ),
        hooks=hooks,
    )
