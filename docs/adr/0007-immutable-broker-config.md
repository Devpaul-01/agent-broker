# ADR-0007: Broker configuration is immutable for the instance's lifetime

**Status:** Accepted
**Refines:** ADR-19 (architecture.md)

## Context

`createBroker(options)` accepts `maxDepth`, reservation TTL bounds, `concurrencyLimit`, and circuit-breaker thresholds. At some point, a natural feature request will surface: let these be updated after construction (`broker.setMaxDepth(10)`), so an application doesn't need to restart or reconstruct a broker to change a limit.

## Decision

No such update path exists, or should be added. `parseConfig` runs once, at `createBroker()` time, and the result is `Object.freeze`'d (including nested objects like `circuitBreaker`) and closed over by every function the returned `Broker` exposes. If different limits are needed, construct a new `createBroker()` instance.

## Reasoning

The real question a mutable-config feature has to answer, and cannot answer safely, is: **what happens to agents and reservations that already exist under the old limits, once the limits change?**

Concretely: if `maxDepth` drops from 5 to 3 while agents already registered at depth 4 are still active and heartbeating, are they now retroactively invalid? Do their *existing* children get denied, or only *new* delegation attempts? If `concurrencyLimit` drops below the current in-flight count, do excess in-flight calls get forcibly cancelled, or does the system just refuse new admissions until the count organically drops? There is no answer to these questions that isn't either silently wrong (pretend nothing changed for already-registered state) or operationally dangerous (start tearing down live agents).

Keeping configuration immutable for an instance's lifetime sidesteps the question entirely rather than answering it badly. A new broker instance, with its own limits, simply applies to agents registered against *it* — no retroactive reinterpretation of anything.

## Alternatives considered

- **Mutable config with "new limits apply only to new registrations."** Rejected: this is quietly worse than it sounds, because it means two agents registered five minutes apart, under what looks like "the same broker," can be operating under materially different rules with no visible marker of which regime applies to which agent. That's a subtle correctness trap for anyone debugging unexpected behavior later.
- **Versioned config, with agents tagged at registration time to the config version active when they were created.** Rejected as solving a problem nobody has asked for yet, at real implementation cost (every admission check would need to resolve "which config version governs this specific agent," and the Lua scripts would need to carry version-specific thresholds as arguments rather than reading from one fixed `ResolvedConfig` object).

## Consequences

- An application that wants different limits for different workloads constructs multiple `createBroker()` instances, each with its own Redis key namespace concerns in mind if they share one Redis instance (they do not currently share any keys that would conflict, since depth/concurrency/circuit-breaker limits are read from the calling instance's own in-memory config, not stored in Redis — only the *data* those limits gate, like `budget:{budgetKey}`, lives in Redis).
- `Object.isFrozen(config)` is directly asserted in the config test suite — this is a real, tested guarantee, not just a documented intention.
- This also closes a smaller but related risk: without freezing, a caller could mutate the object it originally passed to `createBroker()` after construction (e.g. `circuitBreaker.softThreshold = 999`) and have that silently affect an already-running broker through object aliasing. `parseConfig` explicitly does not alias the caller's input objects for exactly this reason — the frozen `ResolvedConfig` holds its own copies.
