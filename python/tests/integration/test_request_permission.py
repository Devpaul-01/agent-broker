"""Integration tests for ``request_permission`` against real Redis.

Ports the key cases from ``test/integration/request-permission.test.ts``: circuit-breaker
soft/hard thresholds, probe recovery, concurrency scoping (Invariant 13), budget reservation,
and a genuine concurrent-caller race proving the concurrency limit is never exceeded.
"""

from __future__ import annotations

import asyncio
import os
import random
import uuid

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import Admitted, RequestPermissionInput, request_permission
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.config import BrokerOptions, CircuitBreakerOptions, parse_config
from agent_broker.resolution import ResolveParams, resolve_reservation

pytestmark = pytest.mark.integration


async def _root(redis_client: redis_asyncio.Redis, initial_budget: int) -> object:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await register_root(
        config, RegisterRootInput(budget_key=f"k{random.random()}", initial_budget=initial_budget)
    )
    return result.agent


async def _agent_with_circuit(redis_client: redis_asyncio.Redis, **cb_overrides: object) -> tuple[object, object]:
    defaults = {"soft_threshold": 2, "hard_threshold": 4, "window_ms": 60_000, "probe_rate": 0.0001}
    defaults.update(cb_overrides)
    cfg = parse_config(
        BrokerOptions(redis=redis_client, circuit_breaker=CircuitBreakerOptions(**defaults))  # type: ignore[arg-type]
    )
    result = await register_root(
        cfg, RegisterRootInput(budget_key=f"cb-{random.random()}", initial_budget=100_000)
    )
    return cfg, result.agent


async def test_attaches_retry_after_at_soft_threshold_without_denying(redis_client: redis_asyncio.Redis) -> None:
    cfg, agent = await _agent_with_circuit(redis_client)
    for _ in range(2):
        admit = await request_permission(
            cfg, RequestPermissionInput(agent_id=agent.agent_id, target="flaky", estimated_cost=1)  # type: ignore[attr-defined]
        )
        assert isinstance(admit, Admitted)
        await resolve_reservation(
            cfg,
            ResolveParams(
                reservation_id=admit.reservation_id,  # type: ignore[arg-type]
                budget_key=agent.budget_key,  # type: ignore[attr-defined]
                target="flaky",
                success=False,
                retryable=True,
                feeds_circuit=True,
                window_ms=cfg.circuit_breaker.window_ms,
                hard_threshold=cfg.circuit_breaker.hard_threshold,
            ),
        )
    result = await request_permission(
        cfg, RequestPermissionInput(agent_id=agent.agent_id, target="flaky", estimated_cost=1)  # type: ignore[attr-defined]
    )
    assert result.allowed is True
    assert isinstance(result, Admitted) and result.retry_after is not None and result.retry_after > 0


async def test_opens_circuit_at_hard_threshold_and_denies_with_circuit_open(
    redis_client: redis_asyncio.Redis,
) -> None:
    cfg, agent = await _agent_with_circuit(redis_client)
    for _ in range(4):
        admit = await request_permission(
            cfg, RequestPermissionInput(agent_id=agent.agent_id, target="down", estimated_cost=1)  # type: ignore[attr-defined]
        )
        assert isinstance(admit, Admitted)
        await resolve_reservation(
            cfg,
            ResolveParams(
                reservation_id=admit.reservation_id,  # type: ignore[arg-type]
                budget_key=agent.budget_key,  # type: ignore[attr-defined]
                target="down",
                success=False,
                retryable=True,
                feeds_circuit=True,
                window_ms=cfg.circuit_breaker.window_ms,
                hard_threshold=cfg.circuit_breaker.hard_threshold,
            ),
        )
    result = await request_permission(
        cfg, RequestPermissionInput(agent_id=agent.agent_id, target="down", estimated_cost=1)  # type: ignore[attr-defined]
    )
    assert result.allowed is False
    assert result.reason == "circuit_open"  # type: ignore[union-attr]
    assert await redis_client.get(keys.circuit_state("down")) == "open"


