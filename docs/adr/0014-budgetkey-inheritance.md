# ADR-0014: `budgetKey` is declared only at root registration and inherited by every descendant

**Status:** Accepted

## Context

Budget needs to be scoped to *something* — the question is at what granularity, and whether that scope can shift as a delegation tree grows. A per-child `budgetKey` would let every node in a tree spend from a different pool; a broker-level setting would force every tree on one broker instance to share a single pool regardless of caller intent. Neither matches how spending actually needs to be shared.

## Decision

`budgetKey` is specified only when registering a root agent (`register({ budgetKey, initialBudget })`). Every descendant registered via `register({ parentId })` automatically inherits the root's `budgetKey` — it is never a field a child can set or override.

## Reasoning

- **A broker-level setting is too coarse**: every delegation tree on a given broker instance would be forced to share one pool, making it impossible for two unrelated users or features on the same broker to have independent budgets.
- **A per-child setting is unnecessary and dangerous**: it would let any node in a tree unilaterally redirect its own (and its descendants') spending to an arbitrary pool, defeating the entire point of centralizing budget enforcement at the root. Budget scope should be a property of the tree, decided once, not something any node can silently change.
- Declaring it only at the root and propagating it down means there is exactly one place spend-sharing is decided, and that decision is visible and auditable at tree creation time rather than scattered across every delegation call.

## Alternatives considered

- **Per-child `budgetKey` override.** Rejected: directly undermines the guarantee that a tree's spending is centrally accountable — any node could opt itself (and everything beneath it) out of its intended budget pool.
- **Broker-level single `budgetKey`.** Rejected: forces every unrelated tree on one broker instance into one shared pool, which is almost never the actual requirement (see [ADR-0015](0015-budgetkey-default.md) for the private-by-default resolution of this).

## Consequences

- `budgetKey` and delegation depth are orthogonal concerns: `budgetKey` answers "who shares a spending ceiling" (horizontal, cross-request); depth answers "how deep can one request's own fan-out go" (vertical, within one tree). A single root with a budget key shared with nobody can still spawn an unbounded recursive tree on its own — budget-key sharing has nothing to do with that failure mode, and vice versa. Both mechanisms are necessary.
- A new incoming unit of work is always registered as a new root, even when it intentionally shares a `budgetKey` with a previous, unrelated root — there is deliberately no "find and reuse an existing agent for this user" lookup mechanism. Agent IDs identify a single request's call tree, not a persistent user session; `budgetKey` is the thing that persists and is explicitly shared, not rediscovered.
