"""Unit tests for ``agent_broker.keys``.

Two layers of coverage:
1. The same property-based cases as ``test/unit/keys.test.ts`` (no collisions across the
   length-prefixing scheme), ported 1:1.
2. Golden values captured directly from the running TypeScript implementation (via
   ``npx tsx`` against ``src/redis/keys.ts``, same baseline commit) — these catch the specific
   failure mode a property-only port could miss: Python and TS agreeing with *themselves* but
   not with *each other*.
"""

from __future__ import annotations

from agent_broker import keys


def test_no_collision_when_colon_moves_between_target_and_budget_key() -> None:
    # Invariant 13: unrelated (target, budget_key) pairs must never share a counter.
    assert keys.concurrency("a:b", "c") != keys.concurrency("a", "b:c")


def test_every_target_budget_key_pair_gets_a_distinct_concurrency_key() -> None:
    tricky = ["", "a", "b", "a:b", "b:a", ":", "::", "1:a", "2:ab", "a:", ":a", "groq:llama-3.3"]
    seen = {keys.concurrency(t, b) for t in tricky for b in tricky}
    assert len(seen) == len(tricky) ** 2


def test_different_key_types_stay_in_different_namespaces() -> None:
    all_keys = [keys.agent("x"), keys.budget("x"), keys.reservation("x"), keys.circuit("x")]
    assert len(set(all_keys)) == len(all_keys)


# --- Golden values captured from the TS implementation at baseline commit 36f7674 ---
# Captured via: `npx tsx` evaluating src/redis/keys.ts directly (see
# docs/python-port/IMPLEMENTATION_PLAN.md, Milestone 2 for the planned automated version of
# this cross-check; these are the Milestone 1 manual snapshot).

def test_matches_ts_golden_values() -> None:
    assert keys.agent("abc-123") == "agent:abc-123"
    assert keys.budget("my:budget") == "budget:9:my:budget"
    assert keys.reservation("res-xyz") == "reservation:res-xyz"
    assert keys.reservations_expiring() == "reservations:expiring"
    assert keys.concurrency("groq:llama-3.3-70b", "team-a") == "concurrency:18:groq:llama-3.3-70b6:team-a"
    assert keys.concurrency("", "") == "concurrency:0:0:"
    assert keys.concurrency("a:b", "c") == "concurrency:3:a:b1:c"
    assert keys.concurrency("a", "b:c") == "concurrency:1:a3:b:c"
    assert keys.circuit("groq:llama-3.3-70b") == "circuit:18:groq:llama-3.3-70b"
    assert keys.circuit_state("groq:llama-3.3-70b") == "circuit:18:groq:llama-3.3-70b:state"
