"""Redis key construction — the single source of truth for every key this library touches.

Ports ``src/redis/keys.ts`` verbatim in behavior. This module is part of the cross-language
shared protocol (see
``docs/ARCHITECTURE.md`` §23): for any given input, every function here MUST
produce the exact same string as its TypeScript counterpart, or a Python process and a
TypeScript process will silently address different Redis keys for what the caller believes is
the same budget/concurrency/circuit scope.

Caller-supplied strings (``target``, ``budget_key``) are length-prefixed so that keys built
from several of them cannot be re-split ambiguously. Targets contain colons by convention
("groq:llama-3.3-70b"), so a plain ":" separator would map ("a:b", "c") and ("a", "b:c") to the
same key and silently merge two unrelated concurrency counters (Invariant 13 — see
``src/redis/keys.ts`` and ``src/admission/request-permission.ts`` in the TS source).
Broker-issued IDs (agent, reservation) are UUIDs and safe to use raw.

``tests/unit/test_keys.py`` carries the same property-based cases as the TS ``keys.test.ts``,
plus golden-value cases captured directly from the running TS implementation, to catch any
future drift between the two length-prefixing implementations.
"""

from __future__ import annotations


def _seg(value: str) -> str:
    return f"{len(value)}:{value}"


def agent(agent_id: str) -> str:
    return f"agent:{agent_id}"


def budget(budget_key: str) -> str:
    return f"budget:{_seg(budget_key)}"


def reservation(reservation_id: str) -> str:
    return f"reservation:{reservation_id}"


def reservations_expiring() -> str:
    return "reservations:expiring"


def concurrency(target: str, budget_key: str) -> str:
    return f"concurrency:{_seg(target)}{_seg(budget_key)}"


def circuit(target: str) -> str:
    return f"circuit:{_seg(target)}"


def circuit_state(target: str) -> str:
    return f"circuit:{_seg(target)}:state"
