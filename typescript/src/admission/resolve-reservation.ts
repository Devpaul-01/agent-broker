 import type { ResolvedConfig } from "../config/index.js";
import { BrokerError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";
import { fireHook } from "../hooks/fire.js";
export interface ResolveOutcome {
  resolved: true;
  costUnknown: boolean;
  poolMissing: boolean;
  circuitClosed: boolean;
}
export type ResolveSkipReason = "unknown_reservation" | "already_resolved";
export interface ResolveSkipped {
  resolved: false;
  reason: ResolveSkipReason;
}

/**
 * The single script that closes a reservation's lifecycle, called from two places:
 * reportOutcome (caller explicitly reports success/failure) and the lazy-cleanup sweep inside
 * requestPermission (caller never reported at all, and the reservation has logically expired).
 * Extracting this once, rather than writing cleanup as a second independent script, means the
 * idempotency guarantee (resolved flag, checked and set atomically here) automatically covers
 * races between reportOutcome and cleanup racing on the same reservation — there is structurally
 * only one place a reservation can be resolved, so there is only one idempotency check to get
 * right, not two that must agree with each other.
 *
 * KEYS[1] reservation hash          KEYS[2] budget pool
 * KEYS[3] concurrency counter       KEYS[4] expiring-reservations sorted set
 * KEYS[5] circuit failure window    KEYS[6] circuit state
 * ARGV[1] reservationId  ARGV[2] success ("1"/"0")  ARGV[3] actualCostGiven ("1"/"0")
 * ARGV[4] actualCost  ARGV[5] now (ms)  ARGV[6] retryable ("1"/"0")
 * ARGV[7] windowMs  ARGV[8] feedsCircuit ("1"/"0") — false for cleanup: an abandoned
 *   reservation is evidence the caller crashed, not that the target is failing, so cleanup
 *   must never write into the circuit breaker's window regardless of the retryable flag.
 * ARGV[9] hardThreshold
 *
 * The circuit must open the moment the threshold-crossing failure is reported here, not wait
 * for some later requestPermission call to lazily observe the count — a caller who only ever
 * calls reportOutcome (or a test asserting on hook calls right after the Nth reportOutcome)
 * would otherwise see a stale 'closed'/null state even though the breaker has, in substance,
 * already tripped. So after writing this failure into the window and trimming it, we check the
 * fresh count right here and flip state to 'open' (once, guarded by not already being 'open')
 * if it has reached hardThreshold, firing the same onCircuitStateChange signal that
 * requestPermission's own first-observation path fires. requestPermission still carries its own
 * redundant hardThreshold check as a fallback (e.g. if circuitBreaker config differs between
 * calls), but it is a no-op once this script has already set state to 'open' — it reads 'open'
 * first and takes the probe-logic branch instead of re-setting state or re-firing the hook.
 *
 * See report-outcome.ts's prior history for the refund-formula and poolMissing reasoning,
 * unchanged here.
 */
const RESOLVE_RESERVATION = defineScript(
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
local feedsCircuit = ARGV[8] == '1'
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

local opened = '0'
if feedsCircuit and not success and retryable then
  redis.call('ZADD', KEYS[5], ARGV[5], ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', tonumber(ARGV[5]) - tonumber(ARGV[7]))

  local hardThreshold = tonumber(ARGV[9])
  local currentState = redis.call('GET', KEYS[6])
  if currentState ~= 'open' then
    local failureCount = redis.call('ZCARD', KEYS[5])
    if failureCount >= hardThreshold then
      redis.call('SET', KEYS[6], 'open')
      opened = '1'
    end
  end
end

if isProbe and feedsCircuit then
  if success then
    redis.call('SET', KEYS[6], 'closed')
    redis.call('DEL', KEYS[5])
    return {1, costUnknown, poolMissing, '1', opened}
  end
end

return {1, costUnknown, poolMissing, '0', opened}
`,
  6,
);

export interface ResolveParams {
  reservationId: string;
  budgetKey: string;
  target: string;
  success: boolean;
  actualCost?: number;
  retryable?: boolean;
  feedsCircuit: boolean;
  windowMs: number;
  /** Required even when feedsCircuit is false (cleanup): the script only reads this when it's
   * about to write a retryable failure into the window, which never happens for cleanup, but
   * the ARGV slot is always present so callers always supply the current configured value. */
  hardThreshold: number;
}

export async function resolveReservation(
  config: ResolvedConfig,
  params: ResolveParams,
): Promise<ResolveOutcome | ResolveSkipped> {
  let reply: unknown;
  try {
    reply = await runScript(
      config.redis,
      RESOLVE_RESERVATION,
      [
        keys.reservation(params.reservationId),
        keys.budget(params.budgetKey),
        keys.concurrency(params.target, params.budgetKey),
        keys.reservationsExpiring(),
        keys.circuit(params.target),
        keys.circuitState(params.target),
      ],
      [
        params.reservationId,
        params.success ? "1" : "0",
        params.actualCost !== undefined ? "1" : "0",
        params.actualCost ?? 0,
        Date.now(),
        params.retryable ? "1" : "0",
        params.windowMs,
        params.feedsCircuit ? "1" : "0",
        params.hardThreshold,
      ],
    );
  } catch (error) {
    throw new BrokerError(`resolveReservation failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  if (Array.isArray(reply)) {
    const [status, a, b, c, d] = reply as unknown[];
    if (status === 0 && (a === "unknown_reservation" || a === "already_resolved")) {
      return { resolved: false, reason: a };
    }
    if (status === 1) {
      if (c === "1") fireHook(config.hooks.onCircuitStateChange, { target: params.target, state: "closed" });
      if (d === "1") fireHook(config.hooks.onCircuitStateChange, { target: params.target, state: "open" });
      return { resolved: true, costUnknown: a === 1, poolMissing: b === 1, circuitClosed: c === "1" };
    }
  }
  throw new BrokerError(`unexpected reply from resolve-reservation script: ${JSON.stringify(reply)}`);
}