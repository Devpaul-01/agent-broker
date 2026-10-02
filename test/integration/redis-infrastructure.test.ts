import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestRedis } from "../helpers/redis.js";

describe("test infrastructure", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  it("reaches a real Redis", async () => {
    expect(await redis.ping()).toBe("PONG");
  });

  it("executes Lua scripts server-side", async () => {
    const result = await redis.eval("return redis.call('SET', KEYS[1], ARGV[1])", 1, "k", "v");
    expect(result).toBe("OK");
    expect(await redis.get("k")).toBe("v");
  });
});