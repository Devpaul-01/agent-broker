import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";

export type AddBudgetDenialReason = "unknown_budget";
export interface AddBudgetResult {
  added: true;
  newBalance: number;
}
export interface AddBudgetDenial {
  added: false;
  reason: AddBudgetDenialReason;
}

/**
 * KEYS[1] budget pool   ARGV[1] amount
 *
 * addBudget requires an existing pool rather than silently creating one — mirroring register's
 * own first-creation-wins semantics (a pool is created via register({ budgetKey, initialBudget
 * }), not via an ambient top-up call), and specifically preventing a typo'd budgetKey from
 * silently spinning up a new, disconnected pool nobody intended.
 *
 * This needs to be a script, not a plain EXISTS-then-INCRBY from TypeScript: INCRBY on a
 * missing key does not error, it silently creates the key (the exact same hazard closed in
 * ADR-0003 for reportOutcome's refund path). A TOCTOU gap between a separate EXISTS check and
 * INCRBY — the pool deleted by something else in between — would reopen that same silent-
 * recreation bug at a new call site. One atomic EXISTS-then-INCRBY closes it the same way
 * ADR-0003 did.
 */
const ADD_BUDGET = defineScript(
  `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'unknown_budget'}
end
local newBalance = redis.call('INCRBY', KEYS[1], ARGV[1])
return {1, newBalance}
`,
  1,
);

export async function addBudget(
  config: ResolvedConfig,
  budgetKey: string,
  amount: number,
): Promise<AddBudgetResult | AddBudgetDenial> {
  if (typeof budgetKey !== "string" || budgetKey.length === 0) {
    throw new BrokerArgumentError("budgetKey must be a non-empty string");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BrokerArgumentError(`amount must be a positive integer, got ${String(amount)}`);
  }

  const reply = await runScript(config.redis, ADD_BUDGET, [keys.budget(budgetKey)], [amount]);

  if (Array.isArray(reply)) {
    const [status, a] = reply as unknown[];
    if (status === 0 && a === "unknown_budget") return { added: false, reason: "unknown_budget" };
    if (status === 1 && typeof a === "number") return { added: true, newBalance: a };
  }
  throw new Error(`unexpected reply from add-budget script: ${JSON.stringify(reply)}`);
}