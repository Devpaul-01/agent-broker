import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError, BrokerError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";

export interface ReportOutcomeInput {
  reservationId: string;
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
  poolMissing: boolean;
}
export type ReportDenialReason = "unknown_reservation" | "already_resolved";
export interface ReportDenial {
  allowed: false;
  reason: ReportDenialReason;
}

/**
 * KEYS[1] reservation hash          KEYS[2] budget pool (integer)
 * KEYS[3] concurrency counter       KEYS[4] expiring-reservations sorted set
 * KEYS[5] circuit failure window (sorted set, per target)
 * KEYS[6] circuit state (string, per target)
 * ARGV[1] reservationId  ARGV[2] success ("1"/"0")  ARGV[3] actualCostGiven ("1"/"0")
 * ARGV[4] actualCost  ARGV[5] now (ms)  ARGV[6] retryable ("1"/"0", only meaningful if !success)
 * ARGV[7] windowMs  ARGV[8] softThreshold  ARGV[9] hardThreshold
 *
 * See earlier comments in this file for the budget/concurrency/idempotency/poolMissing
 * reasoning, unchanged here. This version adds circuit-breaker bookkeeping:
 *
 * A retryable failure is recorded into a sliding-window sorted set (member=reservationId,
 * score=failure time), trimmed to the window on every write so it never grows unbounded.
 * This is recording only — the admission-time decision (soft/hard threshold, open/closed)
 * lives in requestPermission's script, which reads this same window. The two are separate
 * atomic operations on shared state, not one race, because "did a failure just happen" and
 * "how many calls should currently be admitted" are asked at different times by different
 * callers.
 *
 * A resolved reservation that was flagged as a probe (isProbe='1', stamped by requestPermission
 * when it admitted this call as the probe for an open circuit) gets special handling: success
 * closes the circuit and clears the window (recovery confirmed); failure does nothing extra
 * here (it was already recorded as a retryable failure above, if retryable was true) — the
 * circuit just stays open and waits for the next probe draw.
 */
const REPORT_OUTCOME = defineScript(
  `
local r = redis.call('HMGET', KEYS[1], 'resolved', 'estimatedCost', 'budgetKey', 'target', 'isProbe')
if not r[2] then
  return {0, 'unknown_reservation'}
end
if r[1] == '1' then
  return {0, 'already_resolved'}
end

local estimatedCost = tonumber(r[2])
local success = ARGV[2] == '1'
local costGiven = ARGV[3] == '1'
local retryable = ARGV[6] == '1'
local isProbe = r[5] == '1'
local refund
local costUnknown = 0

if costGiven then
  refund = estimatedCost - tonumber(ARGV[4])
elseif success then
  refund = 0
  costUnknown = 1
else
  refund = estimatedCost
end

local poolMissing = 0
if refund ~= 0 then
  if redis.call('EXISTS', KEYS[2]) == 1 then
    redis.call('INCRBY', KEYS[2], refund)
  else
    poolMissing = 1
  end
end

redis.call('DECR', KEYS[3])
redis.call('HSET', KEYS[1], 'resolved', '1', 'resolvedAt', ARGV[5], 'costUnknown', tostring(costUnknown))
redis.call('ZREM', KEYS[4], ARGV[1])

if not success and retryable then
  redis.call('ZADD', KEYS[5], ARGV[5], ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', tonumber(ARGV[5]) - tonumber(ARGV[7]))
end

if isProbe then
  if success then
    redis.call('SET', KEYS[6], 'closed')
    redis.call('DEL', KEYS[5])
  end
  -- a failed probe needs no extra action: it was recorded above (if retryable), state stays open
end

return {1, costUnknown, poolMissing}
`,
  6,
);

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
  validate(input);

  const [budgetKey, target] = await config.redis.hmget(keys.reservation(input.reservationId), "budgetKey", "target");
  if (!budgetKey || !target) {
    return { allowed: false, reason: "unknown_reservation" };
  }

  const reply = await runScript(
    config.redis,
    REPORT_OUTCOME,
    [
      keys.reservation(input.reservationId),
      keys.budget(budgetKey),
      keys.concurrency(target, budgetKey),
      keys.reservationsExpiring(),
      keys.circuit(target),
      keys.circuitState(target),
    ],
    [
      input.reservationId,
      input.success ? "1" : "0",
      input.actualCost !== undefined ? "1" : "0",
      input.actualCost ?? 0,
      Date.now(),
      input.retryable ? "1" : "0",
      config.circuitBreaker.windowMs,
      config.circuitBreaker.softThreshold,
      config.circuitBreaker.hardThreshold,
    ],
  );

  if (Array.isArray(reply)) {
    const [status, a, b] = reply as unknown[];
    if (status === 0 && (a === "unknown_reservation" || a === "already_resolved")) {
      return { allowed: false, reason: a };
    }
    if (status === 1) return { allowed: true, costUnknown: a === 1, poolMissing: b === 1 };
  }
  throw new BrokerError(`unexpected reply from report-outcome script: ${JSON.stringify(reply)}`);
}