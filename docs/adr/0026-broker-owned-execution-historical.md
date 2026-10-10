# ADR-0026: Broker-owned downstream execution (historical — superseded before implementation)

**Status:** Superseded by [ADR-0004](0004-no-provider-abstraction.md)

## Context

This entry records a design-session decision that was made and then reversed before any code was written against it, kept here only so the design history is complete and nothing is silently missing from the record.

## Decision (as originally made, now superseded)

An early design pass had the broker own invocation of the downstream provider directly — callers would pass data describing the call, and the broker itself would make it, specifically so that retries could not be hidden from the broker's coordination logic inside a caller-supplied callback.

## What changed

This was reversed by the pivot recorded in [ADR-0004](0004-no-provider-abstraction.md): the broker become a pure permission gate (`requestPermission` / `reportOutcome`), never executing downstream calls itself. See ADR-0004 for the full reasoning — in short, restricting the broker to an LLM-shaped execution interface artificially narrowed its applicability, and the alternative that motivated the original decision (callers hiding retries inside an opaque callback) turned out to have a better fix: requiring permission to be requested before *each individual attempt* makes retries visible without the broker needing to own execution at all.

## Consequences

- No code in this repository reflects the originally-decided behavior; it was reversed during the same design session, before implementation began.
- Kept as a historical record only, per the project's own documentation standard of recording rejected alternatives rather than silently deleting them.
