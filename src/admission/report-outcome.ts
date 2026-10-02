import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError, BrokerError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";

export interface ReportOutcomeInput {
  reservationId: string;
  success: boolean;
  actualCost?: number;
}
export interface Resolved {
  allowed: true;
  costUnknown: boolean;
}
export type ReportDenialReason = "unknown_reservation" | "already_resolved";
export interface ReportDenial {
  allowed: false;
  reason: ReportDenialReason;
}

/**
 * KEYS[1] reservation hash   KEYS[2] budget pool (integer)
 * KEYS[3] concurrency counter (integer)   KEYS[4] expiring-reservations sorted set
 * ARGV[1] reservationId  ARGV[2] success ("1"/"0")  ARGV[3] actualCostGiven ("1"/"0")
 * ARGV[4] actualCost (ignored if ARGV[3] is "0")  ARGV[5] now (ms)
 *
 * Existence check, idempotency check, refund computation, and all four state mutations
 * (budget, concurrency, reservation.resolved, sorted-set removal) happen in one atomic step.
 * Two reportOutcome calls racing on the same reservationId must not both refund: the script
 * reads and sets 'resolved' itself rather than trusting a separate TypeScript-side check,
 * which would reopen the same read-then-write race pattern seen in every earlier script.
 *
 * Refund formula (see the table in the accompanying commit message / PR description):
 *   actualCost given  -> refund = estimatedCost - actualCost   (can be negative; reconciliation
 *                         is allowed to push the pool below zero, unlike admission, which never
 *                         is — Invariant 5 governs admission only)
 *   success, no cost  -> refund = 0, costUnknown = true
 *   failure, no cost  -> refund = estimatedCost (full refund)
 */
const REPORT_OUTCOME = defineScript(
  `
local r = redis.call('HMGET', KEYS[1], 'resolved', 'estimatedCost', 'budgetKey', 'target')
if not r[2] then
  return {0, 'unknown_reservation'}
end
if r[1] == '1' then
  return {0, 'already_resolved'}
end

local estimatedCost = tonumber(r[2])
local success = ARGV[2] == '1'
local costGiven = ARGV[3] == '1'
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

if refund ~= 0 then
  redis.call('INCRBY', KEYS[2], refund)
end
redis.call('DECR', KEYS[3])
redis.call('HSET', KEYS[1], 'resolved', '1', 'resolvedAt', ARGV[5], 'costUnknown', tostring(costUnknown))
redis.call('ZREM', KEYS[4], ARGV[1])

return {1, costUnknown}
`,
  4,
);

function validate(input: unknown): asserts input is ReportOutcomeInput {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("reportOutcome() expects an options object");
  }
  const allowed = new Set(["reservationId", "success", "actualCost"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new BrokerArgumentError(`reportOutcome() does not accept "${field}"`);
  }
  const { reservationId, success, actualCost } = input as Record<string, unknown>;
  if (typeof reservationId !== "string" || reservationId.length === 0) {
    throw new BrokerArgumentError("reservationId must be a non-empty string");
  }
  if (typeof success !== "boolean") {
    throw new BrokerArgumentError(`success must be a boolean, got ${String(success)}`);
  }
  if (actualCost !== undefined && (!Number.isSafeInteger(actualCost) || (actualCost as number) < 0)) {
    throw new BrokerArgumentError(`actualCost must be a non-negative integer, got ${String(actualCost)}`);
  }
}

export async function reportOutcome(
  config: ResolvedConfig,
  input: ReportOutcomeInput,
): Promise<Resolved | ReportDenial> {
  validate(input);

  // budgetKey/target aren't needed by TypeScript here (the script reads them from the
  // reservation hash itself), but concurrency's key must be built outside Lua, same
  // constraint as in requestPermission. We need target+budgetKey before calling the script,
  // so we read them first. This mirrors requestPermission's budgetKey read: the values are
  // immutable on an unresolved reservation, so a separate read cannot go stale in a way that
  // matters — only 'does this reservation still exist / is it already resolved' can change
  // between this read and the script's write, and the script re-checks both atomically.
  const [budgetKey, target] = await config.redis.hmget(keys.reservation(input.reservationId), "budgetKey", "target");
  if (budgetKey === null || target === null) {
    return { allowed: false, reason: "unknown_reservation" };
  }

  const reply = await runScript(
    config.redis,
    REPORT_OUTCOME,
    [keys.reservation(input.reservationId), keys.budget(budgetKey), keys.concurrency(target, budgetKey), keys.reservationsExpiring()],
    [
      input.reservationId,
      input.success ? "1" : "0",
      input.actualCost !== undefined ? "1" : "0",
      input.actualCost ?? 0,
      Date.now(),
    ],
  );

  if (Array.isArray(reply)) {
    const [status, a] = reply as unknown[];
    if (status === 0 && (a === "unknown_reservation" || a === "already_resolved")) {
      return { allowed: false, reason: a };
    }
    if (status === 1) return { allowed: true, costUnknown: a === 1 };
  }
  throw new BrokerError(`unexpected reply from report-outcome script: ${JSON.stringify(reply)}`);
}