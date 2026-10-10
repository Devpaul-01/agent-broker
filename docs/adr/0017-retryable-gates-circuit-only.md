# ADR-0017: `retryable` is a caller-supplied classification that gates circuit-breaker accounting only

**Status:** Accepted

## Context

`reportOutcome` needs to know, on failure, whether the failure is the kind of thing worth factoring into shared retry-correlation state (a timeout, a 5xx, a rate limit) or not (a malformed request, a bad API key — retrying will never help, and the fault is the caller's, not the target's). The broker never observes the actual downstream call or response, so it cannot classify this itself; it must be told.

## Decision

`retryable` is a boolean the caller supplies on `reportOutcome` when `success: false`. Only failures reported as `retryable: true` are written into the circuit breaker's sliding failure window. Non-retryable failures are still fully reported for budget/concurrency reconciliation, but never influence shared circuit-breaker state.

## Reasoning

This distinction is load-bearing, not cosmetic. If non-retryable failures were folded into the same failure counter as genuine transient errors, a single caller's own unrelated bug (e.g., sending malformed requests, or using an expired API key) could trip the circuit breaker for a target that is actually perfectly healthy — denying every *other*, well-behaved caller sharing that target. The entire value of a shared circuit breaker depends on the signal it aggregates actually meaning "the target is struggling," not "someone, somewhere, had a bug."

The broker has no independent way to verify a caller's `retryable` claim — this is an accepted, explicitly named trust boundary (see the Trust model in the README / Section 8 of `architecture.md`), not an oversight.

## Alternatives considered

- **Classify failures automatically from an error code/status the caller passes in.** Rejected: this would require the broker to understand provider-specific error taxonomies, directly conflicting with the decision to keep the broker entirely provider-agnostic (see [ADR-0011](0011-opaque-target-string.md), [ADR-0004](0004-no-provider-abstraction.md)).
- **Count all failures toward the circuit breaker, retryable or not.** Rejected for the correlated-bug risk described above — this was identified as a real trap, not a theoretical one, during design.

## Consequences

- An application must classify its own failures honestly for the circuit breaker to do its job. Misclassifying a genuinely transient failure as non-retryable silently excludes it from correlation detection; the reverse (`retryable: true` on a caller bug) can falsely trip the circuit for everyone sharing that target.
- This classification exists independently of whether the circuit breaker eventually recovers via one probe success or several — see [ADR-0010](0010-single-probe-circuit-recovery.md) for that separate decision.
