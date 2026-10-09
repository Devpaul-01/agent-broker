# ADR-0006: The library never owns or creates its own Redis connection

**Status:** Accepted
**Refines:** ADR-3 (architecture.md)

## Context

`agent-broker` needs a Redis connection to do anything. The two obvious options are: the library creates and manages its own connection internally (reading a URL from config or environment), or the consuming application creates the connection and hands it to the library.

## Decision

`createBroker({ redis })` requires a live `ioredis` client instance, supplied by the caller. The library never calls `new Redis(...)` itself, never reads `process.env` for connection details, and never manages reconnection/lifecycle policy for the connection.

## Reasoning

- **Secrets and connection policy are the consuming application's problem, not this library's.** Every application already has its own conventions for where Redis URLs/passwords/TLS config come from (env vars, a secrets manager, a config service). A library that reads `process.env.REDIS_URL` directly either duplicates that policy badly or conflicts with it outright.
- **It's also what makes cross-process coordination correctly scoped "for free."** Two unrelated applications, each with their own `createBroker({ redis: ownConnection })` pointed at different Redis instances, share nothing — there's no global or singleton connection anywhere in this library that could accidentally leak state between them.
- **Connection lifecycle (retry strategy, TLS, cluster vs. single-node, connection pooling) is a deep, applicationspecific topic on its own**, and `ioredis` already has a complete, well-documented API surface for all of it. Reimplementing a subset of that configuration surface inside `agent-broker`'s own options object would be strictly worse than just accepting a client.

## Alternatives considered

- **Accept a connection string/URL and construct the client internally.** Rejected: this still requires exposing *some* subset of `ioredis`'s connection options (TLS, cluster mode, retry policy) through `agent-broker`'s own config surface, which either becomes a large, duplicated API, or an unnecessarily restrictive one. Accepting the client directly sidesteps the whole problem.
- **Support both: accept either a URL or a client.** Rejected as unnecessary surface area for a marginal convenience — any application that can supply a URL can trivially construct the one line of `ioredis` client code itself, and supporting two input shapes means two code paths to keep correct.

## Consequences

- Every example and test in this codebase constructs its own `ioredis` client and passes it in — this is not a shortcut specific to tests, it's the only supported integration pattern.
- Multiple `budgetKey` pools, multiple broker instances, and multiple unrelated applications can all point at the same physical Redis deployment safely, as long as each supplies its own connection and doesn't deliberately collide on key names (see [ADR-0008](0008-length-prefixed-key-segments.md) for why the key scheme itself prevents accidental collision even when `target`/`budgetKey` strings contain colons).
- If Redis connection details ever need to change at runtime (e.g. failover to a different instance), that's handled by `ioredis`'s own reconnection behavior on the client the caller supplied — not something `agent-broker` has any hook into or opinion about.
