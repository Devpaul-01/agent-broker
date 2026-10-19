"""Required failure-mode test: two workers race to clean up the SAME specific expired
reservation at the same instant.

Distinct from the existing budget-contention test (many workers admitting against a shared
budget — proving the admission script's atomicity) and from the existing idempotent-resolve
test in test_resolution_and_cleanup.py (sequential/in-process concurrent resolve_reservation
calls) - this test specifically targets the lazy-cleanup code path, with the race happening at
the Python-process level via real asyncio tasks sharing one Redis connection pool each, deliberately
synchronized via a barrier so both see the exact same expired candidate in the sorted set before
either one calls resolve_reservation on it.
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

pytestmark = pytest.mark.integration


async def test_two_concurrent_cleanup_sweeps_racing_the_same_expired_reservation_refund_once(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(
        BrokerOptions(redis=redis_client, default_reservation_ttl=50, max_reservation_ttl=60_000)
    )
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"competing-cleanup-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent
    admit = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=250, ttl=50)
    )
    assert isinstance(admit, Admitted)
    assert await redis_client.get(keys.budget(agent.budget_key)) == "750"

    await asyncio.sleep(0.15)  # let the 50ms TTL's logical expiry pass

    # Fire two independent sweep calls at the same instant, both of which will see the same
    # single expired candidate in the sorted set - genuine contention on one specific
    # reservation, not merely "many workers calling cleanup in general."
    await asyncio.gather(
        sweep_expired_reservations(config),
        sweep_expired_reservations(config),
    )

    # Exactly one refund applied, never two, regardless of which sweep's resolve_reservation
    # call actually won the race inside Redis.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"
    assert await redis_client.zrank(keys.reservations_expiring(), admit.reservation_id) is None  # type: ignore[arg-type]


async def test_many_concurrent_sweeps_race_several_expired_reservations_each_refunded_once(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Scales the same invariant up: 5 expired reservations, 10 concurrent sweep calls racing
    to clean them all up - every reservation refunded exactly once regardless of how the 10
    sweeps' CLEANUP_BATCH_SIZE-bounded candidate lists overlap.
    """
    config = parse_config(
        BrokerOptions(redis=redis_client, default_reservation_ttl=50, max_reservation_ttl=60_000)
    )
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"competing-cleanup-many-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent

    for _ in range(5):
        admit = await request_permission(
            config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=100, ttl=50)
        )
        assert isinstance(admit, Admitted)
    assert await redis_client.get(keys.budget(agent.budget_key)) == "500"

    await asyncio.sleep(0.15)
    await asyncio.gather(*(sweep_expired_reservations(config) for _ in range(10)))

    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"
    assert await redis_client.zcard(keys.reservations_expiring()) == 0
