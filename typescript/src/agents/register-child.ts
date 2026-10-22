import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import { keys } from "../redis/keys.js";
import { defineScript, runScript } from "../redis/script.js";

export interface RegisterChildInput {
  parentId: string;
}
export interface ChildAgent {
  agentId: string;
  depth: number;
  rootId: string;
  budgetKey: string;
}
export type RegisterDenialReason = "depth_exceeded" | "unknown_agent";
export interface RegisterDenial {
  allowed: false;
  reason: RegisterDenialReason;
}

/**
 * KEYS[1] parent agent hash    KEYS[2] new child agent hash
 * ARGV[1] parentId  ARGV[2] maxDepth  ARGV[3] agentTtl (ms)  ARGV[4] now (ms, diagnostic only)
 *
 * Existence check, depth check and child creation must be one atomic step: a parent that
 * expires between a separate read and write would otherwise be able to delegate after death.
 * Redis runs a script to completion before serving anyone else. Nothing is written on denial.
 */
const REGISTER_CHILD = defineScript(
  `
local parent = redis.call('HMGET', KEYS[1], 'depth', 'rootId', 'budgetKey')
if not parent[1] then
  return {0, 'unknown_agent'}
end
local depth = tonumber(parent[1]) + 1
if depth > tonumber(ARGV[2]) then
  return {0, 'depth_exceeded'}
end
redis.call('HSET', KEYS[2],
  'parentId', ARGV[1], 'depth', depth, 'rootId', parent[2], 'budgetKey', parent[3],
  'createdAt', ARGV[4], 'lastHeartbeat', ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return {1, depth, parent[2], parent[3]}
`,
  2,
);

function validate(input: unknown): asserts input is RegisterChildInput {
  if (input === null || typeof input !== "object") {
    throw new BrokerArgumentError("register() expects an options object");
  }
  for (const field of Object.keys(input)) {
    if (field !== "parentId") {
      throw new BrokerArgumentError(
        `child registration does not accept "${field}": identity, depth, rootId and budgetKey are derived by the broker from the parent`,
      );
    }
  }
  const { parentId } = input as { parentId?: unknown };
  if (typeof parentId !== "string" || parentId.length === 0) {
    throw new BrokerArgumentError("parentId must be a non-empty string");
  }
}

export async function registerChild(
  config: ResolvedConfig,
  input: RegisterChildInput,
): Promise<ChildAgent | RegisterDenial> {
  validate(input);
  const childId = randomUUID();

  const reply = await runScript(
    config.redis,
    REGISTER_CHILD,
    [keys.agent(input.parentId), keys.agent(childId)],
    [input.parentId, config.maxDepth, config.agentTtl, Date.now()],
  );

  if (Array.isArray(reply)) {
    const [status, a, b, c] = reply as unknown[];
    if (status === 0 && (a === "unknown_agent" || a === "depth_exceeded")) {
      return { allowed: false, reason: a };
    }
    if (status === 1 && typeof a === "number" && typeof b === "string" && typeof c === "string") {
      return { agentId: childId, depth: a, rootId: b, budgetKey: c };
    }
  }
  throw new Error(`unexpected reply from register-child script: ${JSON.stringify(reply)}`);
}