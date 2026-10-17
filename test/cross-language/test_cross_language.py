"""Cross-language integration tests: a real TypeScript process and a real Python process,
each running the actual library in its own language, coordinating through the same Redis
instance. This is what proves the shared protocol (key construction, Lua scripts, serialization)
documented in docs/python-port/ARCHITECTURE.md actually holds — not just that each language's
own test suite passes independently.

Required scenarios, from the project brief and docs/python-port/IMPLEMENTATION_PLAN.md's
Milestone 5 section:
  - TS registers a root agent, Python calls request_permission against it.
  - Python registers, TS resolves.
  - Both languages racing for the same budget pool.
  - One language's retryable failures open the circuit breaker, observed by the other.
  - Cleanup sweep triggered by one language resolves a reservation created by the other.

Run with: `cd python && python3 -m pytest ../test/cross-language/test_cross_language.py -v`
(requires a reachable Redis - see docs/python-port/BASELINE.md for provisioning - and `npx`
on PATH for the TypeScript worker).
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

import pytest
import redis.asyncio as redis_asyncio

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python", "src"))
from harness import WorkerHandle, kill_all, spawn_workers  # noqa: E402
from agent_broker import keys  # noqa: E402

pytestmark = pytest.mark.integration

TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


@pytest.fixture
async def redis_client() -> redis_asyncio.Redis:
    client = redis_asyncio.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    await client.ping()
    await client.flushdb()
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def workers(redis_client: redis_asyncio.Redis) -> tuple[WorkerHandle, WorkerHandle]:
    handles = await spawn_workers(["typescript", "python"])
    try:
        yield (handles[0], handles[1])  # (ts, py)
    finally:
        kill_all(handles)


async def test_ts_registers_python_admits_against_it(
    redis_client: redis_asyncio.Redis, workers: tuple[WorkerHandle, WorkerHandle]
) -> None:
    ts, py = workers
    reg = await ts.run("registerRoot", {"budgetKey": "xlang-ts-reg", "initialBudget": 1000})
    assert reg.ok
    agent_id = reg.result["agentId"]

    admit = await py.run("requestPermission", {"agentId": agent_id, "target": "t", "estimatedCost": 300})
    assert admit.ok
    assert admit.result["allowed"] is True
    assert admit.result["reservationId"] is not None

    # Verify directly against Redis, not just trusting either worker's self-report.
    balance = await redis_client.get(keys.budget("xlang-ts-reg"))
    assert balance == "700"


async def test_python_registers_ts_resolves(
    redis_client: redis_asyncio.Redis, workers: tuple[WorkerHandle, WorkerHandle]
) -> None:
    ts, py = workers
    reg = await py.run("registerRoot", {"budgetKey": "xlang-py-reg", "initialBudget": 1000})
    assert reg.ok
    agent_id = reg.result["agentId"]

    admit = await py.run("requestPermission", {"agentId": agent_id, "target": "t", "estimatedCost": 300})
    assert admit.ok
    reservation_id = admit.result["reservationId"]

    resolve = await ts.run(
        "reportOutcome", {"reservationId": reservation_id, "success": True, "actualCost": 100}
    )
    assert resolve.ok
    assert resolve.result["allowed"] is True

    # reserved 300 (1000->700), refund = 300-100=200 (700->900)
    balance = await redis_client.get(keys.budget("xlang-py-reg"))
    assert balance == "900"


async def test_both_languages_race_for_the_same_budget_pool(
    redis_client: redis_asyncio.Redis, workers: tuple[WorkerHandle, WorkerHandle]
) -> None:
    """Room for exactly 5 admissions of cost 10, raced by both a TS and a Python process
    sending concurrent requests - the cross-language version of the Milestone 3
    budget-contention failure-mode test.
    """
    ts, py = workers
    budget_key = "xlang-race"
    reg = await ts.run("registerRoot", {"budgetKey": budget_key, "initialBudget": 50})
    assert reg.ok
    agent_id = reg.result["agentId"]

    # Fire 5 requests from each language concurrently (10 total, room for exactly 5).
    results = await asyncio.gather(
        *(
            (ts if i % 2 == 0 else py).run(
                "requestPermission", {"agentId": agent_id, "target": "race-target", "estimatedCost": 10}
            )
            for i in range(10)
        )
    )
    admitted = [r for r in results if r.ok and r.result["allowed"] is True]
    denied = [r for r in results if r.ok and r.result["allowed"] is False]
    assert len(admitted) == 5
    assert len(denied) == 5
    balance = await redis_client.get(keys.budget(budget_key))
    assert balance == "0"


async def test_one_languages_failures_open_the_circuit_observed_by_the_other(
    redis_client: redis_asyncio.Redis, workers: tuple[WorkerHandle, WorkerHandle]
) -> None:
    ts, py = workers
    config = {"circuitBreaker": {"softThreshold": 1, "hardThreshold": 2, "windowMs": 60000, "probeRate": 0.0001}}
    reg = await py.run("registerRoot", {"budgetKey": "xlang-circuit", "initialBudget": 1000}, config=config)
    assert reg.ok
    agent_id = reg.result["agentId"]

    # TS admits and reports two retryable failures against "flaky-xlang" - enough to open it.
    for _ in range(2):
        admit = await ts.run(
            "requestPermission",
            {"agentId": agent_id, "target": "flaky-xlang", "estimatedCost": 1},
            config=config,
        )
        assert admit.ok and admit.result["allowed"] is True
        report = await ts.run(
            "reportOutcome",
            {"reservationId": admit.result["reservationId"], "success": False, "retryable": True},
            config=config,
        )
        assert report.ok

    # Python observes the circuit as open against the same target.
    denied = await py.run(
        "requestPermission", {"agentId": agent_id, "target": "flaky-xlang", "estimatedCost": 1}, config=config
    )
    assert denied.ok
    assert denied.result["allowed"] is False
    assert denied.result["reason"] == "circuit_open"

    assert await redis_client.get(keys.circuit_state("flaky-xlang")) == "open"


async def test_cleanup_by_one_language_resolves_a_reservation_created_by_the_other(
    redis_client: redis_asyncio.Redis, workers: tuple[WorkerHandle, WorkerHandle]
) -> None:
    """Python creates a reservation with a short TTL and never resolves it; TS's own lazy
    cleanup sweep (triggered by its next request_permission call) must recover it - proving
    cleanup is not scoped to "reservations this process created."
    """
    ts, py = workers
    config = {"defaultReservationTtl": 100, "maxReservationTtl": 60000}
    budget_key = "xlang-cleanup"
    reg = await py.run("registerRoot", {"budgetKey": budget_key, "initialBudget": 1000}, config=config)
    assert reg.ok
    agent_id = reg.result["agentId"]

    admit = await py.run(
        "requestPermission",
        {"agentId": agent_id, "target": "xlang-cleanup-target", "estimatedCost": 250},
        config=config,
    )
    assert admit.ok and admit.result["allowed"] is True

    balance_after_reserve = await redis_client.get(keys.budget(budget_key))
    assert balance_after_reserve == "750"

    await asyncio.sleep(0.3)  # let the 100ms TTL's logical expiry pass

    # TS's own request_permission call triggers its lazy cleanup sweep as a side effect, which
    # must find and resolve Python's abandoned reservation.
    other_agent = await ts.run("registerRoot", {"budgetKey": "xlang-cleanup-trigger", "initialBudget": 10})
    assert other_agent.ok
    trigger = await ts.run(
        "requestPermission",
        {"agentId": other_agent.result["agentId"], "target": "unrelated-target", "estimatedCost": 1},
    )
    assert trigger.ok

    balance_after_cleanup = await redis_client.get(keys.budget(budget_key))
    assert balance_after_cleanup == "1000"  # full refund, recovered by TS's cleanup sweep
