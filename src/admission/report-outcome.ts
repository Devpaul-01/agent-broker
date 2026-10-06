import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError, BrokerError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";
import { resolveReservation } from "./resolve-reservation.js";

export interface ReportOutcomeInput {
  /** null is a defined no-op: pass the reservationId you got back from a degraded admission
   * (requestPermission with onRedisUnavailable: 'allow' during a Redis outage), where no
   * reservation was ever created. Calling reportOutcome(null) resolves immediately with no
   * Redis call, rather than requiring callers to remember not to call it at all. */
  reservationId: string | null;
  success: boolean;
  actualCost?: number;
  retryable?: boolean;
}
export interface Resolved {
  allowed: true;
  costUnknown: boolean;
  poolMissing: boolean;
  degraded?: boolean;
}
export type ReportDenialReason = "unknown_reservation" | "already_resolved";
export interface ReportDenial {
  allowed: false;
  reason: ReportDenialReason;
}

function validate(input: unknown): asserts input is ReportOutcomeInput {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("reportOutcome() expects an options object");
  }
  const allowed = new Set(["reservationId", "success", "actualCost", "retryable"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new BrokerArgumentError(`reportOutcome() does not accept "${field}"`);
  }
  const { reservationId, success, actualCost, retryable } = input as Record<string, unknown>;
  if (typeof reservationId !== "string" || reservationId.length === 0) {
    throw new BrokerArgumentError("reservationId must be a non-empty string");
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
  if (input !== null && typeof input === "object" && input.reservationId === null) {
    // Explicit no-op: see ReportOutcomeInput.reservationId's doc comment. Still validate the
    // rest of the shape so a genuinely malformed call doesn't silently succeed via this path.
    if (typeof input.success !== "boolean") {
      throw new BrokerArgumentError(`success must be a boolean, got ${String(input.success)}`);
    }
    return { allowed: true, costUnknown: true, poolMissing: false, degraded: true };
  }
  validate(input);

 const reservationId = input.reservationId;
  if (typeof reservationId !== "string") {
    // unreachable after validate(), but narrows the type for the compiler
    throw new BrokerArgumentError("reservationId must be a non-empty string");
  }
  

  const [budgetKey, target] = await config.redis.hmget(keys.reservation(input.reservationId), "budgetKey", "target");
  if (!budgetKey || !target) {
    return { allowed: false, reason: "unknown_reservation" };
  }

  const result = await resolveReservation(config, {
    reservationId: input.reservationId,
    budgetKey,
    target,
    success: input.success,
    ...(input.actualCost !== undefined ? { actualCost: input.actualCost } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    feedsCircuit: true,
    windowMs: config.circuitBreaker.windowMs,
  });

  if (!result.resolved) return { allowed: false, reason: result.reason };
  return { allowed: true, costUnknown: result.costUnknown, poolMissing: result.poolMissing };
}