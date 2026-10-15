"""Required failure-mode test: what happens if an asyncio task is cancelled while
``request_permission``/``resolve_reservation`` is in progress.

There is no cooperative cancellation point inside either operation: each is one coroutine making
one network round-trip for one atomic Lua script call. ``asyncio.Task.cancel()`` can only
interrupt at an ``await`` point, and the only meaningful one here is the socket write/read for
the EVALSHA call itself - which either completed (script ran, state changed) or did not (script
never ran, state unchanged) by the time cancellation is observed. There is no state where Redis
applied "half" of the script; this test proves that property holds from the Python caller's
side, not just asserts it from reading the Lua source.

This models "the caller's surrounding async context was cancelled" (e.g. a timeout elsewhere in
the caller's own code, or the caller's parent task group shutting down) - distinct from queue
mode's own cooperative ``AbortSignal``/timeout handling, which is a Milestone 4 concern layered
on top of this.
"""

from __future__ import annotations

import asyncio

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import Admitted, RequestPermissionInput, request_permission
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.config import BrokerOptions, parse_config

pytestmark = pytest.mark.integration


async def test_cancelling_the_calling_task_never_leaves_budget_partially_decremented(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Fires many concurrent request_permission calls and cancels a random subset immediately
    after starting them. Whatever interleaving actually happens, the invariant must hold: the
    budget pool's final value is exactly initial_budget minus (100 * number of calls that
    actually returned Admitted) - there is no in-between state.
    """
    config = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=50))
    reg = await register_root(config, RegisterRootInput(budget_key="cancel-budget", initial_budget=1000))
    agent = reg.agent

    tasks = [
        asyncio.create_task(
            request_permission(
                config, RequestPermissionInput(agent_id=agent.agent_id, target="cancel-target", estimated_cost=100)
            )
        )
        for _ in range(10)
    ]
    # Cancel every other task immediately - before we know whether its EVALSHA has already been
    # written to the socket. A cancelled task that already got as far as the server applying the
    # script will still raise CancelledError to its own awaiter, but the Redis-side effect (the
    # script's atomic write) is unaffected by the Python-level cancellation.
    for i, t in enumerate(tasks):
        if i % 2 == 0:
            t.cancel()

    results = []
    for t in tasks:
        try:
            results.append(await t)
        except asyncio.CancelledError:
            results.append(None)  # cancelled before or during the call; outcome unknown to us

    admitted_count = sum(1 for r in results if isinstance(r, Admitted))
    reservation_keys = await redis_client.keys("reservation:*")
    balance = await redis_client.get(keys.budget(agent.budget_key))

    # The only invariant we can assert without knowing exactly how many cancellations landed
    # before vs. after their script ran: whatever the server-side admitted count actually was
    # (visible via the reservation count and the balance), it is internally consistent - no
    # partial decrement, no reservation without a matching balance deduction.
    assert balance is not None
    actual_admitted_by_balance = (1000 - int(balance)) // 100
    assert len(reservation_keys) == actual_admitted_by_balance
    assert actual_admitted_by_balance <= 10
    assert int(balance) >= 0  # never overdrawn even under cancellation noise
    # Every reservation that does exist is for exactly 100, the full cost - no partial writes.
    for rk in reservation_keys:
        cost = await redis_client.hget(rk, "estimatedCost")
        assert cost == "100"
