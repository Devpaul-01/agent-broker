import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission } from "../../src/admission/request-permission.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("requestPermission (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;

  beforeAll(async () => {
    redis = await connectTestRedis();
    config = parseConfig({ redis, maxReservationTtl: 60_000, agentTtl: 120_000 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  async function root(initialBudget: number) {
    return (await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget })).agent;
  }

  it("admits, reserves the estimated cost, and records a refundable reservation", async () => {
    const agent = await root(1000);
    const result = await requestPermission(config, { agentId: agent.agentId, target: "groq:llama", estimatedCost: 300 });

    expect(result).toEqual({ allowed: true, reservationId: expect.any(String) });
    if (!result.allowed) throw new Error("unreachable");

    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("700");

    const reservation = await redis.hgetall(keys.reservation(result.reservationId));
    expect(reservation).toMatchObject({
      agentId: agent.agentId, budgetKey: agent.budgetKey, target: "groq:llama", estimatedCost: "300",
    });

    // Score is the logical expiry; the hash's own TTL is that plus a grace window so a later
    // reconciliation can still read these fields after logical expiry.
    const score = await redis.zscore(keys.reservationsExpiring(), result.reservationId);
    expect(Number(score)).toBeGreaterThan(Date.now());
    const hashTtl = await redis.pttl(keys.reservation(result.reservationId));
    expect(hashTtl).toBeGreaterThan(config.defaultReservationTtl); // outlives the logical TTL
  });

  it("denies budget_exceeded before any reservation exists, and the pool is untouched", async () => {
    const agent = await root(100);
    const result = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 500 });

    expect(result).toEqual({ allowed: false, reason: "budget_exceeded" });
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("100");
    expect(await redis.keys("reservation:*")).toHaveLength(0);
  });

  it("treats an unfunded budgetKey as zero balance", async () => {
    const agent = await registerRoot(config, { budgetKey: "never-funded" }).then((r) => r.agent);
    const result = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 });
    expect(result).toEqual({ allowed: false, reason: "budget_exceeded" });
  });

  it("denies unknown_agent for an agent that never existed or has expired", async () => {
    expect(await requestPermission(config, { agentId: "ghost", target: "t", estimatedCost: 1 })).toEqual({
      allowed: false, reason: "unknown_agent",
    });

    const agent = await root(100);
    await redis.del(keys.agent(agent.agentId)); // deterministic stand-in for TTL expiry
    expect(await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 })).toEqual({
      allowed: false, reason: "unknown_agent",
    });
  });

  it("refreshes the calling agent's TTL (heartbeat-on-call)", async () => {
    const agent = await root(100);
    await redis.pexpire(keys.agent(agent.agentId), 5_000);
    await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 });
    expect(await redis.pttl(keys.agent(agent.agentId))).toBeGreaterThan(5_000);
  });

  // Invariant 5: admitted reservations can never push a pool negative at admission time.
  // Direct proof of the atomicity work in Section 11 race #1.
  it("admits exactly enough calls to exhaust a shared budget under real concurrency, never over", async () => {
    const agent = await root(1000); // room for exactly 10 calls of cost 100
    const clients = Array.from({ length: 20 }, () => redis.duplicate());
    try {
      const results = await Promise.all(
        clients.map((c) =>
          requestPermission(parseConfig({ redis: c, maxReservationTtl: 60_000 }), {
            agentId: agent.agentId, target: "t", estimatedCost: 100,
          }),
        ),
      );
      const admitted = results.filter((r) => r.allowed).length;
      const denied = results.filter((r) => !r.allowed).length;

      expect(admitted).toBe(10);
      expect(denied).toBe(10);
      expect(await redis.get(keys.budget(agent.budgetKey))).toBe("0"); // never negative
      expect(await redis.keys("reservation:*")).toHaveLength(10); // one per admission, none for denials
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});