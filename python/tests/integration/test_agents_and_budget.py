"""Integration tests for ``register_child``, ``deregister``, and ``add_budget`` against real
Redis. Ports the key cases from ``test/integration/register-child.test.ts``,
``test/integration/deregister.test.ts``, and ``test/integration/add-budget.test.ts``.
"""

from __future__ import annotations

import random

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import Admitted, RequestPermissionInput, request_permission
from agent_broker.agents import (
    ChildAgent,
    RegisterChildInput,
    RegisterDenial,
    RegisterRootInput,
    deregister,
    register_child,
    register_root,
)
from agent_broker.budget import AddBudgetDenial, AddBudgetResult, add_budget
from agent_broker.config import BrokerOptions, parse_config
from agent_broker.errors import BrokerArgumentError
from agent_broker.resolution import ResolveParams, resolve_reservation

pytestmark = pytest.mark.integration


async def _agent_count(redis_client: redis_asyncio.Redis) -> int:
    return len(await redis_client.keys("agent:*"))


# --- register_child -----------------------------------------------------------------------


async def test_child_derives_depth_root_and_budget_key_without_touching_parent_ttl(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(BrokerOptions(redis=redis_client, max_depth=3))
    reg = await register_root(config, RegisterRootInput(budget_key="user-1", initial_budget=100))
    root = reg.agent
    await redis_client.pexpire(keys.agent(root.agent_id), 5_000)

    result = await register_child(config, RegisterChildInput(parent_id=root.agent_id))
    assert isinstance(result, ChildAgent)
    assert result.depth == 1
    assert result.root_id == root.agent_id
    assert result.budget_key == "user-1"
    assert result.agent_id != root.agent_id

    child_hash = await redis_client.hgetall(keys.agent(result.agent_id))
    assert child_hash["parentId"] == root.agent_id
    assert child_hash["depth"] == "1"
    assert child_hash["rootId"] == root.agent_id
    assert child_hash["budgetKey"] == "user-1"

    child_ttl = await redis_client.pttl(keys.agent(result.agent_id))
    assert child_ttl > 0
    # Registration does not refresh the parent's heartbeat/TTL - only request_permission and
    # resolve_reservation do that.
    root_ttl = await redis_client.pttl(keys.agent(root.agent_id))
    assert root_ttl <= 5_000


async def test_allows_chain_to_max_depth_and_denies_one_more_without_writing_state(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(BrokerOptions(redis=redis_client, max_depth=3))
    reg = await register_root(config, RegisterRootInput(budget_key="k", initial_budget=10))
    parent_id = reg.agent.agent_id

    for depth in range(1, 4):
        child = await register_child(config, RegisterChildInput(parent_id=parent_id))
        assert isinstance(child, ChildAgent)
        assert child.depth == depth
        parent_id = child.agent_id

    assert await _agent_count(redis_client) == 4  # root + 3 children

    over = await register_child(config, RegisterChildInput(parent_id=parent_id))
    assert isinstance(over, RegisterDenial)
    assert over.reason == "depth_exceeded"
    assert await _agent_count(redis_client) == 4  # denial wrote nothing


async def test_denies_unknown_parent(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await register_child(config, RegisterChildInput(parent_id="does-not-exist"))
    assert isinstance(result, RegisterDenial)
    assert result.reason == "unknown_agent"


async def test_register_child_rejects_empty_parent_id(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    with pytest.raises(BrokerArgumentError):
        await register_child(config, RegisterChildInput(parent_id=""))


# --- deregister -----------------------------------------------------------------------------


async def test_deregister_removes_the_agent_record(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key=f"d{random.random()}", initial_budget=10))
    agent_id = reg.agent.agent_id

    result = await deregister(config, agent_id)
    assert result.deregistered is True
    assert await redis_client.exists(keys.agent(agent_id)) == 0


async def test_deregister_already_gone_is_a_successful_noop(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await deregister(config, "never-existed")
    assert result.deregistered is False


async def test_deregister_does_not_block_resolving_an_outstanding_reservation(
    redis_client: redis_asyncio.Redis,
) -> None:
    """A reservation carries its own budget_key/target - resolution must work even after the
    owning agent has been deregistered, exactly as it would after the agent simply expired.
    """
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key=f"d2-{random.random()}", initial_budget=1000))
    agent = reg.agent
    admit = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=100)
    )
    assert isinstance(admit, Admitted)

    await deregister(config, agent.agent_id)
    assert await redis_client.exists(keys.agent(agent.agent_id)) == 0

    outcome = await resolve_reservation(
        config,
        ResolveParams(
            reservation_id=admit.reservation_id,  # type: ignore[arg-type]
            budget_key=agent.budget_key,
            target="t",
            success=False,
            feeds_circuit=False,
            window_ms=config.circuit_breaker.window_ms,
            hard_threshold=config.circuit_breaker.hard_threshold,
        ),
    )
    assert outcome.resolved is True  # type: ignore[union-attr]
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"


# --- add_budget -----------------------------------------------------------------------------


async def test_add_budget_increments_an_existing_pool(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    budget_key = f"ab-{random.random()}"
    await register_root(config, RegisterRootInput(budget_key=budget_key, initial_budget=100))

    result = await add_budget(config, budget_key, 50)
    assert isinstance(result, AddBudgetResult)
    assert result.new_balance == 150
    assert await redis_client.get(keys.budget(budget_key)) == "150"


async def test_add_budget_denies_unknown_pool_and_creates_nothing(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await add_budget(config, "never-existed-pool", 50)
    assert isinstance(result, AddBudgetDenial)
    assert result.reason == "unknown_budget"
    # Critically: must not have silently created the key via a bare INCRBY-style hazard.
    assert await redis_client.exists(keys.budget("never-existed-pool")) == 0


async def test_add_budget_rejects_non_positive_amount(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    with pytest.raises(BrokerArgumentError):
        await add_budget(config, "whatever", 0)
    with pytest.raises(BrokerArgumentError):
        await add_budget(config, "whatever", -5)
