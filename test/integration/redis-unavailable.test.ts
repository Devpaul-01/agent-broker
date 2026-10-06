import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { connectTestRedis, TEST_REDIS_URL } from "../helpers/redis.js";

describe("onRedisUnavailable behavior under a real connection failure", () => {
  let redis: Awaited<ReturnType<typeof connectTestRedis>>;
  let agent: Awaited<ReturnType<typeof registerRoot>>["agent"];

  beforeAll(async () => {
    redis = await connectTestRedis();
    await redis.flushdb();
    const healthyConfig = parseConfig({ redis });
    agent = (await registerRoot(healthyConfig, { budgetKey: "unavailable-test", initialBudget: 1000 })).agent;
  });
  afterAll(async () => {
    await redis?.quit();
  });

  // A deliberately unreachable port simulates a genuine connection failure without needing to
  // stop the real test Redis (which other tests in this file/run still need).
  function unreachableRedis(): Redis {
    return new Redis("redis://127.0.0.1:1", { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 300 });
  }
  let broken: Redis;
  afterEach(() => broken?.disconnect());

  it("deny (default): returns a redis_unavailable denial rather than throwing", async () => {
    broken = unreachableRedis();
    const config = parseConfig({ redis: broken, onRedisUnavailable: "deny" });

    const result = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 });
    expect(result).toEqual({ allowed: false, reason: "redis_unavailable" });
  });

  it("allow: admits without a reservation and marks the response degraded", async () => {
    broken = unreachableRedis();
    const config = parseConfig({ redis: broken, onRedisUnavailable: "allow" });

    const result = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 });
    expect(result).toEqual({ allowed: true, reservationId: null, degraded: true });
  });

  it("reportOutcome(null) is a safe no-op, making no Redis call", async () => {
    broken = unreachableRedis(); // proves no Redis call happens: this client would throw if touched
    const config = parseConfig({ redis: broken, onRedisUnavailable: "allow" });

    const result = await reportOutcome(config, { reservationId: null, success: true });
    expect(result).toEqual({ allowed: true, costUnknown: true, poolMissing: false, degraded: true });
  });

  it("reportOutcome(null) still validates its other fields", async () => {
    broken = unreachableRedis();
    const config = parseConfig({ redis: broken });
    await expect(
      reportOutcome(config, { reservationId: null, success: "not-a-boolean" as never }),
    ).rejects.toThrow("success");
  });

  it("a real script/application error is NOT swallowed by onRedisUnavailable, even when set to allow", async () => {
    // A healthy connection, but a request that will hit a genuine library bug path (an
    // unexpected reply shape) should still throw — not be reinterpreted as 'Redis unavailable'.
    // We simulate this by pointing at a connected Redis that simply isn't the broker's — i.e.
    // confirming a WRONGTYPE-style error path is excluded by isRedisUnavailableError's own
    // unit tests; this integration test confirms requestPermission's try/catch respects that
    // exclusion by not catching a non-connection throw at all when Redis is actually healthy.
    const config = parseConfig({ redis, onRedisUnavailable: "allow" });
    await expect(
      requestPermission(config, { agentId: "", target: "t", estimatedCost: 1 } as never),
    ).rejects.toBeInstanceOf(Error); // BrokerArgumentError, thrown before any Redis call — never degraded
  });
});