async def test_denies_concurrency_exceeded_leaving_budget_untouched(redis_client: redis_asyncio.Redis) -> None:
    budget_key = f"conc-{random.random()}"
    setup_cfg = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=2))
    reg = await register_root(setup_cfg, RegisterRootInput(budget_key=budget_key, initial_budget=1000))
    agent = reg.agent
    limited = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=2))

    first = await request_permission(
        limited, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=10)
    )
    second = await request_permission(
        limited, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=10)
    )
    third = await request_permission(
        limited, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=10)
    )

    assert first.allowed is True
    assert second.allowed is True
    assert third.allowed is False
    assert third.reason == "concurrency_exceeded"  # type: ignore[union-attr]
    assert await redis_client.get(keys.concurrency("t", agent.budget_key)) == "2"
    assert await redis_client.get(keys.budget(agent.budget_key)) == "980"


async def test_scopes_concurrency_per_target_budget_key_pair(redis_client: redis_asyncio.Redis) -> None:
    budget_key = f"scope-{random.random()}"
    setup_cfg = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=1))
    reg = await register_root(setup_cfg, RegisterRootInput(budget_key=budget_key, initial_budget=1000))
    agent = reg.agent
    limited = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=1))

    first = await request_permission(
        limited, RequestPermissionInput(agent_id=agent.agent_id, target="t1", estimated_cost=10)
    )
    second = await request_permission(
        limited, RequestPermissionInput(agent_id=agent.agent_id, target="t2", estimated_cost=10)
    )
    assert first.allowed is True
    assert second.allowed is True  # different target, separate counter


async def test_admits_exactly_the_concurrency_limit_under_real_concurrent_callers(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Invariant 13, under real contention: 20 independent connections racing for a limit of 5."""
    budget_key = f"race-{random.random()}"
    setup_cfg = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=5))
    reg = await register_root(setup_cfg, RegisterRootInput(budget_key=budget_key, initial_budget=100_000))
    agent = reg.agent

    # Build 20 real independent connections against the same test DB (mirrors the TS test's
    # redis.duplicate() for N clients) rather than reusing one client/connection pool, so the
    # race is genuine contention over Redis, not just concurrent asyncio tasks sharing one
    # connection's command queue.
    url = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")
    clients = [redis_asyncio.Redis.from_url(url, decode_responses=True) for _ in range(20)]
    try:
        configs = [parse_config(BrokerOptions(redis=c, concurrency_limit=5)) for c in clients]
        results = await asyncio.gather(
            *(
                request_permission(
                    cfg, RequestPermissionInput(agent_id=agent.agent_id, target="shared-target", estimated_cost=1)
                )
                for cfg in configs
            )
        )
        admitted = sum(1 for r in results if r.allowed)
        assert admitted == 5
        assert await redis_client.get(keys.concurrency("shared-target", agent.budget_key)) == "5"
    finally:
        await asyncio.gather(*(c.aclose() for c in clients))


async def test_admits_reserves_estimated_cost_and_records_reservation(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key=f"r{random.random()}", initial_budget=1000))
    agent = reg.agent

    result = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="groq:llama", estimated_cost=300)
    )
    assert isinstance(result, Admitted)
    assert result.reservation_id is not None

    assert await redis_client.get(keys.budget(agent.budget_key)) == "700"

    reservation = await redis_client.hgetall(keys.reservation(result.reservation_id))
    assert reservation["agentId"] == agent.agent_id
    assert reservation["budgetKey"] == agent.budget_key
    assert reservation["target"] == "groq:llama"
    assert reservation["estimatedCost"] == "300"


async def test_denies_unknown_agent(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await request_permission(
        config,
        RequestPermissionInput(agent_id=str(uuid.uuid4()), target="t", estimated_cost=1),
    )
    assert result.allowed is False
    assert result.reason == "unknown_agent"  # type: ignore[union-attr]


async def test_denies_budget_exceeded_and_reserves_nothing(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key=f"poor-{random.random()}", initial_budget=5))
    agent = reg.agent
    result = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=10)
    )
    assert result.allowed is False
    assert result.reason == "budget_exceeded"  # type: ignore[union-attr]
    assert await redis_client.get(keys.budget(agent.budget_key)) == "5"
