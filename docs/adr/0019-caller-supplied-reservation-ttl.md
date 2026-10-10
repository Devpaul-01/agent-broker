# ADR-0019: Reservation TTL is supplied per call by the caller, bounded by broker-level limits

**Status:** Accepted

## Context

A reservation needs a TTL so that an abandoned call (caller crashed, or simply never reported back) can eventually be released rather than holding budget and a concurrency slot forever. The question is where that TTL value comes from: a single broker-wide fixed value, or something the caller controls per call.

## Decision

`requestPermission({ ..., ttl })` accepts an optional per-call TTL in milliseconds. If omitted, `config.defaultReservationTtl` is used. Whatever value is used — caller-supplied or default — is capped by `config.maxReservationTtl`, a hard ceiling the broker enforces (requests exceeding it are rejected before any Redis call is made).

## Reasoning

Only the caller has realistic knowledge of how long its own call is expected to take. A fast lookup and a long-running generation call have genuinely different expected durations, and a single fixed broker-wide TTL would have to either be long enough to accommodate the slowest call type (leaving abandoned fast calls occupying resources far longer than necessary) or short enough for the fast case (prematurely expiring legitimate slow calls). Letting the caller specify it, with a broker-enforced ceiling, serves both cases correctly without the broker needing to guess.

## Alternatives considered

- **A single fixed broker-wide reservation TTL.** Rejected: cannot serve both fast and slow call types well simultaneously, for the reasons above.
- **Unbounded caller-supplied TTL (no `maxReservationTtl` ceiling).** Rejected: an unbounded TTL would let a single misconfigured or malicious caller hold a reservation (and the budget/concurrency it consumes) indefinitely, which defeats the purpose of having a TTL-based safety net at all.

## Consequences

- Applications with mixed call durations (a fast classification call and a slow generation call against the same budget pool) can tune TTL per call site rather than being forced into one compromise value.
- `maxReservationTtl` is a broker-instance-level configuration value, immutable for the instance's lifetime (see [ADR-0007](0007-immutable-broker-config.md)) — changing it requires a new broker instance, consistent with how all other broker-level limits are governed.
