"""A more realistic example: a worker pool pattern. A root agent represents one end-user's
session; each concurrent call it makes delegates to a short-lived child agent so the broker's
depth and identity tracking reflect the real shape of the work, not just one flat agent calling
everything. Demonstrates: delegation, retryable-failure reporting (circuit-breaker feedback),
and queue mode for a call that's willing to wait for a slot rather than fail immediately.

Run with a local Redis reachable at redis://localhost:6379:

    python3 -m pip install -e .
    python3 examples/realistic_worker.py
"""

from __future__ import annotations

import asyncio
import random

import redis.asyncio as redis

from agent_broker import (
    Admitted,
    BrokerOptions,
    QueueOptions,
    RegisterChildInput,
    RegisterDenial,
    RegisterRootInput,
    ReportOutcomeInput,
    RequestPermissionInput,
    create_broker,
)
from agent_broker.broker import Broker


async def handle_one_call(broker: Broker, root_agent_id: str, target: str, call_index: int) -> None:
    """Simulates one downstream call made on behalf of a session, via a dedicated child agent."""
    child = await broker.register(RegisterChildInput(parent_id=root_agent_id))
    if isinstance(child, RegisterDenial):
        print(f"call {call_index}: could not register child agent: {child.reason}")
        return

    # Willing to wait up to 5s for a concurrency slot or budget to free up, rather than
    # failing the whole call immediately on first denial.
    decision = await broker.request_permission(
        RequestPermissionInput(agent_id=child.agent_id, target=target, estimated_cost=50),
        QueueOptions(queue_timeout=5_000),
    )
    if not isinstance(decision, Admitted):
        print(f"call {call_index}: denied after queueing: {decision.reason}")
        return

    # Simulate the real call, including an occasional transient failure, to show the
    # retryable=True reporting path that feeds the shared circuit breaker.
    await asyncio.sleep(0.01)
    simulated_failure = random.random() < 0.1

    if simulated_failure:
        await broker.report_outcome(
            ReportOutcomeInput(reservation_id=decision.reservation_id, success=False, retryable=True)
        )
        print(f"call {call_index}: simulated transient failure, reported as retryable")
    else:
        actual_cost = random.randint(30, 50)
        await broker.report_outcome(
            ReportOutcomeInput(reservation_id=decision.reservation_id, success=True, actual_cost=actual_cost)
        )
        print(f"call {call_index}: succeeded, cost {actual_cost}")


async def main() -> None:
    client = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    broker = create_broker(BrokerOptions(redis=client, concurrency_limit=3))

    root = await broker.register(RegisterRootInput(budget_key="example-session", initial_budget=2000))
    print(f"session {root.agent_id} funded with budget pool {root.budget_key!r}")

    # Fire 10 concurrent calls through a concurrency limit of 3 - most will need to queue.
    await asyncio.gather(
        *(handle_one_call(broker, root.agent_id, "example:model", i) for i in range(10))
    )

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
