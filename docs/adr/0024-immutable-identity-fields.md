# ADR-0024: Agent identity fields (`depth`, `parentId`, `rootId`) are permanently immutable after registration

**Status:** Accepted

## Context

Once an agent is registered with a computed `depth`, `parentId`, and `rootId`, the question is whether any later operation should be able to change those values — for instance, to "move" an agent to a different parent, or correct a value after the fact.

## Decision

No update path exists for `depth`, `parentId`, or `rootId` after registration, and none should be added. These fields are set once, at registration time, from the broker's own computation, and never written again.

## Reasoning

These fields are the entire foundation of the trust model described in [ADR-0012](0012-broker-derived-identity-and-depth.md): depth enforcement only means something if depth can't be changed after the fact by anyone, including the agent itself. Any update path — however narrowly scoped or seemingly administrative — would be a direct bypass of that guarantee: an agent whose depth could be lowered post-registration could effectively reset its own position in the tree and escape `maxDepth` enforcement for all its future delegation, which is precisely the failure mode depth-limiting exists to prevent.

## Alternatives considered

- **An administrative/privileged update path for exceptional cases.** Rejected: there is no case where mutating these fields is actually safe, since any caller who could reach such a path could use it to bypass the depth guarantee — "privileged" doesn't change that the capability itself is the vulnerability.
- **Allow re-parenting with depth recomputed from the new parent.** Rejected as solving a need nobody has — if a different tree structure is genuinely wanted, registering a fresh agent under the intended parent accomplishes the same thing without introducing a mutation path into immutable state.

## Consequences

- If an agent is registered under the wrong parent by mistake, the only correct fix is to register a new agent correctly and abandon (let expire, or `deregister()`) the mis-registered one — there is no "fix in place" operation, by design.
- This is directly tested: `register-child.test.ts` and the cross-process depth-spoofing suite both assert that no caller-supplied field can influence a child's computed depth, `rootId`, or `budgetKey`.
