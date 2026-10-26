"""Integration tests for ``report_outcome``, queue mode, and the top-level ``Broker`` factory
against real Redis. Ports key cases from ``test/integration/report-outcome.test.ts``,
``test/integration/queue-mode.test.ts``, and ``test/integration/broker-public-api.test.ts``.
"""

from __future__ import annotations

import asyncio
import random

import pytest
import redis.asyncio as redis_asyncio

from agent_broker.admission import Admitted, RequestPermissionInput
from agent_broker.agents import RegisterChildInput, RegisterRootInput
from agent_broker.broker import Broker, create_broker
from agent_broker.budget import add_budget
from agent_broker.config import BrokerOptions, CircuitBreakerOptions, parse_config
from agent_broker.errors import BrokerArgumentError, BrokerConfigError
from agent_broker.queue import QueueOptions
from agent_broker.resolution import ReportDenial, ReportOutcomeInput, Resolved, report_outcome

pytestmark = pytest.mark.integration


# --- report_outcome -------------------------------------------------------------------------


async def test_report_outcome_degraded_noop_for_none_reservation_id(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await report_outcome(config, ReportOutcomeInput(reservation_id=None, success=True))
    assert isinstance(result, Resolved)
    assert result.degraded is True
    assert result.cost_unknown is True


async def test_report_outcome_requires_retryable_on_failure(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    with pytest.raises(BrokerArgumentError):
        await report_outcome(config, ReportOutcomeInput(reservation_id="x", success=False))


async def test_report_outcome_rejects_retryable_on_success(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    with pytest.raises(BrokerArgumentError):
        await report_outcome(config, ReportOutcomeInput(reservation_id="x", success=True, retryable=True))


async def test_report_outcome_resolves_a_real_reservation_end_to_end(redis_client: redis_asyncio.Redis) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client))
    root = await broker.register_root(RegisterRootInput(budget_key=f"ro-{random.random()}", initial_budget=1000))
    admit = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=250)
    )
    assert isinstance(admit, Admitted)

    result = await broker.report_outcome(
        ReportOutcomeInput(reservation_id=admit.reservation_id, success=True, actual_cost=100)
    )
    assert isinstance(result, Resolved)
    assert result.cost_unknown is False
    # estimated_cost=250 reserved (1000 -> 750), refund = estimated(250) - actual(100) = 150
    # (750 -> 900).
    assert await redis_client.get(f"budget:{len(root.budget_key)}:{root.budget_key}") == "900"


async def test_report_outcome_unknown_reservation_is_a_denial(redis_client: redis_asyncio.Redis) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    result = await report_outcome(config, ReportOutcomeInput(reservation_id="nope", success=True))
    assert isinstance(result, ReportDenial)
    assert result.reason == "unknown_reservation"


async def test_report_outcome_feeds_the_circuit_breaker_unlike_cleanup(redis_client: redis_asyncio.Redis) -> None:
    """The defining difference from cleanup: an explicit retryable failure via report_outcome
    DOES count toward the circuit breaker.
    """
    from agent_broker import keys

    config = parse_config(
        BrokerOptions(
            redis=redis_client,
            circuit_breaker=CircuitBreakerOptions(soft_threshold=1, hard_threshold=2, window_ms=60_000),
        )
    )
    broker = Broker(_config=config)
    root = await broker.register_root(RegisterRootInput(budget_key=f"ro-cb-{random.random()}", initial_budget=1000))

    for _ in range(2):
        admit = await broker.request_permission(
            RequestPermissionInput(agent_id=root.agent_id, target="feeds-circuit", estimated_cost=1)
        )
        assert isinstance(admit, Admitted)
        await broker.report_outcome(
            ReportOutcomeInput(reservation_id=admit.reservation_id, success=False, retryable=True)
        )

    assert await redis_client.get(keys.circuit_state("feeds-circuit")) == "open"


# --- register (root/child dispatch) -----------------------------------------------------------


async def test_register_dispatches_root_and_child_inputs(redis_client: redis_asyncio.Redis) -> None:
    """``Broker.register`` mirrors the TS ``broker.register()``: one method, dispatching on input type."""
    from agent_broker.agents import ChildAgent, RootAgent

    broker = create_broker(BrokerOptions(redis=redis_client))
    root = await broker.register(RegisterRootInput(budget_key=f"reg-{random.random()}", initial_budget=100))
    assert isinstance(root, RootAgent)

    child = await broker.register(RegisterChildInput(parent_id=root.agent_id))
    assert isinstance(child, ChildAgent)
    assert child.root_id == root.agent_id
    assert child.depth == root.depth + 1


# --- queue mode -------------------------------------------------------------------------------


