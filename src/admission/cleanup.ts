import type { ResolvedConfig } from "../config/index.js";
import { keys } from "../redis/keys.js";
import { resolveReservation } from "./resolve-reservation.js";

// Bounded per-call work: each requestPermission call sweeps at most this many expired-but-
// unresolved reservations. Not configurable yet — no usage data to justify a tuned default,
// same reasoning as the retryAfter formula. A busy system drains its backlog gradually across
// many calls rather than in one unbounded scan; a healthy system pays for one cheap, empty
// ZRANGEBYSCORE per call.
const CLEANUP_BATCH_SIZE = 5;

/**
 * Finds reservations whose logical expiry (the reservationsExpiring sorted-set score) has
 * passed, and resolves any that were never reported. Triggered from inside requestPermission,
 * not from a background timer (ADR-15: lazy, not event-driven).
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
 */
export async function sweepExpiredReservations(config: ResolvedConfig): Promise<void> {
  const now = Date.now();
  const candidates = await config.redis.zrangebyscore(
    keys.reservationsExpiring(),
    "-inf",
    now,
    "LIMIT",
    0,
    CLEANUP_BATCH_SIZE,
  );
  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map(async (reservationId) => {
      const [budgetKey, target] = await config.redis.hmget(keys.reservation(reservationId), "budgetKey", "target");
      if (!budgetKey || !target ) {
        // Hash already gone (past grace period) — nothing to refund, just drop the stale
        // sorted-set entry so future sweeps don't keep rediscovering it.
        await config.redis.zrem(keys.reservationsExpiring(), reservationId);
        return;
      }
      await resolveReservation(config, {
        reservationId,
        budgetKey,
        target,
        success: false,
        feedsCircuit: false,
        windowMs: config.circuitBreaker.windowMs,
      });
    }),
  );
}