import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";
import type { Admitted } from "../../src/admission/request-permission.js";

/**
 * Exercises deregister and addBudget specifically through the object createBroker() returns —
 * not the standalone module functions those test files import directly. Found by an external
 * readiness audit as a real gap: broker.ts wires both methods onto the public Broker object,
 * but nothing had ever actually called them that way, only as src/agents/deregister.js and
 * src/budget/add-budget.js functions bypassing broker.ts's wiring entirely. A consumer only
 * ever has the createBroker() object — this is the path that matters for "does this library
 * actually work as published," distinct from "is the underlying implementation correct."
 */
describe("deregister and addBudget via the public Broker object", () => {
  let redis: Redis;
  beforeAll(async () => { redis = await connectTestRedis(); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("broker.deregister() removes the agent record immediately", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "pub-dereg-1", initialBudget: 10 });

    const result = await broker.deregister(agent.agentId);
    expect(result).toEqual({ deregistered: true });
    expect(await redis.exists(keys.agent(agent.agentId))).toBe(0);
  });

  it("broker.deregister() is idempotent through the public object", async () => {
    const broker = createBroker({ redis });
    const result = await broker.deregister("never-existed");
    expect(result).toEqual({ deregistered: false });
  });

  it("an outstanding reservation survives broker.deregister() and resolves correctly via broker.reportOutcome()", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "pub-dereg-2", initialBudget: 1000 });
    const admit = (await broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 300 })) as Admitted;

    await broker.deregister(agent.agentId);
    const result = await broker.reportOutcome({ reservationId: admit.reservationId, success: true, actualCost: 100 });

    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("900");
  });

  it("broker.addBudget() tops up an existing pool and returns the new balance", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "pub-addbudget-1", initialBudget: 500 });

    const result = await broker.addBudget("pub-addbudget-1", 200);
    expect(result).toEqual({ added: true, newBalance: 700 });

    const admit = await broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 700 });
    expect(admit.allowed).toBe(true); // confirms the top-up is genuinely usable by subsequent admission, not just a stored number
  });

  it("broker.addBudget() denies unknown_budget through the public object without creating the pool", async () => {
    const broker = createBroker({ redis });
    const result = await broker.addBudget("never-registered", 100);
    expect(result).toEqual({ added: false, reason: "unknown_budget" });
    expect(await redis.exists(keys.budget("never-registered"))).toBe(0);
  });

  it("a deregistered agent's child-delegation attempt still fails cleanly (unknown_agent), proving deregister takes effect across the whole public surface, not just requestPermission", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "pub-dereg-3", initialBudget: 10 });
    await broker.deregister(agent.agentId);

    const child = await broker.register({ parentId: agent.agentId });
    expect(child).toEqual({ allowed: false, reason: "unknown_agent" });
  });
});