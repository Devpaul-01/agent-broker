# ADR-0011: `target` is an opaque, caller-supplied string key

**Status:** Accepted

## Context

The broker needs to group shared state (concurrency counters, circuit-breaker failure windows) by "which downstream thing is being called." The granularity of that grouping has to be decided: too coarse, and unrelated resources get lumped together; too fine, and the library takes on responsibility it shouldn't have.

## Decision

`target` is an opaque string, fully caller-defined, with a recommended (not enforced) convention of `provider:model` — e.g. `"groq:llama-3.3-70b-versatile"`. The broker never parses, validates, or interprets this string's internal structure. It is used purely as a grouping key for `concurrency:{...}` and `circuit:{...}` state.

## Reasoning

- **Provider-level granularity is too coarse.** Grouping by provider alone would conflate resources with materially different rate limits and cost characteristics under one shared concurrency/circuit-breaker state — a burst against one model would wrongly throttle an unrelated model from the same provider.
- **Endpoint-level granularity is unnecessary complexity.** This library isn't a general HTTP proxy; it doesn't need to understand URLs, paths, or request shapes. The caller already knows what it's calling — asking it to supply one opaque label is the minimum information the broker actually needs.
- Treating `target` as opaque also keeps the broker genuinely provider-agnostic (see [ADR-0004](0004-no-provider-abstraction.md)) — it never needs to know what a "model" or "provider" structurally is.

## Alternatives considered

- **Provider-only granularity** (`target = "groq"`). Rejected: mixes resources with different rate limits and cost structures into one shared counter.
- **Structured target** (`{ provider, model, endpoint? }` as an object). Rejected: adds a parsing/validation surface for no behavioral gain — the broker treats the whole thing as one opaque grouping key regardless of its internal shape.

## Consequences

- Two different strings that a human would consider "the same target" (e.g. a typo, or inconsistent casing) are tracked as genuinely different targets with independent concurrency/circuit state — the broker has no way to know they're related, and shouldn't try to guess.
- Consuming applications are responsible for using a consistent, stable string per logical downstream resource. This is documented convention, not an enforced schema.
