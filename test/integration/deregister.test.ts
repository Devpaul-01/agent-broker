import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { registerChild } from "../../src/agents/register-child.js";
import { deregister } from "../../src/agents/deregister.js";
import { requestPermission, type Admitted } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("deregister (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;
  beforeAll(async () => { redis = await connectTestRedis(); config = parseConfig({ redis }); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("removes the agent record immediately", async () => {
    const { agent } = await registerRoot(config, { budgetKey: "d1", initialBudget: 10 });
    const result = await deregister(config, agent.agentId);
    expect(result).toEqual({ deregistered: true });
    expect(await redis.exists(keys.agent(agent.agentId))).toBe(0);
  });

  it("is idempotent: deregistering an already-gone agent is a successful no-op", async () => {
    const result = await deregister(config, "never-existed");
    expect(result).toEqual({ deregistered: false });
  });

  it("does not block a deregistered agent from delegating further (unknown_agent on the next attempt, same as natural expiry)", async () => {
    const { agent } = await registerRoot(config, { budgetKey: "d2", initialBudget: 10 });
    await deregister(config, agent.agentId);
    const child = await registerChild(config, { parentId: agent.agentId });
    expect(child).toEqual({ allowed: false, reason: "unknown_agent" });
  });

  // The core design decision: outstanding reservations resolve normally after deregister,
  // because they store their own budgetKey/target and never depend on the agent existing.
  it("an outstanding reservation held by a deregistered agent still resolves correctly via reportOutcome", async () => {
    const { agent } = await registerRoot(config, { budgetKey: "d3", initialBudget: 1000 });
    const admit = (await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 300 })) as Admitted;

    await deregister(config, agent.agentId);
    expect(await redis.exists(keys.agent(agent.agentId))).toBe(0);

    const result = await reportOutcome(config, { reservationId: admit.reservationId, success: true, actualCost: 100 });
    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("900"); // 1000 - 300 + (300-100)
  });

  it("rejects a non-string or empty agentId before touching Redis", async () => {
    const fake = {} as Redis;
    const fakeConfig = parseConfig({ redis: fake });
    await expect(deregister(fakeConfig, "")).rejects.toThrow("agentId");
    await expect(deregister(fakeConfig, 5 as never)).rejects.toThrow("agentId");
  });
});