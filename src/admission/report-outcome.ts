import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import { fireHook } from "../hooks/fire.js";
import { hmgetBudgetKeyAndTarget } from "../redis/hmget2.js";
import { keys } from "../redis/keys.js";

import { BrokerError } from "../errors/index.js";
import { resolveReservation } from "./resolve-reservation.js";
import { isRedisUnavailableError } from "../redis/unavailable.js";
export interface ReportOutcomeInput {
  /**
   * null is a defined no-op: pass the reservationId you got back from a degraded admission
   * (requestPermission with onRedisUnavailable: 'allow' during a Redis outage), where no
   * reservation was ever created. Calling reportOutcome(null) resolves immediately with no
   * Redis call, rather than requiring callers to remember not to call it at all.
   */
  reservationId: string | null;
  success: boolean;
  actualCost?: number;
  /** Required when success is false: was this failure the target's fault and worth retrying
   * (timeout, 5xx), or not (a local validation error, a 4xx)? Only retryable failures count
   * toward the circuit breaker's sliding window — this is what lets requestPermission tell
   * "target is struggling" apart from "caller made a bad call" (Section 16). */
  retryable?: boolean;
}
export interface Resolved {
  allowed: true;
  costUnknown: boolean;
  /**
   * True when the refund could not be applied because the budget pool no longer existed
   * (deleted externally — the pool has no TTL of its own and nothing in the library deletes
   * it, so this means something outside the broker removed it). The reservation still
   * resolves normally: concurrency is released and it will not be reported on again.
   */
  poolMissing: boolean;
  /** True only for the reservationId: null no-op path — this admission never created a real
   * reservation because Redis was unreachable and onRedisUnavailable was 'allow'. */
  degraded?: boolean;
}
export type ReportDenialReason = "unknown_reservation" | "already_resolved";
export interface ReportDenial {
  allowed: false;
  reason: ReportDenialReason;
}

/** Narrows input down to the case where reservationId is a real, non-empty string — i.e.
 * everything EXCEPT the degraded null no-op, which reportOutcome handles before this runs. */
function validate(input: unknown): asserts input is ReportOutcomeInput & { reservationId: string } {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("reportOutcome() expects an options object");
  }
  const allowed = new Set(["reservationId", "success", "actualCost", "retryable"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new BrokerArgumentError(`reportOutcome() does not accept "${field}"`);
  }
  const { reservationId, success, actualCost, retryable } = input as Record<string, unknown>;
  if (typeof reservationId !== "string" || reservationId.length === 0) {
    throw new BrokerArgumentError("reservationId must be a non-empty string (or exactly null for the degraded no-op case)");
  }
  if (typeof success !== "boolean") {
    throw new BrokerArgumentError(`success must be a boolean, got ${String(success)}`);
  }
  if (actualCost !== undefined && (!Number.isSafeInteger(actualCost) || (actualCost as number) < 0)) {
    throw new BrokerArgumentError(`actualCost must be a non-negative integer, got ${String(actualCost)}`);
  }
  if (success === false && typeof retryable !== "boolean") {
    throw new BrokerArgumentError(
      "retryable (boolean) is required when success is false: the circuit breaker needs to know whether this failure was the target's fault",
    );
  }
  if (success === true && retryable !== undefined) {
    throw new BrokerArgumentError("retryable is only meaningful when success is false");
  }
}

export async function reportOutcome(
  config: ResolvedConfig,
  input: ReportOutcomeInput,
): Promise<Resolved | ReportDenial> {
  // Explicit no-op for a degraded admission that never created a reservation (see the
  // reservationId doc comment above). Checked before validate() — which would otherwise
  // reject null as "not a non-empty string" — so this ordering is load-bearing, not
  // incidental. Still validates the rest of the shape so a genuinely malformed call doesn't
  // silently succeed via this path.
  if (input !== null && typeof input === "object" && input.reservationId === null) {
    if (typeof input.success !== "boolean") {
      throw new BrokerArgumentError(`success must be a boolean, got ${String(input.success)}`);
    }
    const result: Resolved = { allowed: true, costUnknown: true, poolMissing: false, degraded: true };
    fireHook(config.hooks.onOutcome, { reservationId: null, result });
    return result;
  }

  validate(input);
  // From here on, input.reservationId is narrowed to string (not string | null) by the
  // asserts signature above — resolveReservation can never actually receive null.
  const reservationId = input.reservationId;

  const fields = await hmgetBudgetKeyAndTarget(config.redis, keys.reservation(reservationId));
  if (fields === null) {
    const result: ReportDenial = { allowed: false, reason: "unknown_reservation" };
    fireHook(config.hooks.onOutcome, { reservationId, result });
    return result;
  }
  let outcome: Awaited<ReturnType<typeof resolveReservation>>;
  try {
    outcome = await resolveReservation(config, {
  reservationId,
  budgetKey: fields.budgetKey,
  target: fields.target,
  success: input.success,
  ...(input.actualCost !== undefined ? { actualCost: input.actualCost } : {}),
  ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
  feedsCircuit: true,
  windowMs: config.circuitBreaker.windowMs,
  hardThreshold: config.circuitBreaker.hardThreshold,
});
  } catch (error) {
    if (!isRedisUnavailableError(error)) throw error; // real bugs still throw, never swallowed here

    // Redis is unreachable: we cannot refund, release concurrency, or mark this resolved right
    // now. If onRedisUnavailable is 'allow', accept the loss rather than throw — the original
    // reservation stays unresolved in Redis and will eventually be picked up by lazy cleanup
    // once Redis is healthy again and a later requestPermission call sweeps it, same path as
    // a crashed caller that never reported at all. If 'deny', throwing is correct: the caller
    // explicitly opted into fail-closed behavior and should know this report did not land.
    if (config.onRedisUnavailable === "deny") {
      throw new BrokerError(`reportOutcome failed: Redis unreachable and onRedisUnavailable is 'deny'`, { cause: error });
    }
    const result: Resolved = { allowed: true, costUnknown: true, poolMissing: false, degraded: true };
    fireHook(config.hooks.onOutcome, { reservationId, result });
    return result;
  }
  if (!outcome.resolved) {
    const result: ReportDenial = { allowed: false, reason: outcome.reason };
    fireHook(config.hooks.onOutcome, { reservationId, result });
    return result;
  }

  const result: Resolved = { allowed: true, costUnknown: outcome.costUnknown, poolMissing: outcome.poolMissing };
  fireHook(config.hooks.onOutcome, { reservationId, result });
  return result;
}