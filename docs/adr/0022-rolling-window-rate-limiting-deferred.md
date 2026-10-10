# ADR-0022: True rolling-window rate limiting is deferred; scheduled external reset is sufficient for v1

**Status:** Accepted

## Context

A natural-sounding related feature is "no more than X calls (or X cost) in any rolling N-minute window" — a general-purpose rate limiter, distinct from the budget-pool mechanism this library actually implements. It's worth being explicit about why this isn't built, rather than leaving its absence unexplained.

## Decision

True rolling-window rate limiting is not implemented and is explicitly out of scope for this version. For the common "budget over a recurring time period" need, an application-triggered scheduled reset (calling `addBudget` on a cron schedule, or re-registering a pool) is judged sufficient, since it reuses the existing budget mechanism with no new Redis structures.

## Reasoning

Correct rolling-window counting (as opposed to fixed-window, which has real edge-case bursting at window boundaries) is its own non-trivial mechanism — the circuit breaker's own sliding-window failure tracking (`ZREMRANGEBYSCORE` + `ZCARD` against a sorted set) is an example of what doing this correctly actually requires. Building a second, general-purpose version of that same mechanism for arbitrary rate limiting, on top of an already-scoped budget/depth/retry-correlation library, would significantly expand what this project claims to be (see the project's own explicit "not a general-purpose rate limiter" non-goal) for a need that a much simpler mechanism — periodic external reset — already covers adequately for v1.

## Alternatives considered

- **Build true rolling-window rate limiting now, reusing the circuit breaker's sorted-set pattern.** Rejected for this version: real, non-trivial design work (bucketing strategy, memory bounds on the window) for a need not yet validated against actual usage, and it pulls the library further toward being a general rate limiter — a role it deliberately doesn't claim.
- **Fixed-window counters (simpler, but with known boundary-burst artifacts).** Not pursued even as a cheaper alternative, since it would still expand scope for an unvalidated need, and a fixed-window limiter has a real correctness gap (bursting at the window edge) that a library aiming for correctness under concurrency shouldn't ship half-heartedly.

## Consequences

- Applications needing a genuine "X per rolling hour" guarantee must build it themselves or layer it on top, for now.
- If this is ever revisited, it should be driven by real usage data showing the scheduled-reset approach is insufficient — not spent upfront on speculation.
