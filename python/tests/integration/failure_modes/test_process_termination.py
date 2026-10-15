"""Required failure-mode test: a process terminates between reservation and resolution.

No direct TS equivalent test file exists under this exact name, but the scenario is explicitly
required by the project brief ("What happens if a process exits between reservation and
reconciliation?") and the behavior is fully documented in both implementations: an abandoned
reservation is recovered by the next ``request_permission``'s lazy-cleanup sweep, refunded in
full, and never counted against the circuit breaker (see ``cleanup.py``'s docstring and
``test_resolution_and_cleanup.py``'s existing in-process cleanup tests). This test proves it
specifically for a reservation whose owning *process* is actually gone — not just one that was
never resolved within the same process — by using ``SIGKILL`` on a real child process holding
the only reference to the reservation, so there is no possibility of an in-process finally/atexit
handler quietly resolving it.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import signal

import pytest
import redis.asyncio as redis_asyncio

from agent_broker import keys
from agent_broker.admission import RequestPermissionInput
from agent_broker.agents import RegisterRootInput, register_root
from agent_broker.cleanup import sweep_expired_reservations
from agent_broker.config import BrokerOptions, parse_config

pytestmark = pytest.mark.integration

_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


def _admit_then_hang(redis_url: str, agent_id: str, ready: "multiprocessing.synchronize.Event") -> None:
    """Runs in a child process: admits a reservation with a short TTL, signals the parent it's
    done, then hangs forever (simulating a process that will be killed before it ever reports
    its own outcome).
    """
    import redis.asyncio as redis_asyncio

    from agent_broker.admission import RequestPermissionInput, request_permission
    from agent_broker.config import BrokerOptions, parse_config

    async def _run() -> None:
        client = redis_asyncio.Redis.from_url(redis_url, decode_responses=True)
        config = parse_config(BrokerOptions(redis=client, default_reservation_ttl=200, max_reservation_ttl=60_000))
        await request_permission(
            config, RequestPermissionInput(agent_id=agent_id, target="crash-target", estimated_cost=250)
        )
        await client.aclose()

    asyncio.run(_run())
    ready.set()
    # Hang until SIGKILL'd by the parent - this process never calls resolve_reservation,
    # modelling a real crash (not a graceful shutdown with a finally-block cleanup).
    signal.pause()


async def test_reservation_survives_owning_process_being_sigkilled_and_is_recovered_by_cleanup(
    redis_client: redis_asyncio.Redis,
) -> None:
    config = parse_config(
        BrokerOptions(redis=redis_client, default_reservation_ttl=200, max_reservation_ttl=60_000)
    )
    reg = await register_root(
        config, RegisterRootInput(budget_key="crash-budget", initial_budget=1000)
    )
    agent = reg.agent
    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"

    ctx = multiprocessing.get_context("spawn")
    ready = ctx.Event()
    proc = ctx.Process(target=_admit_then_hang, args=(_REDIS_URL, agent.agent_id, ready))
    proc.start()
    try:
        signaled = await asyncio.get_running_loop().run_in_executor(None, ready.wait, 10)
        assert signaled, "child process never reached the post-admission signal in time"

        # The reservation genuinely exists and the budget was genuinely reserved - this is not
        # a no-op we're "recovering" from, it's a real in-flight call.
        assert await redis_client.get(keys.budget(agent.budget_key)) == "750"
        reservation_keys = await redis_client.keys("reservation:*")
        assert len(reservation_keys) == 1

        # Kill it. No graceful shutdown, no finally block, no chance for the process to resolve
        # its own reservation - this is what distinguishes this test from an ordinary
        # "forgot to call resolve_reservation" case.
        proc.kill()
        proc.join(timeout=5)
        assert not proc.is_alive()
    finally:
        if proc.is_alive():
            proc.kill()
            proc.join(timeout=5)

    # Wait past the 200ms TTL, then let the next request_permission's lazy sweep (or a direct
    # sweep call, as used here) recover it.
    await asyncio.sleep(0.3)
    await sweep_expired_reservations(config)

    assert await redis_client.get(keys.budget(agent.budget_key)) == "1000"

    # The reservation hash itself is not deleted by resolution - it's marked resolved=1 and
    # left to expire via its own grace-period TTL (set at admission time: ttl + grace_ms), the
    # same as resolving it the ordinary way. What must actually be gone is its entry in the
    # expiring-sorted-set (so no future sweep rediscovers and tries to resolve it again) and its
    # contribution to the concurrency counter.
    remaining = await redis_client.keys("reservation:*")
    assert len(remaining) == 1
    reservation_id = remaining[0].split(":", 1)[1]
    reservation_hash = await redis_client.hgetall(remaining[0])
    assert reservation_hash["resolved"] == "1"
    assert await redis_client.zrank(keys.reservations_expiring(), reservation_id) is None
    assert await redis_client.get(keys.concurrency("crash-target", agent.budget_key)) in (None, "0")
