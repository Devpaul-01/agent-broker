# ADR-0016: No separate mechanism for cross-process/cross-instance sharing beyond Redis + `budgetKey`

**Status:** Accepted

## Context

It's reasonable to ask whether the library needs some additional concept of a "broker ID" or shared-cluster identity to let independent broker instances coordinate with each other. This was considered explicitly during design, against what the library already provides.

## Decision

No such mechanism exists, or is planned. Cross-process and cross-instance coordination is already fully provided by (a) pointing multiple `createBroker()` instances at the same physical Redis deployment, and (b) using the same `budgetKey`/`target` strings where sharing is intended. No second, broker-level identity concept is introduced on top of this.

## Reasoning

Redis is already the one genuinely shared substrate between independent processes (see [ADR-0006](0006-no-owned-redis-connection.md)) — any two broker instances that can see the same Redis keys are, by construction, already coordinating. Introducing a separate "broker cluster ID" or similar concept would be a second mechanism solving a problem the first mechanism already solves completely, adding configuration surface and a new way for two instances to be *almost* but not quite correctly linked (e.g., same Redis, mismatched cluster ID) with no corresponding benefit.

## Alternatives considered

- **A broker-level cluster/group ID**, with instances only coordinating if their IDs match. Rejected as solving a non-problem: Redis key visibility already determines what coordinates with what, and a parallel ID system can only disagree with that, never improve on it.

## Consequences

- Any two processes that construct a `createBroker({ redis })` pointed at the same Redis deployment, and use matching `target`/`budgetKey` strings, are coordinating correctly — there is no additional setup step to forget.
- Preventing *unintended* cross-process coordination is solely the responsibility of key-naming discipline (distinct `budgetKey`/`target` values, or genuinely separate Redis deployments) — not a broker-level access-control feature, which doesn't exist.
