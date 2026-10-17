"""Shared helper for reading a reservation hash's ``budgetKey`` and ``target`` fields together.

Ports ``src/redis/hmget2.ts``. Used by both ``cleanup.py`` (to find what to refund for an
abandoned reservation) and ``resolution.py``'s ``report_outcome`` (to look up what a caller-
supplied ``reservation_id`` actually refers to before resolving it) — kept as its own module,
the same as the TS source, so neither of those two modules needs to import the other.
"""

from __future__ import annotations

from typing import Any


async def hmget_budget_key_and_target(redis: Any, key: str) -> dict[str, str] | None:
    result = await redis.hmget(key, "budgetKey", "target")
    budget_key, target = result[0], result[1]
    if budget_key is None or target is None:
        return None
    if isinstance(budget_key, bytes):
        budget_key = budget_key.decode("utf-8")
    if isinstance(target, bytes):
        target = target.decode("utf-8")
    return {"budgetKey": budget_key, "target": target}
