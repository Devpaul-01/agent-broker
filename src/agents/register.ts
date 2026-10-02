import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import { keys } from "../redis/keys.js";

export interface RegisterRootInput {
  budgetKey?: string;
  initialBudget?: number;
}

export interface RootAgent {
  agentId: string;
  depth: 0;
  rootId: string;
  budgetKey: string;
}

// Identity, depth and root are never caller input (Invariants 1 and 2). Rejecting unknown
// keys makes an attempt to supply them loud instead of silently ignored.
const ALLOWED_FIELDS = new Set(["budgetKey", "initialBudget"]);

function validate(input: RegisterRootInput): void {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("register() expects an options object");
  }
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new BrokerArgumentError(`register() does not accept "${field}"`);
    }
  }
  const { budgetKey, initialBudget } = input;
  if (budgetKey !== undefined && (typeof budgetKey !== "string" || budgetKey.length === 0)) {
    throw new BrokerArgumentError("budgetKey must be a non-empty string");
  }
  if (initialBudget !== undefined && (!Number.isSafeInteger(initialBudget) || initialBudget < 0)) {
    throw new BrokerArgumentError(`initialBudget must be a non-negative integer, got ${String(initialBudget)}`);
  }
  if (budgetKey === undefined && initialBudget === undefined) {
    throw new BrokerArgumentError(
      "initialBudget is required when budgetKey is omitted: a private pool with no budget could never admit a call",
    );
  }
}

/**
 * Registers a root agent.
 *
 * Redis: one MULTI/EXEC block holds three commands that run without interleaving from other
 * connections: HSET agent record, PEXPIRE it, and SET budget NX (first creation wins).
 * MULTI is not rollback: if a command errors the others still ran, so we surface the error.
 * A connection drop before the reply leaves us not knowing whether it applied. The outcomes
 * are an orphan agent nobody holds an ID for (expires by TTL) and/or a created pool, and both
 * are harmless, which is why no stronger mechanism is needed here.
 */
export async function registerRoot(
  config: ResolvedConfig,
  input: RegisterRootInput,
): Promise<{ agent: RootAgent; poolCreated: boolean }> {
  validate(input);

  const agentId = randomUUID();
  const budgetKey = input.budgetKey ?? agentId;
  const now = Date.now();

  const tx = config.redis.multi();
  tx.hset(keys.agent(agentId), { depth: 0, rootId: agentId, budgetKey, createdAt: now, lastHeartbeat: now });
  tx.pexpire(keys.agent(agentId), config.agentTtl);
  if (input.initialBudget !== undefined) {
    tx.set(keys.budget(budgetKey), input.initialBudget, "NX");
  }

  const results = await tx.exec();
  if (results === null) throw new Error("registration transaction was aborted");
  for (const [error] of results) if (error) throw error;

  const poolCreated = input.initialBudget !== undefined && results[2]?.[1] === "OK";
  return { agent: { agentId, depth: 0, rootId: agentId, budgetKey }, poolCreated };
}