import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineScript, runScript } from "../../src/redis/script.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("runScript (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  const script = defineScript("return {KEYS[1], ARGV[1]}", 1);

  it("runs a script and passes keys and args", async () => {
    expect(await runScript(redis, script, ["k"], ["v"])).toEqual(["k", "v"]);
  });

  // Failure mode: Redis restart or failover empties the script cache. The broker must recover
  // transparently, and nothing may have run twice (NOSCRIPT means it did not run at all).
  it("recovers when the server's script cache has been flushed", async () => {
    await redis.call("SCRIPT", "FLUSH");
    expect(await redis.call("SCRIPT", "EXISTS", script.sha)).toEqual([0]);

    expect(await runScript(redis, script, ["k"], ["v"])).toEqual(["k", "v"]);
    expect(await redis.call("SCRIPT", "EXISTS", script.sha)).toEqual([1]); // cached again
  });
});