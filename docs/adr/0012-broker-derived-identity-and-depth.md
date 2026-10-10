# ADR-0012: Agent identity is broker-issued; depth is broker-computed, never caller-supplied

**Status:** Accepted

## Context

The entire value of centralized depth and budget enforcement depends on state that cannot be spoofed by a careless or dishonest caller. If a process could choose its own agent ID, or assert its own depth, the broker's guarantees would be enforceable only against callers who happened to behave — which defeats the point of centralizing enforcement in the first place.

## Decision

Agent identity (a UUID) is always broker-issued at registration, never accepted as caller input. Depth, `parentId`, and `rootId` are always computed by the broker from its own stored state about the referenced parent — a caller may reference existing state by ID (`register({ parentId })`), but may never supply derived facts (`depth`, `rootId`, `budgetKey`) about that state directly. This is the general trust pattern used everywhere identity-adjacent data crosses the API boundary.

## Reasoning

- **If callers could choose their own IDs**, one process could claim to *be* another agent and inherit its budget/depth state outright — a direct identity-spoofing bypass of every other guarantee in the system.
- **If depth could be caller-asserted**, a child could simply claim `depth: 0` regardless of its real position in the delegation tree, defeating `maxDepth` enforcement entirely — the one thing depth-limiting exists to prevent.
- Deriving depth/`rootId`/`budgetKey` from the broker's own lookup of the parent, rather than accepting them as request fields, means the only way to affect these values is to genuinely register through the API and let the broker compute them — there is no field to lie in.

## Alternatives considered

- **Caller-supplied IDs with broker-side uniqueness validation.** Rejected: uniqueness isn't the risk — a caller choosing a *valid, existing* ID that isn't its own is the actual attack this guards against, and validation can't distinguish "my own ID" from "someone else's ID I happen to know."
- **Caller-supplied depth with broker-side sanity bounds (e.g., reject depth > maxDepth).** Rejected: a caller could still claim any depth *below* the real one, silently escaping the limit that depth exists to enforce — bounding the claimed value doesn't make the claim trustworthy.

## Consequences

- Depth-spoofing is directly tested: a process is denied the ability to pass its own `depth`, `rootId`, `budgetKey`, or `agentId` while registering a child — all are rejected as `BrokerArgumentError`, not silently ignored or silently accepted.
- This is the structural foundation [ADR-0024](0024-immutable-identity-fields.md) (immutability after registration) and [ADR-0014](0014-budgetkey-inheritance.md) (inherited, not asserted, budget scope) both build on.
