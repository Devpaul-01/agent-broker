# ADR-0018: Concurrency limiting is a distinct mechanism from delegation depth

**Status:** Accepted

## Context

An early design assumption was that limiting delegation depth already bounded how many calls could be in flight at once. This assumption was identified as incorrect during design and corrected.

## Decision

Concurrency limiting is tracked independently of depth, per `(target, budgetKey)` pair, and enforced atomically alongside the budget check inside the same combined admission script (see [ADR-0023](0023-single-combined-admission-script.md)). Callers choose `mode: 'deny'` (default — reject immediately if the limit is currently hit) or `mode: 'queue'` (wait for a slot, up to `queueTimeout`).

## Reasoning

Depth constrains tree *shape* — how many delegation levels deep a chain of sub-agents can go. It says nothing about how many calls are happening *simultaneously*. A tree capped at `maxDepth: 3` can still have thousands of agents at depth 1, all calling the same target at once — nothing about a depth limit prevents that. The two failure modes (runaway recursion vs. runaway parallelism) are genuinely independent and need independent enforcement.

Folding concurrency into the same atomic script as the budget check (rather than a separate round trip) is necessary for the same reason budget reservation itself must be atomic: a separate check-then-increment step would reopen the exact race the combined script exists to close.

## Alternatives considered

- **Treat depth as a sufficient proxy for concurrency.** Rejected once the gap was identified: depth and in-flight call volume are simply different axes, and no amount of depth tuning closes the concurrency gap.
- **A single global concurrency limit, not scoped per `(target, budgetKey)`.** Rejected: a global limit couldn't express "this specific target has limited capacity" independently of "this specific caller/budget shouldn't monopolize it" — both are real, separate needs this scoping satisfies simultaneously.

## Consequences

- An application that wants to bound both tree depth and simultaneous in-flight calls must configure both `maxDepth` and `concurrencyLimit` — neither substitutes for the other.
- `mode: 'queue'` gives callers an explicit opt-in for "wait rather than handle a denial," without changing the default (`'deny'`) behavior for callers who haven't asked for queuing.
