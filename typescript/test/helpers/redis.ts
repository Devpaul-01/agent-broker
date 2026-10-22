import { Redis } from "ioredis";

// Database 15 keeps test data away from anything else on this Redis.
// Tests FLUSHDB it, so never point TEST_REDIS_URL at a database you care about.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

export async function connectTestRedis(): Promise<Redis> {
  const redis = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // fail fast instead of retrying forever
  });
  try {
    await redis.connect();
  } catch (cause) {
    redis.disconnect();
    throw new Error(
      `Cannot reach test Redis at ${TEST_REDIS_URL}. Run "npm run redis:up" first. ` +
        `These tests need a real Redis and are never skipped.`,
      { cause },
    );
  }
  return redis;
}