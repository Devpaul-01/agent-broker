# ADR-0015: An unspecified `budgetKey` defaults to the root's own broker-issued agent ID

**Status:** Accepted

## Context

If a caller registers a root without specifying `budgetKey`, the broker still needs some key to scope that root's budget pool under. The natural-seeming shortcut — a single fixed default string for every caller that omits the field — was considered during design and found to have a real, non-obvious failure mode.

## Decision

An omitted `budgetKey` defaults to the root agent's own broker-issued `agentId` — i.e., private by default. Every root that doesn't explicitly opt into sharing gets its own untouched pool. Explicit cross-root budget sharing requires deliberately passing the same `budgetKey` string at each root's registration.

## Reasoning

A single fixed default string (e.g. `"__default__"`) was the first idea, and it was rejected specifically because it risks **accidental, invisible budget sharing** between unrelated features that both simply forgot to specify a key. Two completely unrelated parts of an application — or two unrelated applications pointed at the same Redis instance — could each omit `budgetKey`, land on the same fixed default, and silently start competing for the same pool with no indication anything was shared at all. Using the root's own unique ID as the default makes "no sharing" the safe, silent default, and makes sharing something that only happens when a caller deliberately asks for it.

## Alternatives considered

- **A single fixed default string for all unspecified budget keys.** Rejected for the accidental-sharing risk described above — this was identified during design as a real trap, not a hypothetical one.
- **Require `budgetKey` on every root registration (no default at all).** Rejected as unnecessary friction for the common case of a root that genuinely doesn't need to share its budget with anything — most roots are private by nature, and forcing an explicit key for all of them adds boilerplate without adding safety.

## Consequences

- Two callers who both want private, unshared budgets never have to think about this at all — the default is already correct for them.
- Intentional sharing (e.g. multiple application instances serving the same user, or multiple sessions under one account spend ceiling) is always a visible, explicit choice at registration time — never something that happens by coincidence.
