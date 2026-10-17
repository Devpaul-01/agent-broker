"""Runs as a standalone subprocess (started by either a Python or a Node.js parent — see
``test/cross-language/README.md``), executing real ``Broker`` operations against real Redis on
behalf of whichever side spawned it.

This is the Python equivalent of ``test/helpers/worker.ts``, with one necessary protocol
difference: ``worker.ts`` talks to its parent over Node's native IPC channel (`child_process`
`send`/`message`, which only exists between two Node processes), so a cross-language harness
cannot reuse that channel directly from a Python parent. This worker instead speaks JSON Lines
over stdin/stdout — one JSON object per line in, one JSON object per line out — a transport
either language's standard library can drive without extra dependencies, so the same parent-side
harness code (whichever language it's written in) can spawn either worker uniformly.

Protocol (matches worker.ts's WorkerTask/WorkerResult shape, field names kept as the TS
original's camelCase so a task payload is byte-identical regardless of which language reads or
writes it):

    stdin,  one line:  {"task": "requestPermission", "params": {...}, "config": {...}}
    stdout, one line:  {"ok": true, "result": {...}} | {"ok": false, "error": "..."}

On startup, before reading any task, this process writes {"ok": true, "result": "ready"} to
stdout exactly once - the same readiness handshake worker.ts performs, needed because both
forking the process and connecting to Redis take real time, and the parent must not send a task
before this process can handle it.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python", "src"))

from agent_broker.admission import RequestPermissionInput  # noqa: E402
from agent_broker.agents import RegisterChildInput, RegisterRootInput  # noqa: E402
from agent_broker.broker import create_broker  # noqa: E402
from agent_broker.config import BrokerOptions, CircuitBreakerOptions  # noqa: E402
from agent_broker.resolution import ReportOutcomeInput  # noqa: E402

TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


def _to_snake(camel: str) -> str:
    out = []
    for ch in camel:
        if ch.isupper():
            out.append("_")
            out.append(ch.lower())
        else:
            out.append(ch)
    return "".join(out)


def _keys_to_snake(d: dict) -> dict:
    return {_to_snake(k): v for k, v in d.items()}


def _build_broker_options(redis: object, config: dict | None) -> BrokerOptions:
    config = config or {}
    cb = config.get("circuitBreaker")
    circuit_breaker = CircuitBreakerOptions(**_keys_to_snake(cb)) if cb else None
    kwargs = _keys_to_snake({k: v for k, v in config.items() if k != "circuitBreaker"})
    return BrokerOptions(redis=redis, circuit_breaker=circuit_breaker, **kwargs)


def _result_to_jsonable(result: object) -> object:
    """Converts a dataclass result (Admitted, Denied, RootAgent, ...) into a plain JSON-safe
    dict with TS-matching camelCase field names, so a TS-side test asserting on
    `result.allowed`/`result.reservationId` reads the identical shape regardless of which
    worker produced it.
    """
    if hasattr(result, "__dataclass_fields__"):
        out = {}
        for field_name in result.__dataclass_fields__:
            value = getattr(result, field_name)
            camel = _to_camel(field_name)
            out[camel] = _result_to_jsonable(value)
        return out
    return result


def _to_camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


async def _run_task(broker: object, task: dict) -> object:
    name = task["task"]
    params = _keys_to_snake(task.get("params", {}))

    if name == "requestPermission":
        return await broker.request_permission(RequestPermissionInput(**params))  # type: ignore[attr-defined]
    if name == "reportOutcome":
        return await broker.report_outcome(ReportOutcomeInput(**params))  # type: ignore[attr-defined]
    if name == "registerChild":
        return await broker.register_child(RegisterChildInput(**params))  # type: ignore[attr-defined]
    if name == "registerRoot":
        return await broker.register_root(RegisterRootInput(**params))  # type: ignore[attr-defined]
    raise ValueError(f"unknown task: {name}")


async def main() -> None:
    import redis.asyncio as redis_asyncio

    redis = redis_asyncio.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    await redis.ping()

    sys.stdout.write(json.dumps({"ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()

    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        task = json.loads(line)
        try:
            broker = create_broker(_build_broker_options(redis, task.get("config")))
            result = await _run_task(broker, task)
            response = {"ok": True, "result": _result_to_jsonable(result)}
        except Exception as error:  # noqa: BLE001 - reported back to the parent, never raised here
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:  # noqa: BLE001 - startup failure, reported the same way worker.ts does
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}) + "\n")
        sys.stdout.flush()
        sys.exit(1)
