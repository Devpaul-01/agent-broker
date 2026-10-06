# ADR-0001: Reservation TTL and lazy cleanup design

**Status:** Accepted
**Refines:** ADR-15 (architecture.md)

## Context

A reservation hash (`reservation:{id}`) needs a TTL — without one, a caller that crashes
between `requestPermission` and `reportOutcome` leaves the reservation alive forever. But if
Redis physically deletes the hash the instant its TTL expires, the fields needed to refund it
(`estimatedCost`, `budgetKey`, `target`) disappear at the same moment. Anything that later
needs to clean up an abandoned reservation — a lazy sweep, or a `reportOutcome` call that
arrives late — finds nothing to work with.

## Decision

Separate logical expiry from physical deletion:

- The reservation hash's own Redis-level TTL is set to `callerTtl + 5000ms` (a fixed grace
  period), not `callerTtl` directly.
- A single sorted set, `reservations:expiring` (not one per reservation), holds
  `member = reservationId, score = expiresAt`. This has no TTL of its own.
- The sorted-set score is the authoritative logical expiry. The hash's physical TTL exists
  only to keep the hash's fields alive long enough for something to read them after logical
  expiry but before physical deletion.

A lazy sweep (see ADR triggered from `requestPermission`, described in the cleanup
implementation) scans `ZRANGEBYSCORE reservations:expiring -inf now LIMIT 0 N` for candidates,
and resolves any that are still unresolved, using the same shared resolution script that
`reportOutcome` uses.

## Alternatives considered

- **Encode refund data directly into the sorted-set member** (e.g. a composite string
  containing `budgetKey`, `target`, `estimatedCost`) instead of relying on the hash
  surviving. Rejected: this duplicates state that already lives on the hash, and keeping two
  copies in sync (e.g. if a partial update ever touches one but not the other) is a correctness
  liability for no real benefit over just keeping the hash alive a little longer.

## Consequences

- A `reportOutcome` call that arrives after logical expiry but within the grace window still
  works correctly — tested explicitly.
- The grace period (5s, currently a fixed constant) is a real tuning knob with no usage data
  behind it, same honesty standard applied elsewhere in this project (see the `retryAfter`
  formula in the circuit breaker). If reservations routinely report back later than 5s after
  their TTL, this will need revisiting.
- This does not change ADR-15's "lazy, not event-driven" decision — cleanup is still only
  triggered by other traffic, never a background timer.