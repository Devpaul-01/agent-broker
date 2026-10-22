import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("queue mode AbortSignal cancellation (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => { redis = await connectTestRedis(); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("aborting mid-wait resolves with { allowed: false, reason: 'aborted' } well before queueTimeout", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "abort-1", initialBudget: 0 }); // never resolves on its own

    const controller = new AbortController();
    const start = Date.now();
    const resultPromise = broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 5000, signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 200);
    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result).toEqual({ allowed: false, reason: "aborted" });
    expect(elapsed).toBeLessThan(1000); // nowhere near the 5000ms queueTimeout
  });

  it("an already-aborted signal returns immediately without ever polling", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "abort-2", initialBudget: 0 });

    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 5000, signal: controller.signal },
    );
    expect(result).toEqual({ allowed: false, reason: "aborted" });
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("if admission succeeds before abort fires, the successful result wins", async () => {
    const broker = createBroker({ redis, concurrencyLimit: 100 }); // plenty of room, admits immediately
    const agent = await broker.register({ budgetKey: "abort-3", initialBudget: 1000 });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000); // fires long after admission should have succeeded

    const result = await broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 5000, signal: controller.signal },
    );
    expect(result.allowed).toBe(true);
  });
});