# ADR-0020: `actualCost` reconciliation and the `costUnknown` signal

**Status:** Accepted (refined during implementation — see Consequences)

## Context

The original design called for `reportOutcome` to accept an explicit `costUnknown: true` flag from the caller, used when a downstream call succeeded but the real usage couldn't be determined (e.g., the provider returned no usage metadata), so the broker wouldn't silently default to an arbitrary placeholder cost. That placeholder-default idea — e.g. always charging `1` when cost is unknown — was explicitly considered and rejected during design: a plausible-looking wrong number would silently corrupt budget accounting in a way that's invisible until the numbers stop adding up much later.

## Decision

On `success: true` with no `actualCost` given, the broker releases the originally reserved `estimatedCost` back as the settled cost (the best information actually available) and reports `costUnknown: true` in its response. On `success: false` with no `actualCost` given, the full `estimatedCost` is refunded. Whenever `actualCost` **is** given, it is used directly regardless of `success`, and `costUnknown` is `false`.

## Reasoning

Never silently defaulting to an arbitrary placeholder cost remains the core guarantee — that part of the original decision stands unchanged. What changed is *how* the caller signals "I don't know the real cost": rather than requiring a separate explicit `costUnknown: true` input field that has to agree with whether `actualCost` was actually supplied, the implementation infers it directly from whether `actualCost` was given at all. Omitting `actualCost` on success *is* the "I don't know" signal; there's no second field that could disagree with it.

## Alternatives considered

- **Explicit `costUnknown: true` as a required separate input field** (the original design). Rejected during implementation: this creates two fields (`actualCost`, `costUnknown`) that must be kept consistent with each other, and nothing prevents a caller from passing contradictory values (e.g. `actualCost: 500, costUnknown: true`). Inferring `costUnknown` from the absence of `actualCost` removes that whole class of inconsistency by construction.
- **Default unknown cost to a fixed placeholder (e.g. `1`).** Rejected outright, as in the original design — this is the specific failure mode this decision exists to prevent.

## Consequences

- `reportOutcome`'s actual input shape is `{ reservationId, success, actualCost?, retryable? }` — `costUnknown` never appears as an input, only as a field on the response (`Resolved.costUnknown`).
- This is a case where the shipped implementation is a genuine simplification of the original design, not merely a different-but-equivalent choice — it was found during implementation, not specified upfront, and is recorded here so the discrepancy between the original handoff document's API sketch and the real API is a deliberate, understood choice rather than silent drift.
