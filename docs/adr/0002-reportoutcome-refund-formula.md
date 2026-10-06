# ADR-0002: reportOutcome refund formula

**Status:** Accepted

## Context

`reportOutcome({ reservationId, success, actualCost? })` needs a defined rule for how much of
a reservation's `estimatedCost` gets refunded to the budget pool. There are four raw input
combinations (success × actualCost-given), and handling them ad hoc risks silently hiding bugs
in integrator code — specifically, assuming a caller's intent when they didn't report cost
can't be distinguished from the caller simply forgetting to.

## Decision

| `success` | `actualCost` given? | Refund to pool |
|---|---|---|
| `true` | yes | `estimatedCost - actualCost` (can be negative) |
| `true` | no | `0` (charge full estimate, mark `costUnknown: true`) |
| `false` | yes | `estimatedCost - actualCost` (a failed call can still have real cost) |
| `false` | no | `estimatedCost` (full refund) |

The simplified rule underlying this table: **`actualCost`, when present, always determines the
refund as `estimatedCost - actualCost`, independent of `success`.** `success` only controls the
fallback when `actualCost` is absent.

## Reasoning, including a correction made mid-design

**`success: true`, no `actualCost`:** treated as "the call succeeded but we don't know what it
cost," not "assume it cost exactly the estimate." Silently assuming `actual == estimate` would
mask a caller that called `reportOutcome` incorrectly (forgot to pass cost). The pool keeps
what it reserved rather than guessing downward — the conservative choice.

**`success: false`:** the initial design was "always fully refund on failure, regardless of
`actualCost`." That reasoning held `success` and `actualCost` as coupled. It was revised once a
concrete counterexample surfaced: a downstream provider that bills a partial completion even
on failure. If `success` and `actualCost` are treated as **independent axes** — one says
whether the call worked, the other says what it cost — then a failed call with genuine partial
cost should be refunded by that formula too, not assumed to have cost nothing. The final rule
reflects this correction.

## Consequences

- Invariant 5 (admission never pushes the budget pool negative) is explicitly scoped to
  **admission only**. Reconciliation via this formula is allowed to push the pool negative,
  when `actualCost` exceeds `estimatedCost` — these are two different guarantees, stated
  separately rather than as one blanket "budget never goes negative" rule.
- An integrator who always omits `actualCost` on success gets a system that behaves correctly
  but conservatively (never refunds unused estimate), which is a safe default to discover
  rather than a silent cost-accounting bug.