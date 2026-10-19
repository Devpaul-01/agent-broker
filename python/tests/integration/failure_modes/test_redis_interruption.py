"""Required failure-mode test: what happens if the Redis connection drops immediately after an
operation whose script already ran, before the caller receives the reply.

Distinct from test_redis_unavailable.py's "connection never reachable at all" scenario (a
process that can never even open a connection). This test uses a second, real client connection
whose script call genuinely executes against Redis, then is severed server-side via `CLIENT
KILL` targeting that specific connection's ID - simulating a dropped connection immediately
after the server processed the command but modeling the case where the caller cannot be
completely certain whether its own reply made it back. The key property under test: Redis's
own atomicity guarantees mean the operation either fully happened (visible to every other
client, including a fresh one reconnecting afterward) or it didn't - there is no half-applied
state to discover, regardless of what the original caller's own connection experienced.
"""

from __future__ import annotations

import asyncio
import random

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import RequestPermissionInput, request_permission
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.config import BrokerOptions, parse_config

pytestmark = pytest.mark.integration

TEST_REDIS_URL_DEFAULT = "redis://localhost:6379/15"


async def _redis_url() -> str:
    import os

    return os.environ.get("TEST_REDIS_URL", TEST_REDIS_URL_DEFAULT)


async def test_state_is_fully_applied_and_visible_even_when_the_caller_connection_is_killed_right_after(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"interrupt-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent

    # A second, independent connection - the one whose request_permission call we'll interrupt.
    url = await _redis_url()
    victim = redis_asyncio.Redis.from_url(url, decode_responses=True)
    try:
        await victim.ping()
        victim_client_id = await victim.client_id()
        victim_config = parse_config(BrokerOptions(redis=victim))

        # Run the real admission call, and concurrently (from the main, unaffected connection)
        # kill the victim connection by its client ID the instant the call completes server-side
        # - there is no way to interrupt strictly "mid-script" from outside Redis (Lua scripts
        # run atomically, single-threaded, with no I/O yield point to interrupt at), so this
        # tests the realistic adjacent case: the server finished applying the script, and the
        # connection carrying the reply back is severed essentially immediately after.
        admit_task = asyncio.create_task(
            request_permission(
                victim_config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=250)
            )
        )
        await asyncio.sleep(0)  # yield once so admit_task's EVALSHA is actually in flight
        try:
            await redis_client.client_kill_filter(id=victim_client_id)
        except Exception:
            pass  # the call may have already completed and the connection already idle/closed

        # The task may raise (connection error surfacing as the call's own exception) or
        # complete normally (if the kill lost the race against an already-completed round
        # trip) - both are acceptable; what matters is Redis's own state afterward.
        try:
            await admit_task
        except Exception:
            pass
    finally:
        try:
            await victim.aclose()
        except Exception:
            pass

    # Verify via a THIRD, fresh connection that the state is fully consistent: either the
    # admission fully happened (budget decremented, exactly one reservation, concurrency
    # incremented) or it didn't happen at all (budget untouched, no reservation) - never a
    # partial combination of the two.
    balance = await redis_client.get(keys.budget(agent.budget_key))
    reservation_keys = await redis_client.keys("reservation:*")
    concurrency = await redis_client.get(keys.concurrency("t", agent.budget_key))

    fully_admitted = balance == "750" and len(reservation_keys) == 1 and concurrency == "1"
    fully_denied = balance == "1000" and len(reservation_keys) == 0 and concurrency in (None, "0")
    assert fully_admitted or fully_denied, (
        f"inconsistent partial state: balance={balance}, reservations={reservation_keys}, "
        f"concurrency={concurrency}"
    )


async def test_repeated_interruption_never_produces_a_negative_balance(
    redis_client: redis_asyncio.Redis,
) -> None:
    """Runs the interrupt-right-after-the-call pattern several times in a row against the same
    budget pool, to rule out an interruption-timing-dependent edge case that a single run might
    get lucky and not hit.
    """
    config = parse_config(BrokerOptions(redis=redis_client, concurrency_limit=100))
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"interrupt-repeat-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent
    url = await _redis_url()

    for _ in range(5):
        victim = redis_asyncio.Redis.from_url(url, decode_responses=True)
        try:
            await victim.ping()
            victim_id = await victim.client_id()
            victim_config = parse_config(BrokerOptions(redis=victim, concurrency_limit=100))
            task = asyncio.create_task(
                request_permission(
                    victim_config, RequestPermissionInput(agent_id=agent.agent_id, target="t2", estimated_cost=50)
                )
            )
            await asyncio.sleep(0)
            try:
                await redis_client.client_kill_filter(id=victim_id)
            except Exception:
                pass
            try:
                await task
            except Exception:
                pass
        finally:
            try:
                await victim.aclose()
            except Exception:
                pass

    balance = await redis_client.get(keys.budget(agent.budget_key))
    assert balance is not None
    assert int(balance) >= 0  # never overdrawn, however many interruptions landed mid-flight
    assert int(balance) <= 1000  # never over-refunded either


async def test_caller_retries_report_outcome_after_presuming_its_response_was_lost(
    redis_client: redis_asyncio.Redis,
) -> None:
    """The specific 'lost response' scenario from the project brief: Redis successfully applies
    report_outcome, but the caller times out / loses its connection before seeing the reply, so
    it reasonably retries the exact same report_outcome call believing the first attempt never
    landed. The resolved flag's idempotency (already proven for in-process concurrent calls in
    test_resolution_and_cleanup.py) must hold here too: the retry must be a safe no-op
    (already_resolved), not a second refund.
    """
    from agent_broker.resolution import ResolveOutcome, ResolveParams, ResolveSkipped, resolve_reservation

    config = parse_config(BrokerOptions(redis=redis_client))
    reg = await register_root(
        config, RegisterRootInput(budget_key=f"lost-response-{random.random()}", initial_budget=1000)
    )
    agent = reg.agent
    admit = await request_permission(
        config, RequestPermissionInput(agent_id=agent.agent_id, target="t", estimated_cost=300)
    )
    assert admit.allowed is True  # type: ignore[union-attr]

    params = ResolveParams(
        reservation_id=admit.reservation_id,  # type: ignore[union-attr]
        budget_key=agent.budget_key,
        target="t",
        success=False,
        feeds_circuit=False,
        window_ms=config.circuit_breaker.window_ms,
        hard_threshold=config.circuit_breaker.hard_threshold,
    )

    # First attempt: genuinely applies.
    first = await resolve_reservation(config, params)
    assert isinstance(first, ResolveOutcome)
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"

    # Caller presumes this was lost (e.g. it never saw the reply due to a dropped connection,
    # as in the test above) and retries the identical call.
    retry = await resolve_reservation(config, params)
    assert isinstance(retry, ResolveSkipped)
    assert retry.reason == "already_resolved"

    # The critical assertion: balance is unchanged by the retry. A bug here would silently
    # double-refund every time a caller's retry-on-presumed-loss logic fired.
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"
