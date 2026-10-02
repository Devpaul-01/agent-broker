import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export interface LuaScript {
  readonly source: string;
  readonly sha: string;
  readonly numberOfKeys: number;
}

export function defineScript(source: string, numberOfKeys: number): LuaScript {
  return { source, numberOfKeys, sha: createHash("sha1").update(source).digest("hex") };
}

/**
 * Runs a script with EVALSHA, falling back to EVAL if the server has not cached it.
 * Cache misses happen on Redis restart, SCRIPT FLUSH, or failover to a replica.
 * NOSCRIPT means the script did not run, so retrying with EVAL cannot double-apply anything.
 * EVAL also caches the script, so later calls take the cheap EVALSHA path again.
 * We do not use ioredis defineCommand: it would add methods to the caller's client object.
 */
export async function runScript(
  redis: Redis,
  script: LuaScript,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  if (keys.length !== script.numberOfKeys) {
    throw new Error(`script expects ${script.numberOfKeys} keys, got ${keys.length}`);
  }
  try {
    return await redis.evalsha(script.sha, script.numberOfKeys, ...keys, ...args);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
    return await redis.eval(script.source, script.numberOfKeys, ...keys, ...args);
  }
}