import type { Redis } from "ioredis";

/**
 * A narrow wrapper around HMGET for the exact two-field case used throughout this codebase
 * (budgetKey, target). ioredis's hmget returns (string | null)[]; under noUncheckedIndexedAccess,
 * destructuring two elements out of an array whose length isn't statically known to TypeScript
 * infers each element as string | null | undefined, not just string | null. Centralizing the
 * narrowing here means every call site gets a real { budgetKey, target } | null result instead
 * of re-deriving the same two-step guard (and risking getting it wrong) at each site.
 */
export async function hmgetBudgetKeyAndTarget(
  redis: Redis,
  key: string,
): Promise<{ budgetKey: string; target: string } | null> {
  const result = await redis.hmget(key, "budgetKey", "target");
  const budgetKey = result[0];
  const target = result[1];
  if (budgetKey === null || budgetKey === undefined || target === null || target === undefined) {
    return null;
  }
  return { budgetKey, target };
}