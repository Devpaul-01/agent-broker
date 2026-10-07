import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import { keys } from "../redis/keys.js";

export interface DeregisterResult {
  /** False when the agent was already gone (expired, never existed, or already deregistered) —
   * this is a successful no-op, not an error, matching the project's general treatment of
   * "the thing you're removing is already gone" as expected rather than exceptional. */
  deregistered: boolean;
}

/**
 * Removes an agent's identity record immediately, rather than waiting out its TTL. This is a
 * pure identity-removal operation with no special-casing of outstanding reservations: every
 * reservation stores its own budgetKey and target directly on its hash (see ADR-0003 and the
 * admission-script history), specifically so reconciliation never depends on the owning agent
 * still existing. An outstanding reservation against a deregistered agent resolves exactly as
 * it would against an agent that simply expired by TTL — via reportOutcome or lazy cleanup,
 * with no awareness that deregister happened at all.
 *
 * A single DEL needs no Lua script: there is no multi-step state to coordinate atomically
 * here, unlike addBudget's INCRBY-on-a-possibly-missing-key hazard.
 */
export async function deregister(config: ResolvedConfig, agentId: string): Promise<DeregisterResult> {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new BrokerArgumentError("agentId must be a non-empty string");
  }
  const deleted = await config.redis.del(keys.agent(agentId));
  return { deregistered: deleted === 1 };
}