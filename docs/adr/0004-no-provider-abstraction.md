# ADR-0004: No provider abstraction in the library (reaffirms ADR-9)

**Status:** Accepted (reaffirmation)

## Context

The architecture document's ADR-9 establishes `agent-broker` as a pure permission gate:
`requestPermission()` → caller performs its own downstream call → `reportOutcome()`. The
library never executes a downstream call itself, and therefore has no `DownstreamProvider`
interface, no `FakeProvider`, no `GroqProvider`.

The initial implementation brief for this coding phase, written before this session's
architecture re-read, described exactly such a provider abstraction (`FakeProvider`,
`GroqProvider` conforming to a shared interface) as part of the build plan.

## Decision

ADR-9 stands. No provider abstraction exists in `src/`. Test-only simulation of a downstream
call lives in the test harness (`test/helpers/worker.ts` and related fixtures) as plain
TypeScript, not as a library-exposed interface. A Groq integration, if ever built, belongs in
an `examples/` directory outside the library's public surface — not yet built, deferred.

## Consequences

- Cost estimation, provider-specific error handling, and retry/backoff logic for a specific
  downstream provider are all caller-side concerns, by design. The library only ever sees an
  opaque `target` string and a caller-supplied `estimatedCost`.
- This was caught during the initial repository audit (see the first implementation-readiness
  report), before any provider-abstraction code was written — worth recording specifically
  because it's an example of the "architecture document is the source of truth, but not an
  unquestionable specification" principle working as intended: a request to build something
  was checked against the design document first, a conflict was found, and it was resolved
  before implementation rather than silently building both or silently picking one.