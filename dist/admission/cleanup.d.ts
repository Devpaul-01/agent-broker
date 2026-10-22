import type { ResolvedConfig } from "../config/index.js";
/**
 * Finds reservations whose logical expiry (the reservationsExpiring sorted-set score) has
 * passed, and resolves any that were never reported. Triggered from inside requestPermission,
 * not from a background timer (ADR-15 / ADR-0001: lazy, not event-driven).
 *
 * An abandoned reservation is resolved as success: false, no actualCost (full refund) — the
 * conservative choice, since the broker has no evidence either way about whether the call
 * actually succeeded. This also means feedsCircuit is false: a crash is evidence about the
 * *caller*, not the target, so cleanup must never count toward the circuit breaker regardless
 * of outcome — conflating the two would let a crashing caller trip the circuit for every
 * other caller sharing that target.
 *
 * A candidate whose hash is already gone (past its grace-period TTL) or already resolved
 * (reportOutcome won the race, or a prior sweep already handled it) is simply removed from
 * the sorted set with no refund — resolveReservation's own idempotency check (not this
 * function) is what makes that safe under concurrent cleanup/reportOutcome calls.
 *
 * onCleanup fires only when a sweep actually resolves a genuine orphan, not on every sweep —
 * most sweeps in a healthy system find nothing, and firing on an empty or already-resolved
 * candidate would make the hook noisy without carrying any real signal.
 */
export declare function sweepExpiredReservations(config: ResolvedConfig): Promise<void>;
