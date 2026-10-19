"""Runs the language-neutral behavioral cases in fixtures/behavioral_cases.json against BOTH
workers, once each, and asserts each language reaches the exact same final Redis state. This is
what makes the fixture file "shared" in a meaningful sense: the same case definition, unchanged,
is replayed through each language's real broker implementation, parametrized so a failure names
exactly which (case, language) pair diverged.

This is deliberately a different kind of test from test_cross_language.py: that file proves two
DIFFERENT languages cooperating on ONE shared piece of state in the same test. This file proves
the SAME case produces the SAME result independent of which language executed it - behavioral
equivalence, not cooperation.
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

import pytest
import redis.asyncio as redis_asyncio

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python", "src"))
from harness import WorkerHandle  # noqa: E402

pytestmark = pytest.mark.integration

TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")
_FIXTURES_PATH = Path(__file__).parent / "fixtures" / "behavioral_cases.json"
_CASES = json.loads(_FIXTURES_PATH.read_text())["cases"]


@pytest.fixture
async def redis_client() -> redis_asyncio.Redis:
    client = redis_asyncio.Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    await client.ping()
    await client.flushdb()
    try:
        yield client
    finally:
        await client.aclose()


async def _run_case(worker: WorkerHandle, redis_client: redis_asyncio.Redis, case: dict) -> None:
    budget_key = f"shared-case-{case['name']}-{worker.kind}-{random.random()}"
    reg = await worker.run("registerRoot", {"budgetKey": budget_key, "initialBudget": case["initial_budget"]})
    assert reg.ok, f"[{worker.kind}] registerRoot failed: {reg.error}"
    agent_id = reg.result["agentId"]

    saved_reservations: dict[str, str] = {}

    for i, op in enumerate(case["operations"]):
        label = f"[{worker.kind}/{case['name']}] op[{i}]"
        if op["op"] == "requestPermission":
            params = {
                "agentId": op.get("agent_id_override", agent_id),
                "target": op["target"],
                "estimatedCost": op["estimatedCost"],
            }
            result = await worker.run("requestPermission", params)
            assert result.ok, f"{label} request failed: {result.error}"
            assert result.result["allowed"] is op["expect_allowed"], (
                f"{label}: expected allowed={op['expect_allowed']}, got {result.result}"
            )
            if not op["expect_allowed"]:
                assert result.result["reason"] == op["expect_reason"], f"{label}: {result.result}"
            else:
                if "save_reservation_as" in op:
                    saved_reservations[op["save_reservation_as"]] = result.result["reservationId"]
                else:
                    saved_reservations["_last"] = result.result["reservationId"]

        elif op["op"] == "reportOutcome":
            ref = op.get("reservation_ref", "_last")
            reservation_id = saved_reservations[ref]
            params: dict = {"reservationId": reservation_id, "success": op["success"]}
            if "retryable" in op:
                params["retryable"] = op["retryable"]
            if "actualCost" in op:
                params["actualCost"] = op["actualCost"]
            result = await worker.run("reportOutcome", params)
            assert result.ok, f"{label} report failed: {result.error}"
            assert result.result["allowed"] is op["expect_allowed"], (
                f"{label}: expected allowed={op['expect_allowed']}, got {result.result}"
            )
            if not op["expect_allowed"]:
                assert result.result["reason"] == op["expect_reason"], f"{label}: {result.result}"
            if op.get("expect_cost_unknown"):
                assert result.result["costUnknown"] is True, f"{label}: {result.result}"
        else:
            raise AssertionError(f"unknown op in fixture: {op['op']}")

    from agent_broker import keys

    final_balance = await redis_client.get(keys.budget(budget_key))
    assert final_balance == str(case["expected_final_budget"]), (
        f"[{worker.kind}/{case['name']}] expected final budget "
        f"{case['expected_final_budget']}, got {final_balance}"
    )


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
@pytest.mark.parametrize("language", ["python", "typescript"])
async def test_shared_behavioral_case(
    redis_client: redis_asyncio.Redis, case: dict, language: str
) -> None:
    worker = WorkerHandle(language)  # type: ignore[arg-type]
    try:
        await _run_case(worker, redis_client, case)
    finally:
        worker.kill()
