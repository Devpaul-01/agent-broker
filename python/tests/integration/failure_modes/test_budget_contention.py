"""Required failure-mode test: budget contention across genuinely independent OS processes.

Ports ``test/integration/failure-modes/budget-contention.test.ts``. Proves the shared budget
pool can never be overdrawn by concurrent admission across real processes — not just concurrent
asyncio tasks inside one interpreter (already covered by the in-process 20-connection race in
``test_request_permission.py``), but separate processes with no shared memory, each reaching
Redis independently.
"""

from __future__ import annotations

import os

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.config import BrokerOptions, parse_config

from .._process_harness import WorkerTask, run_in_processes

pytestmark = pytest.mark.integration

_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


async def test_admits_exactly_enough_to_exhaust_budget_never_more_across_20_processes(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Room for exactly 10 calls of cost 100, raced by 20 independent processes - sized so the
    test fails loudly (admitted != 10) rather than ambiguously if atomicity breaks under real
    process contention.
    """
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(
        config, RegisterRootInput(budget_key="cross-process-budget", initial_budget=1000)
    )
    agent = reg.agent

    tasks = [
        WorkerTask(
            task="request_permission",
            params={"agent_id": agent.agent_id, "target": "shared-target", "estimated_cost": 100},
        )
        for _ in range(20)
    ]
    results = await run_in_processes(_REDIS_URL, tasks)

    errored = [r for r in results if not r["ok"]]
    assert errored == [], f"worker-level errors (a crashed worker reporting as denied would be a false pass): {errored}"

    admitted = [r for r in results if r["result"].allowed is True]
    denied = [r for r in results if r["result"].allowed is False]
    assert len(admitted) == 10
    assert len(denied) == 10

    # The actual invariant: the pool lands at exactly zero, never negative, regardless of how
    # many of the 20 processes raced for it at the same instant.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "0"

    reservation_keys = await redis_client.keys("reservation:*")
    assert len(reservation_keys) == 10


async def test_scales_to_a_tighter_race_30_processes_for_exactly_3_admissions(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(config, RegisterRootInput(budget_key="tight-budget", initial_budget=30))
    agent = reg.agent

    tasks = [
        WorkerTask(
            task="request_permission",
            params={"agent_id": agent.agent_id, "target": "tight-target", "estimated_cost": 10},
        )
        for _ in range(30)
    ]
    results = await run_in_processes(_REDIS_URL, tasks)

    errored = [r for r in results if not r["ok"]]
    assert errored == [], f"worker-level errors: {errored}"

    admitted = [r for r in results if r["result"].allowed is True]
    assert len(admitted) == 3
    assert await redis_client.get(keys.budget(agent.budget_key)) == "0"
