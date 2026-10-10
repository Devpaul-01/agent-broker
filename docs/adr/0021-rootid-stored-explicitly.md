# ADR-0021: `rootId` is stored explicitly at registration, not derived by walking the parent chain

**Status:** Accepted

## Context

Every agent needs to know its tree's root, for grouping and for budget-key inheritance. That value could either be stored directly on each agent at the moment it's created, or computed on demand by following `parentId` links up to the top of the tree whenever it's needed.

## Decision

`rootId` is copied onto every agent's record at registration time — from the parent's own stored `rootId` for a child, or set to the agent's own ID for a root — and never recomputed afterward.

## Reasoning

Storing it explicitly keeps root lookups O(1) regardless of how deep a tree has grown, rather than O(depth) via a chain walk. Since `rootId` (like depth and `parentId`) is immutable once set (see [ADR-0024](0024-immutable-identity-fields.md)), there is no risk of the stored value drifting out of sync with what a chain walk would compute — copying it once at creation time is exactly as correct as recomputing it on every read, just cheaper.

## Alternatives considered

- **Compute `rootId` on demand by walking `parentId` references up the tree.** Rejected: strictly more expensive for no correctness benefit, since the value can never change after registration anyway. This only becomes meaningfully different from the stored approach if ancestor records could be mutated post-creation, which they cannot.

## Consequences

- Looking up an agent's root is a single hash read, regardless of tree depth — this matters in practice since `rootId` is read on the hot path (budget-key resolution happens via the agent's stored `budgetKey`, which is itself inherited the same way at registration).
- If an ancestor agent's record is deleted (e.g. via TTL expiry) after a descendant has already registered, the descendant's own stored `rootId` is unaffected — it was copied at registration time, not re-derived from the (now possibly gone) ancestor.
