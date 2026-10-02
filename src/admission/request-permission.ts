import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError, BrokerError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";

export interface RequestPermissionInput {
  agentId: string;
  target: string;
  estimatedCost: number;
  ttl?: number;
}
export interface Admitted {
  allowed: true;
  reservationId: string;
}
export type DenialReason = "unknown_agent" | "budget_exceeded";
export interface Denied {
  allowed: false;
  reason: DenialReason;
}

// Grace period beyond the caller's TTL before the reservation hash is physically deleted.
// The sorted-set score (expiresAt), not this Redis-level TTL, is what decides logical expiry;
// the grace period only keeps the hash's fields alive long enough for lazy cleanup to read them.
const RESERVATION_GRACE_MS = 5_000;

/**
 * KEYS[1] agent hash   KEYS[2] budget pool (integer)   KEYS[3] new reservation hash
 * KEYS[4] expiring-reservations sorted set
 * ARGV[1] agentId  ARGV[2] estimatedCost  ARGV[3] target  ARGV[4] ttl (ms)
 * ARGV[5] now (ms)  ARGV[6] reservationId  ARGV[7] agentTtl (ms)  ARGV[8] grace (ms)
 *
 * The caller already read the agent's budgetKey (immutable per ADR-20, so a separate read is
 * safe) to build KEYS[2] — Lua cannot compute a key name from data it reads mid-script. This
 * script re-checks agent *existence* itself: that is the part that can change between the
 * caller's earlier read and now (Section 11, race #4), not the budgetKey value.
 *
 * Budget check-and-reserve is one atomic step (race #1): two concurrent calls could otherwise
 * both read "enough budget" before either decrements, and both admit. A missing pool reads as
 * balance 0, so an unfunded budgetKey denies exactly like an empty one. Nothing is written on
 * denial.
 */
const REQUEST_PERMISSION = defineScript(
  `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'unknown_agent'}
end

local cost = tonumber(ARGV[2])
local balanceRaw = redis.call('GET', KEYS[2])
local balance = balanceRaw and tonumber(balanceRaw) or 0
if balance < cost then
  return {0, 'budget_exceeded'}
end

redis.call('DECRBY', KEYS[2], cost)
redis.call('HSET', KEYS[3],'agentId', ARGV[1], 'budgetKey', ARGV[8], 'target', ARGV[3], 'estimatedCost', cost, 'createdAt', ARGV[5])
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[4]) + tonumber(ARGV[8]))
redis.call('ZADD', KEYS[4], tonumber(ARGV[5]) + tonumber(ARGV[4]), ARGV[6])
redis.call('HSET', KEYS[1], 'lastHeartbeat', ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[7]))
return {1}
`,
  4,
);

function validate(input: unknown): asserts input is RequestPermissionInput {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("requestPermission() expects an options object");
  }
  const allowed = new Set(["agentId", "target", "estimatedCost", "ttl"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new BrokerArgumentError(`requestPermission() does not accept "${field}"`);
  }
  const { agentId, target, estimatedCost, ttl } = input as Record<string, unknown>;
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new BrokerArgumentError("agentId must be a non-empty string");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new BrokerArgumentError("target must be a non-empty string");
  }
  if (!Number.isSafeInteger(estimatedCost) || (estimatedCost as number) <= 0) {
    throw new BrokerArgumentError(`estimatedCost must be a positive integer, got ${String(estimatedCost)}`);
  }
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || (ttl as number) <= 0)) {
    throw new BrokerArgumentError(`ttl must be a positive integer (ms), got ${String(ttl)}`);
  }
}

export async function requestPermission(
  config: ResolvedConfig,
  input: RequestPermissionInput,
): Promise<Admitted | Denied> {
  validate(input);

  const ttl = input.ttl ?? config.defaultReservationTtl;
  if (ttl > config.maxReservationTtl) {
    throw new BrokerArgumentError(
      `ttl (${ttl}ms) exceeds maxReservationTtl (${config.maxReservationTtl}ms) configured for this broker`,
    );
  }

  // budgetKey is immutable once set (ADR-20), so reading it here, separately from the atomic
  // existence check inside the script, cannot go stale. Only "does the agent still exist" can
  // change between this read and the script's write, and the script re-checks that itself.
  const budgetKey = await config.redis.hget(keys.agent(input.agentId), "budgetKey");
  if (budgetKey === null) {
    return { allowed: false, reason: "unknown_agent" };
  }

  const reservationId = randomUUID();
  const reply = await runScript(
    config.redis,
    REQUEST_PERMISSION,
    [keys.agent(input.agentId), keys.budget(budgetKey), keys.reservation(reservationId), keys.reservationsExpiring()],
 [input.agentId, input.estimatedCost, input.target, ttl, Date.now(), reservationId, config.agentTtl, budgetKey, RESERVATION_GRACE_MS] );

  if (Array.isArray(reply)) {
    const [status, reason] = reply as unknown[];
    if (status === 0 && (reason === "unknown_agent" || reason === "budget_exceeded")) {
      return { allowed: false, reason };
    }
    if (status === 1) return { allowed: true, reservationId };
  }
  throw new BrokerError(`unexpected reply from request-permission script: ${JSON.stringify(reply)}`);
}