async def test_queues_through_concurrency_exceeded_and_admits_once_the_holder_resolves(
    redis_client: redis_asyncio.Redis,
) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client, concurrency_limit=1))
    root = await broker.register_root(RegisterRootInput(budget_key=f"q1-{random.random()}", initial_budget=1000))
    holding = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1)
    )
    assert isinstance(holding, Admitted)

    queued_task = asyncio.create_task(
        broker.request_permission(
            RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1),
            QueueOptions(queue_timeout=2000),
        )
    )
    await asyncio.sleep(0.1)  # let the queued call poll at least once and genuinely wait
    await broker.report_outcome(ReportOutcomeInput(reservation_id=holding.reservation_id, success=True))

    result = await asyncio.wait_for(queued_task, timeout=3)
    assert result.allowed is True


async def test_queues_through_budget_exceeded_and_admits_once_topped_up(redis_client: redis_asyncio.Redis) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client, max_reservation_ttl=60_000))
    config = parse_config(BrokerOptions(redis=redis_client, max_reservation_ttl=60_000))
    budget_key = f"q2-{random.random()}"
    root = await broker.register_root(RegisterRootInput(budget_key=budget_key, initial_budget=0))

    queued_task = asyncio.create_task(
        broker.request_permission(
            RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=10),
            QueueOptions(queue_timeout=2000),
        )
    )
    await asyncio.sleep(0.1)
    await add_budget(config, budget_key, 10)

    result = await asyncio.wait_for(queued_task, timeout=3)
    assert result.allowed is True


async def test_queue_times_out_and_returns_queue_timeout_not_an_exception(
    redis_client: redis_asyncio.Redis,
) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client, concurrency_limit=1))
    root = await broker.register_root(RegisterRootInput(budget_key=f"q4-{random.random()}", initial_budget=1000))
    holding = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1)
    )
    assert isinstance(holding, Admitted)  # never resolved - holder keeps the slot the whole time

    result = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1),
        QueueOptions(queue_timeout=150),
    )
    assert result.allowed is False
    assert result.reason == "queue_timeout"  # type: ignore[union-attr]


async def test_queue_cancel_event_interrupts_promptly_rather_than_waiting_out_the_timeout(
    redis_client: redis_asyncio.Redis,
) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client, concurrency_limit=1))
    root = await broker.register_root(RegisterRootInput(budget_key=f"q5-{random.random()}", initial_budget=1000))
    holding = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1)
    )
    assert isinstance(holding, Admitted)

    cancel_event = asyncio.Event()
    started = asyncio.get_running_loop().time()
    task = asyncio.create_task(
        broker.request_permission(
            RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=1),
            QueueOptions(queue_timeout=30_000, cancel_event=cancel_event),  # long timeout
        )
    )
    await asyncio.sleep(0.05)
    cancel_event.set()
    result = await asyncio.wait_for(task, timeout=2)
    elapsed = asyncio.get_running_loop().time() - started

    assert result.allowed is False
    assert result.reason == "aborted"  # type: ignore[union-attr]
    assert elapsed < 2  # nowhere near the 30s queue_timeout - the cancel interrupted promptly


async def test_non_queueable_denial_returns_immediately_without_polling(redis_client: redis_asyncio.Redis) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client))
    started = asyncio.get_running_loop().time()
    result = await broker.request_permission(
        RequestPermissionInput(agent_id="does-not-exist", target="t", estimated_cost=1),
        QueueOptions(queue_timeout=10_000),
    )
    elapsed = asyncio.get_running_loop().time() - started
    assert result.allowed is False
    assert result.reason == "unknown_agent"  # type: ignore[union-attr]
    assert elapsed < 1  # returned on the first attempt, never entered the polling loop


# --- Broker (full public API composition) ----------------------------------------------------


async def test_broker_rejects_bad_config_at_construction_not_per_call(redis_client: redis_asyncio.Redis) -> None:
    with pytest.raises(BrokerConfigError):
        create_broker(BrokerOptions(redis=redis_client, concurrency_limit=0))


async def test_broker_end_to_end_register_request_report_deregister_add_budget(
    redis_client: redis_asyncio.Redis,
) -> None:
    broker = create_broker(BrokerOptions(redis=redis_client, max_depth=2))
    root = await broker.register_root(RegisterRootInput(budget_key=f"e2e-{random.random()}", initial_budget=1000))

    child = await broker.register_child(RegisterChildInput(parent_id=root.agent_id))
    assert not isinstance(child, type(None))

    admit = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="t", estimated_cost=200)
    )
    assert isinstance(admit, Admitted)

    topped_up = await broker.add_budget(root.budget_key, 500)
    assert topped_up.added is True  # type: ignore[union-attr]

    report = await broker.report_outcome(
        ReportOutcomeInput(reservation_id=admit.reservation_id, success=True, actual_cost=150)
    )
    assert isinstance(report, Resolved)

    deregistered = await broker.deregister(root.agent_id)
    assert deregistered.deregistered is True
