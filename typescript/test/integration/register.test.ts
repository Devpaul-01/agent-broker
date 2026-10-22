import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("root registration (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;

  beforeAll(async () => {
    redis = await connectTestRedis();
    config = parseConfig({ redis });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  it("stores a broker-derived root record with a TTL, and a pool that never expires", async () => {
    const { agent, poolCreated } = await registerRoot(config, { budgetKey: "user-123", initialBudget: 5000 });

    expect(agent).toEqual({ agentId: agent.agentId, depth: 0, rootId: agent.agentId, budgetKey: "user-123" });
    expect(poolCreated).toBe(true);

    const record = await redis.hgetall(keys.agent(agent.agentId));
    expect(record).toMatchObject({ depth: "0", rootId: agent.agentId, budgetKey: "user-123" });
    expect(record).not.toHaveProperty("parentId"); // absent means root

    const agentTtl = await redis.pttl(keys.agent(agent.agentId));
    expect(agentTtl).toBeGreaterThan(0);
    expect(agentTtl).toBeLessThanOrEqual(config.agentTtl);

    expect(await redis.get(keys.budget("user-123"))).toBe("5000");
    // Budget is lifetime state; it must outlive any agent (Section 10).
    expect(await redis.pttl(keys.budget("user-123"))).toBe(-1);
  });

  // Invariant 4: private by default.
  it("defaults budgetKey to the root's own ID, giving unrelated roots separate pools", async () => {
    const a = await registerRoot(config, { initialBudget: 100 });
    const b = await registerRoot(config, { initialBudget: 200 });

    expect(a.agent.budgetKey).toBe(a.agent.agentId);
    expect(a.agent.agentId).not.toBe(b.agent.agentId);
    expect(await redis.get(keys.budget(a.agent.agentId))).toBe("100");
    expect(await redis.get(keys.budget(b.agent.agentId))).toBe("200");
  });

  it("ignores a different initialBudget on an existing pool and reports it did not create it", async () => {
    await registerRoot(config, { budgetKey: "shared", initialBudget: 1000 });
    const second = await registerRoot(config, { budgetKey: "shared", initialBudget: 9999 });

    expect(second.poolCreated).toBe(false);
    expect(await redis.get(keys.budget("shared"))).toBe("1000");
  });

  it("joins a pool without creating one when initialBudget is omitted", async () => {
    const { agent, poolCreated } = await registerRoot(config, { budgetKey: "never-funded" });

    expect(poolCreated).toBe(false);
    expect(agent.budgetKey).toBe("never-funded");
    expect(await redis.exists(keys.budget("never-funded"))).toBe(0);
  });

  // The race: many independent connections, so Redis really sees competing MULTI blocks.
  // This proves first-creation-wins semantics. It is not the cross-process proof of Section 14;
  // that harness comes later for the three required failure-mode tests.
  it("lets exactly one of 20 concurrent registrations create the shared pool", async () => {
    const clients = Array.from({ length: 20 }, () => redis.duplicate());
    try {
      const results = await Promise.all(
        clients.map((client, i) =>
          registerRoot(parseConfig({ redis: client }), { budgetKey: "contested", initialBudget: 1000 + i }),
        ),
      );
      const winners = results.flatMap((r, i) => (r.poolCreated ? [i] : []));
      const stored = Number(await redis.get(keys.budget("contested")));

      expect(winners, `pool holds ${stored}`).toHaveLength(1);
      expect(stored).toBe(1000 + (winners[0] ?? -1));
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});