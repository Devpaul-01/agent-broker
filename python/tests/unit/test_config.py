"""Unit tests for ``agent_broker.config``.

Ports ``test/unit/config.test.ts`` case-for-case: same defaults, same immutability guarantee,
same validation rules, same rejected-field names in error messages.
"""

from __future__ import annotations

import dataclasses

import pytest

from agent_broker.config import BrokerOptions, CircuitBreakerOptions, parse_config
from agent_broker.errors import BrokerConfigError

FAKE_REDIS = object()  # config validation never touches the connection, matches the TS test


def opts(**overrides: object) -> BrokerOptions:
    return BrokerOptions(redis=FAKE_REDIS, **overrides)  # type: ignore[arg-type]


def test_applies_documented_defaults_failing_closed_when_redis_unavailable() -> None:
    cfg = parse_config(opts())
    assert cfg.max_depth == 5
    assert cfg.default_reservation_ttl == 30_000
    assert cfg.max_reservation_ttl == 300_000
    assert cfg.on_redis_unavailable == "deny"
    assert cfg.concurrency_limit == 10
    assert cfg.circuit_breaker.soft_threshold == 5
    assert cfg.circuit_breaker.hard_threshold == 20
    assert cfg.circuit_breaker.window_ms == 60_000
    assert cfg.circuit_breaker.probe_rate == 0.1


def test_accepts_max_depth_zero_roots_only_no_delegation() -> None:
    assert parse_config(opts(max_depth=0)).max_depth == 0


# ADR-19: config is immutable for the broker's lifetime.
def test_returns_frozen_config_that_does_not_alias_the_callers_objects() -> None:
    circuit_breaker = CircuitBreakerOptions(soft_threshold=3)
    cfg = parse_config(opts(circuit_breaker=circuit_breaker))
    # CircuitBreakerOptions is itself frozen, so there's no mutate-after-the-fact path to test
    # the way the TS test does (`circuitBreaker.softThreshold = 999`) — Python's frozen
    # dataclass rejects that assignment outright, which is the stronger guarantee the TS test
    # is checking for indirectly. We assert that guarantee directly instead.
    with pytest.raises(dataclasses.FrozenInstanceError):
        circuit_breaker.soft_threshold = 999  # type: ignore[misc]
    assert cfg.circuit_breaker.soft_threshold == 3
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.circuit_breaker.soft_threshold = 999  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.max_depth = 99  # type: ignore[misc]


def test_rejects_a_missing_redis_client() -> None:
    with pytest.raises(BrokerConfigError):
        parse_config(BrokerOptions(redis=None))


@pytest.mark.parametrize(
    "label,overrides,expected_field",
    [
        ("max_depth negative", {"max_depth": -1}, "max_depth"),
        ("max_depth fractional", {"max_depth": 1.5}, "max_depth"),
        ("concurrency_limit zero", {"concurrency_limit": 0}, "concurrency_limit"),
        ("default_reservation_ttl zero", {"default_reservation_ttl": 0}, "default_reservation_ttl"),
        ("default TTL above max", {"default_reservation_ttl": 400_000}, "default_reservation_ttl"),
        ("agent_ttl below max_reservation_ttl", {"agent_ttl": 1_000}, "agent_ttl"),
        (
            "soft threshold above default hard",
            {"circuit_breaker": CircuitBreakerOptions(soft_threshold=25)},
            "hard_threshold",
        ),
        (
            "soft equals hard",
            {"circuit_breaker": CircuitBreakerOptions(soft_threshold=10, hard_threshold=10)},
            "hard_threshold",
        ),
        ("window_ms zero", {"circuit_breaker": CircuitBreakerOptions(window_ms=0)}, "window_ms"),
        ("probe_rate zero", {"circuit_breaker": CircuitBreakerOptions(probe_rate=0)}, "probe_rate"),
        ("probe_rate above one", {"circuit_breaker": CircuitBreakerOptions(probe_rate=1.5)}, "probe_rate"),
        ("probe_rate NaN", {"circuit_breaker": CircuitBreakerOptions(probe_rate=float("nan"))}, "probe_rate"),
        ("unknown on_redis_unavailable", {"on_redis_unavailable": "maybe"}, "on_redis_unavailable"),
    ],
)
def test_rejects_invalid_fields(label: str, overrides: dict[str, object], expected_field: str) -> None:
    with pytest.raises(BrokerConfigError, match=expected_field):
        parse_config(opts(**overrides))


def test_max_depth_fractional_is_rejected_even_though_python_has_no_separate_float_type_check() -> None:
    # Explicit regression case: 1.5 must fail because it's not an int, matching
    # Number.isSafeInteger(1.5) === false in TS — not because of a bounds check.
    with pytest.raises(BrokerConfigError, match="max_depth"):
        parse_config(opts(max_depth=1.5))  # type: ignore[arg-type]
