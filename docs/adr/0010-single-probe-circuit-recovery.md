# ADR-0010: Circuit recovery closes on one successful probe, not consecutive probe successes

**Status:** Accepted
**Supersedes:** The "recovering" state described in architecture.md Section 7 / Section 9

## Context

The original architecture document describes a three-state circuit breaker: `closed → open → recovering → closed`, where `recovering` is a distinct state requiring **multiple consecutive probe successes** before the circuit fully closes. The implementation that was actually built has two states as far as Redis-stored state goes (`open`, and "not open," which is treated as closed) — a single successful probe closes the circuit immediately and clears the failure window. There is no `recovering` state stored anywhere, and no count of consecutive probe successes.

This is a real divergence between the design document and the shipped code, and it needs a decision recorded, not just a discrepancy left silently in place.

## Decision

**The implementation's behavior is kept: one successful probe closes the circuit immediately.** The architecture document's `recovering` state is retired from the design, not implemented. This ADR is the record of that choice, made deliberately rather than by default.

On a successful probe (`isProbe: true` on the reservation, `success: true` on `reportOutcome`, `feedsCircuit: true`): the circuit state is set directly to `closed` and the entire failure-window sorted set is deleted (`DEL`), in the same atomic script that resolves the reservation.

## Reasoning

- **A single data point is weak evidence of recovery, and the implementation does not pretend otherwise — but neither does requiring N consecutive successes actually fix that**, for a reason worth stating plainly: with `probeRate` typically small (e.g. 0.1), only a trickle of calls are admitted as probes while the circuit is open in the first place. Requiring several *consecutive* probe successes, drawn from an already-thin trickle, measurably lengthens how long a genuinely recovered target stays needlessly gated — and the cost of that choice (continuing to deny real traffic) is concrete and immediate, while the benefit (avoiding one bad reopen) is probabilistic and modest.
- **A full reopen is still cheap and fast if the first probe was a false positive.** If a single successful probe closes the circuit but the target immediately fails again, the very next `requestPermission` call against it starts rebuilding the failure window from a clean slate, and will reach `hardThreshold` again on the same schedule as any other failure streak. The system doesn't get stuck in a bad "trusted" state — it just costs a few more real calls against a still-struggling target before reopening, which is a bounded, self-correcting cost, not an unbounded one.
- **It is measurably simpler and more directly correct to implement as a single atomic step.** Consecutive-success tracking would require its own piece of state (a counter, reset on any probe failure, read-and-incremented atomically alongside everything else in the same script) for a benefit that, per the above, is genuinely marginal. Section 11's governing principle — every check-then-write must be one atomic Lua operation — applies here too, and a three-state design with a consecutive-count requirement is simply more surface area for that atomicity to be gotten wrong.

## Alternatives considered

- **Implement the original three-state design as documented**, with a configurable `recoveryProbeCount` threshold. Rejected for this version: the marginal robustness doesn't clearly justify the added state and added Lua complexity, given the self-correcting cost structure described above. This remains a legitimate enhancement if production usage ever surfaces a specific case where single-probe recovery closes a circuit that immediately deserved to stay open longer — but that would be a data-driven revision, not a first-principles requirement.
- **Keep the `recovering` label in Redis state but make it behaviorally identical to `closed`** (i.e., a cosmetic third state with no different admission logic). Rejected as adding a distinction with no actual difference — worse than removing it, since it implies more sophistication than the system actually has.

## Consequences

- **The architecture document (Section 7, Section 9, and the Redis data model's `circuit:{target}` hash description) needs a follow-up edit** to remove the `recovering` state and the `recentProbeSuccesses` field it describes — those are no longer accurate to what's implemented, and leaving them in place is exactly the kind of doc/code drift this ADR exists to close.
- `correlated-retries.test.ts` already directly tests and asserts this exact behavior ("one process's successful probe recovers the circuit for every other waiting process, not just itself") — the test suite reflects this decision correctly; it was the prose documentation that had drifted, not the code or its tests.
- If a future revision does add multi-probe recovery, it should be a new, explicitly versioned ADR that supersedes this one — not a silent reversion, since callers may come to depend on the current single-probe-closes behavior (e.g., assuming a successful retry after `circuit_open` means the next call is normal again, not still gated).
