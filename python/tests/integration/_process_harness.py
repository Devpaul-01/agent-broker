"""A Python equivalent of ``test/helpers/harness.ts``: spawns genuinely independent OS
processes (via ``multiprocessing.get_context("spawn")``, not threads or asyncio tasks sharing
one interpreter) that each open their own Redis connection and race for the same coordination
state.

This exists for the same reason the TS harness exists: proving Invariant 5-style atomicity
guarantees hold across processes that share nothing but Redis — not just across concurrent
asyncio tasks inside one interpreter/one connection pool, which is a weaker claim (see
``test_request_permission.py``'s own in-process 20-connection race, which already proves the
Lua script's atomicity; this harness proves separate *processes* actually reach the same Redis
state correctly, the thing a single-process test cannot rule out).

``spawn`` (not ``fork``) is used deliberately: fork-after-asyncio-has-started is a known source
of subtle hangs (the child inherits a half-initialized event loop/epoll fd), and ``spawn``
matches what the TS harness actually does (a genuinely fresh process via ``child_process.fork``,
not a copy-on-write duplicate of a running one).
"""

from __future__ import annotations

import asyncio
import multiprocessing
import os
from dataclasses import dataclass
from typing import Any

from agent_broker.admission import RequestPermissionInput, request_permission
from agent_broker.config import BrokerOptions, parse_config
from agent_broker.resolution import ResolveParams, resolve_reservation


@dataclass
class WorkerTask:
    task: str  # "request_permission" | "resolve_reservation"
    params: dict[str, Any]


def _worker_entrypoint(redis_url: str, task: WorkerTask, result_queue: "multiprocessing.Queue[dict[str, Any]]") -> None:
    """Runs inside the child process. Builds its own event loop and its own Redis connection -
    nothing is inherited from the parent, matching a real independent caller.
    """
    import redis.asyncio as redis_asyncio

    async def _run() -> dict[str, Any]:
        client = redis_asyncio.Redis.from_url(redis_url, decode_responses=True)
        try:
            config = parse_config(BrokerOptions(redis=client))
            if task.task == "request_permission":
                result = await request_permission(config, RequestPermissionInput(**task.params))
            elif task.task == "resolve_reservation":
                result = await resolve_reservation(config, ResolveParams(**task.params))
            else:
                raise ValueError(f"unknown task: {task.task}")
            return {"ok": True, "result": result, "pid": os.getpid()}
        except Exception as error:  # noqa: BLE001 - reported back to the parent, not raised here
            return {"ok": False, "error": f"{type(error).__name__}: {error}", "pid": os.getpid()}
        finally:
            await client.aclose()

    outcome = asyncio.run(_run())
    result_queue.put(outcome)


async def run_in_processes(redis_url: str, tasks: list[WorkerTask]) -> list[dict[str, Any]]:
    """Spawns one real OS process per task, all racing concurrently, and collects their results.

    Uses ``multiprocessing`` directly (via a thread-pool-friendly async wrapper) rather than
    ``concurrent.futures.ProcessPoolExecutor``, because a pool's worker processes are reused
    across tasks (the opposite of what this needs to prove: that N *freshly started* processes,
    none sharing any warm state with each other, still coordinate correctly through Redis alone).
    """
    ctx = multiprocessing.get_context("spawn")
    result_queue: "multiprocessing.Queue[dict[str, Any]]" = ctx.Queue()
    processes = [
        ctx.Process(target=_worker_entrypoint, args=(redis_url, task, result_queue)) for task in tasks
    ]

    loop = asyncio.get_running_loop()
    for p in processes:
        p.start()

    def _collect() -> list[dict[str, Any]]:
        results = [result_queue.get(timeout=30) for _ in tasks]
        for p in processes:
            p.join(timeout=30)
        return results

    return await loop.run_in_executor(None, _collect)
