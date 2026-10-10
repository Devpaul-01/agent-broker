# ADR-0023: `requestPermission` is backed by exactly one combined Lua script

**Status:** Accepted

## Context

`requestPermission` must evaluate agent existence, circuit-breaker state, budget, and concurrency together as one admission decision. Splitting this across multiple smaller, individually-simpler Lua scripts was considered as a way to keep each script's logic easier to read and test in isolation.

## Decision

`requestPermission` is backed by exactly one Lua script (`REQUEST_PERMISSION`, see `architecture.md` Section 11), performing every check and every corresponding write atomically, in one round trip.

## Reasoning

Any operation that reads shared Redis state and then conditionally writes based on that read must be a single atomic unit — between any two round trips, another process can interleave and invalidate the read. Splitting the combined check into several smaller scripts would recreate, at the code-organization level, exactly the race this single-script design exists to eliminate at the Redis level: two concurrent calls could each pass their own script's individual check before either script's write lands, reopening the same class of over-admission bug the whole architecture exists to prevent. Code-organization tidiness is not worth reintroducing a correctness bug.

## Alternatives considered

- **One script per concern (budget, concurrency, circuit breaker), called in sequence.** Rejected: each individual script would be atomic on its own, but the *sequence* of calls would not be — concurrent callers could interleave between scripts in exactly the way a single combined script prevents.
- **Two scripts: one for circuit-breaker admission, one for budget+concurrency.** Rejected for the same reason at a smaller scale — any split reopens a gap between the split halves.

## Consequences

- The `REQUEST_PERMISSION` script is necessarily the most complex single piece of logic in the codebase — this is treated as the correct trade (one carefully-reviewed script) rather than a problem to be solved by splitting it, per `docs/agent-broker-architecture.md` Section 18's module boundaries, which deliberately does not split admission logic into per-concern submodules.
- Any future addition to admission-time checks (a new limit, a new condition) must be added to this one script, not as a separate round trip — this is the standing rule for anyone extending `requestPermission`.
