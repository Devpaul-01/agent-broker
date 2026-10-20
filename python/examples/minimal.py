"""Minimal example: register an agent, ask permission, report the outcome.

Run with a local Redis reachable at redis://localhost:6379:

    python3 -m pip install -e .
    python3 examples/minimal.py
"""

from __future__ import annotations

import asyncio

import redis.asyncio as redis

from agent_broker import (
    BrokerOptions,
    RegisterRootInput,
    ReportOutcomeInput,
    RequestPermissionInput,
    create_broker,
)


async def main() -> None:
    client = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    broker = create_broker(BrokerOptions(redis=client))

    # A root agent owns (or shares) a budget pool. budget_key defaults to the agent's own id if
    # omitted, which makes it private by default - pass the same budget_key across unrelated
    # root agents only when you actually want them to share one spending pool.
    root = await broker.register_root(RegisterRootInput(budget_key="example-user", initial_budget=1000))
    print(f"registered root agent {root.agent_id}, budget pool {root.budget_key!r}")

    decision = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="example:model", estimated_cost=100)
    )
    if not decision.allowed:
        print(f"denied: {decision.reason}")
        await client.aclose()
        return

    print(f"admitted, reservation {decision.reservation_id}")

    # Pretend this is your real call to whatever `target` represents - agent-broker has no
    # opinion about what it does or how.
    actual_cost = 80

    result = await broker.report_outcome(
        ReportOutcomeInput(reservation_id=decision.reservation_id, success=True, actual_cost=actual_cost)
    )
    print(f"reported outcome: cost_unknown={result.cost_unknown}")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
