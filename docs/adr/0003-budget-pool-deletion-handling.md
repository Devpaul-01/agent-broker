# ADR-0003: Behavior when a budget pool is deleted out from under a reservation

**Status:** Accepted
**Found during review**, not by initial design — see Consequences.

## Context

A budget pool (`budget:{budgetKey}`) has no TTL by design: budget is lifetime state intended to
outlive any single agent. But no-TTL does not mean indestructible. Nothing in the architecture
gives a pool a bounded lifecycle (there is no `closeBudget()` or deregister-equivalent for a
pool), so external deletion is possible — an operator running `redis-cli DEL` directly, a
future pool-closing API, or Redis eviction under `maxmemory`.

The bug this exposed: `reportOutcome`'s refund used Redis's `INCRBY`, which does not error on a
missing key — it silently creates the key at the refund value. A refund into a deleted pool
would therefore **silently recreate the pool**, either handing out unauthorized budget
(positive refund) or materializing a negative pool from nothing (negative refund), with no
signal to the caller either way.

## Decision

The resolution script checks `EXISTS` on the budget pool immediately before refunding. If the
pool is missing:

- The `INCRBY` is skipped (no silent recreation).
- The reservation still resolves **fully** — `resolved` is set, the concurrency slot is
  released, the entry is removed from `reservations:expiring`.
- The response includes `poolMissing: true`, so the anomaly is visible to the caller instead of
  silent.

## Alternatives considered

- **Deny the report outright** (new status, e.g. `budget_pool_missing`; leave the reservation
  unresolved, do not release concurrency). Rejected: this trades a silent-corruption bug for a
  silent-deadlock bug. A reservation against a permanently deleted pool could never be
  successfully reported again, so its concurrency slot would be held forever.

## Consequences

- A reservation's lifecycle and a budget pool's lifecycle are explicitly treated as two
  separate things. Losing the second does not permanently wedge the first.
- `poolMissing` is a public, typed field on `reportOutcome`'s success response — it is not an
  internal detail. An integrator building observability on top of this library should treat it
  as something worth alerting on, since it indicates state was deleted outside the broker's own
  control.
- This same `EXISTS` guard, and the `poolMissing` reporting, also applies to reservations
  resolved via lazy cleanup, not just explicit `reportOutcome` calls, since both paths share one
  resolution script (see the lazy-cleanup implementation).