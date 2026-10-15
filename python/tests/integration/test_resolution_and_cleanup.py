"""Integration tests for ``resolve_reservation`` (refund formula, idempotency, probe recovery)
and the lazy cleanup sweep. Ports the key cases from ``test/integration/report-outcome.test.ts``
and ``test/integration/cleanup.test.ts``.
"""

from __future__ import annotations

import asyncio
import random

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import Admitted, RequestPermissionInput, request_permission
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.cleanup import sweep_expired_reservations
from agent_broker.config import BrokerOptions, parse_config
from agent_broker.resolution import ResolveOutcome, ResolveParams, ResolveSkipped, resolve_reservation

pytestmark = pytest.mark.integration


async def _admitted_reservation(redis_client, estimated_cost: int = 300, initial_budget: int = 1000):
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key=f"r{random.random()}", initial_budget=initial_budget))
    agent = reg.agent
    result = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="groq:llama", estimated_cost=estimated_cost)
    )
    assert isinstance(result, Admitted)
    return config, agent, result


async def test_full_refund_on_failure_with_no_actual_cost_given(redis_client: redis_asyncio.Redis) -> None:
    config, agent, admit = await _admitted_reservation(redis_client, estimated_cost=300, initial_budget=1000)
    assert await redis_client.get(keys.budget(agent.budget_key)) == "700"

    outcome = await resolve_reservation(
        config,
        ResolveParams(
            reservation_id=admit.reservation_id,  # type: ignore[arg-type]
            budget_key=agent.budget_key,
            target="groq:llama",
            success=False,
            feeds_circuit=False,
            window_ms=config.circuit_breaker.window_ms,
            hard_threshold=config.circuit_breaker.hard_threshold,
        ),
    )
    assert isinstance(outcome, ResolveOutcome)
    assert outcome.resolved is True
    assert outcome.cost_unknown is False
    assert outcome.pool_missing is False
    # Full refund: back to 1000.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"


async def test_zero_refund_on_success_with_no_actual_cost_marks_cost_unknown(
    redis_client: redis_asyncio.Redis,
) -> None:
    config, agent, admit = await _admitted_reservation(redis_client, estimated_cost=300, initial_budget=1000)
    outcome = await resolve_reservation(
        config,
        ResolveParams(
            reservation_id=admit.reservation_id,  # type: ignore[arg-type]
            budget_key=agent.budget_key,
            target="groq:llama",
            success=True,
            feeds_circuit=False,
            window_ms=config.circuit_breaker.window_ms,
            hard_threshold=config.circuit_breaker.hard_threshold,
        ),
    )
    assert isinstance(outcome, ResolveOutcome)
    assert outcome.cost_unknown is True
    # No refund: still 700 (the full estimated cost stays reserved/spent).
    assert await redis_client.get(keys.budget(agent.budget_key)) == "700"


async def test_partial_refund_when_actual_cost_given(redis_client: redis_asyncio.Redis) -> None:
    config, agent, admit = await _admitted_reservation(redis_client, estimated_cost=300, initial_budget=1000)
    outcome = await resolve_reservation(
        config,
        ResolveParams(
            reservation_id=admit.reservation_id,  # type: ignore[arg-type]
            budget_key=agent.budget_key,
            target="groq:llama",
            success=True,
            actual_cost=120,
            feeds_circuit=False,
            window_ms=config.circuit_breaker.window_ms,
            hard_threshold=config.circuit_breaker.hard_threshold,
        ),
    )
    assert isinstance(outcome, ResolveOutcome)
    assert outcome.cost_unknown is False
    # refund = estimatedCost(300) - actualCost(120) = 180; balance was 700, now 880.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "880"


async def test_resolving_twice_is_idempotent_second_call_reports_already_resolved(
    redis_client: redis_asyncio.Redis,
) -> None:
    config, agent, admit = await _admitted_reservation(redis_client)
    params = ResolveParams(
        reservation_id=admit.reservation_id,  # type: ignore[arg-type]
        budget_key=agent.budget_key,
        target="groq:llama",
        success=False,
        feeds_circuit=False,
        window_ms=config.circuit_breaker.window_ms,
        hard_threshold=config.circuit_breaker.hard_threshold,
    )
    first = await resolve_reservation(config, params)
    second = await resolve_reservation(config, params)
    assert isinstance(first, ResolveOutcome) and first.resolved is True
    assert isinstance(second, ResolveSkipped)
    assert second.reason == "already_resolved"
    # Refund must not have been applied twice.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"


async def test_concurrent_resolve_calls_refund_exactly_once(redis_client: redis_asyncio.Redis) -> None:
    """The idempotency guarantee under real concurrency, not just sequential re-calls."""
    config, agent, admit = await _admitted_reservation(redis_client, estimated_cost=300, initial_budget=1000)
    params = ResolveParams(
        reservation_id=admit.reservation_id,  # type: ignore[arg-type]
        budget_key=agent.budget_key,
        target="groq:llama",
        success=False,
        feeds_circuit=False,
        window_ms=config.circuit_breaker.window_ms,
        hard_threshold=config.circuit_breaker.hard_threshold,
    )
    results = await asyncio.gather(*(resolve_reservation(config, params) for _ in range(10)))
    resolved_count = sum(1 for r in results if isinstance(r, ResolveOutcome))
    skipped_count = sum(1 for r in results if isinstance(r, ResolveSkipped))
    assert resolved_count == 1
    assert skipped_count == 9
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"


async def test_resolving_unknown_reservation_is_reported_not_raised(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await resolve_reservation(
        config,
        ResolveParams(
            reservation_id="does-not-exist",
            budget_key="whatever",
            target="t",
            success=True,
            feeds_circuit=False,
            window_ms=config.circuit_breaker.window_ms,
            hard_threshold=config.circuit_breaker.hard_threshold,
        ),
    )
    assert isinstance(result, ResolveSkipped)
    assert result.reason == "unknown_reservation"


async def test_cleanup_sweep_resolves_an_expired_unreported_reservation_with_full_refund(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(BrokerOptions(redis=redis_client, default_reservation_ttl=1, max_reservation_ttl=60_000))
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"cleanup-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent
    admit = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=250, ttl=1)
    )
    assert isinstance(admit, Admitted)
    assert await redis_client.get(keys.budget(agent.budget_key)) == "750"

    await asyncio.sleep(0.05)  # let the 1ms TTL's logical-expiry timestamp pass
    await sweep_expired_reservations(config)

    # Cleanup resolved it as a failure with a full refund (no evidence call succeeded).
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"
    assert await redis_client.zrank(keys.reservations_expiring(), admit.reservation_id) is None  # type: ignore[arg-type]


async def test_cleanup_never_feeds_the_circuit_breaker_even_though_it_counts_as_a_failure(
    redis_client: redis_asyncio.Redis,
) -> None:
    """An abandoned reservation is evidence about the caller, never the target."""
    from agent_broker.config import CircuitBreakerOptions

    config = parse_config(
        BrokerOptions(
            redis=redis_client,
            default_reservation_ttl=1,
            max_reservation_ttl=60_000,
            circuit_breaker=CircuitBreakerOptions(soft_threshold=1, hard_threshold=2, window_ms=60_000),
        )
    )
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"cleanup-cb-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent
    admit = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="never-circuit", estimated_cost=1, ttl=1)
    )
    assert isinstance(admit, Admitted)

    await asyncio.sleep(0.05)
    await sweep_expired_reservations(config)

    # Even with hard_threshold=1, the circuit must remain closed (None state), since cleanup's
    # resolution always passes feeds_circuit=False.
    assert await redis_client.get(keys.circuit_state("never-circuit")) is None
