# ADR-0025: `addBudget` is additive-only; no arbitrary "set balance to X" operation exists

**Status:** Accepted

## Context

Applications need a way to top up a budget pool — for instance, a billing cycle renewing a user's monthly allowance. The question is whether that operation should be a pure addition, or whether a more general "set the pool to this exact value" operation should also be offered.

## Decision

`addBudget(budgetKey, amount)` only ever adds to the existing balance. No operation exists, or should be added, to set a pool's balance to an arbitrary absolute value.

## Reasoning

An additive-only operation is strictly safe: it can never retroactively invalidate a decision the broker already made, because it only ever increases what's available — it cannot un-admit a call that was already granted. A "set to X" operation does not have this property: a pool can carry a legitimately-incurred negative balance from reconciliation overrun (see the refund-formula ADR, [ADR-0002](0002-reportoutcome-refund-formula.md), and `architecture.md` Section 5) when `actualCost` exceeds `estimatedCost`. Setting the balance to an arbitrary value could silently erase that legitimately-incurred deficit — effectively letting a caller "launder" an overrun it had already caused, with no record that anything was corrected.

## Alternatives considered

- **A general `setBudget(budgetKey, amount)` operation**, for administrative convenience. Rejected: the risk of silently erasing a legitimate reconciliation deficit outweighs the convenience, especially since the deficit case is specifically the scenario an administrator doing a "quick fix" would be least likely to notice they're erasing.
- **A `setBudget` operation that refuses to overwrite a negative balance.** Rejected as a half-measure — this still allows overwriting any non-negative balance with an arbitrary value, discarding whatever legitimate reservation/refund history produced that number, for a convenience that `addBudget` already serves safely.

## Consequences

- Reducing a pool's balance (as opposed to topping it up) is not supported as a direct operation. An application that genuinely needs to claw back budget must do so by other means (e.g., not renewing it, or tracking the reduction at the application layer) — this is an accepted limitation of the additive-only design.
- Billing-cycle renewal is the expected use: call `addBudget` with the new period's allotment, which correctly adds on top of whatever balance (positive or negative) the pool already carries from the prior period.
