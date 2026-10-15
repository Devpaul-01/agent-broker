"""Integration tests for ``on_redis_unavailable`` behavior under a genuine connection failure.

Ports ``test/integration/redis-unavailable.test.ts``. A deliberately unreachable address
simulates a real connection failure without needing to stop the shared test Redis (other tests
in the same run still need it).
"""

from __future__ import annotations

import redis.asyncio as redis_asyncio
import pytest

from agent_broker.admission import Admitted, Denied, RequestPermissionInput, request_permission
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.config import BrokerOptions, parse_config
from agent_broker.errors import BrokerArgumentError

pytestmark = pytest.mark.integration


def _unreachable_redis() -> redis_asyncio.Redis:
    # Port 1 is a privileged, essentially-never-listening port — the same deliberate-dead-end
    # approach the TS suite uses (127.0.0.1:1), rather than picking an ephemeral port that
    # might flakily have something bound to it.
    return redis_asyncio.Redis.from_url(
        "redis://127.0.0.1:1", decode_responses=True, socket_connect_timeout=0.3, retry_on_timeout=False
    )


async def test_deny_default_returns_denial_rather_than_raising(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key="unavailable-test", initial_budget=1000))
    agent_id = reg.agent.agent_id

    broken = _unreachable_redis()
    try:
        broken_config = parse_config(BrokerOptions(redis=broken, on_redis_unavailable="deny"))
        result = await request_permission(
            broken_config, RequestPermissionInput(agent_id=agent_id, target="t", estimated_cost=1)
        )
        assert isinstance(result, Denied)
        assert result.reason == "redis_unavailable"
    finally:
        await broken.aclose()


async def test_allow_admits_without_a_reservation_and_marks_degraded(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key="unavailable-test-2", initial_budget=1000))
    agent_id = reg.agent.agent_id

    broken = _unreachable_redis()
    try:
        broken_config = parse_config(BrokerOptions(redis=broken, on_redis_unavailable="allow"))
        result = await request_permission(
            broken_config, RequestPermissionInput(agent_id=agent_id, target="t", estimated_cost=1)
        )
        assert isinstance(result, Admitted)
        assert result.reservation_id is None
        assert result.degraded is True
    finally:
        await broken.aclose()


async def test_validation_error_is_not_swallowed_as_redis_unavailable_even_with_allow(
    redis_client: redis_asyncio.Redis,
) -> None:
    """A real BrokerArgumentError (validation, thrown before any Redis call) must propagate as
    itself - never be reinterpreted as a degraded/Redis-unavailable fallback.
    """
    config = parse_config(BrokerOptions(redis=redis_client, on_redis_unavailable="allow"))
    with pytest.raises(BrokerArgumentError):
        await request_permission(config, RequestPermissionInput(agent_id="", target="t", estimated_cost=1))


async def test_unreachable_redis_with_a_healthy_fallback_client_is_still_a_real_outage(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Confirms is_redis_unavailable_error's narrowness end-to-end: pointing at a genuinely
    unreachable host raises a connection-level error that request_permission correctly
    classifies as Redis-unavailable, not as some other unexpected-reply bug.
    """
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key="unavailable-test-3", initial_budget=1000))
    agent_id = reg.agent.agent_id

    broken = _unreachable_redis()
    try:
        broken_config = parse_config(BrokerOptions(redis=broken, on_redis_unavailable="deny"))
        # Call twice - the first call establishes (and fails to establish) the connection, the
        # second exercises the already-known-broken path. Both must behave identically.
        for _ in range(2):
            result = await request_permission(
                broken_config, RequestPermissionInput(agent_id=agent_id, target="t", estimated_cost=1)
            )
            assert isinstance(result, Denied)
            assert result.reason == "redis_unavailable"
    finally:
        await broken.aclose()
