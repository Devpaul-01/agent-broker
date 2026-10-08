import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { addBudget } from "../../src/budget/add-budget.js";
import { parseConfig } from "../../src/config/index.js";
import type { Admitted } from "../../src/admission/request-permission.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("queue mode (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => { redis = await connectTestRedis(); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("queues through concurrency_exceeded and admits once an in-flight call completes", async () => {
    const config = parseConfig({ redis, concurrencyLimit: 1 });
    const broker = createBroker({ redis, concurrencyLimit: 1 });
    const agent = await broker.register({ budgetKey: "q1", initialBudget: 1000 });
    const holding = (await broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 1 })) as Admitted;

    const queuedPromise = broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 2000 },
    );

    await new Promise((r) => setTimeout(r, 100)); // give the queued call time to poll at least once and genuinely wait
    await reportOutcome(config, { reservationId: holding.reservationId, success: true });

    const result = await queuedPromise;
    expect(result.allowed).toBe(true);
  });

  it("queues through budget_exceeded and admits once addBudget tops up the pool", async () => {
    const config = parseConfig({ redis, maxReservationTtl: 60_000 });
    const broker = createBroker({ redis, maxReservationTtl: 60_000 });
    const agent = await broker.register({ budgetKey: "q2", initialBudget: 0 });

    const queuedPromise = broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 10 },
      { mode: "queue", queueTimeout: 2000 },
    );

    await new Promise((r) => setTimeout(r, 100));
    await addBudget(config, "q2", 10);

    const result = await queuedPromise;
    expect(result.allowed).toBe(true);
  });

  it("queues through circuit_open and admits once a probe elsewhere succeeds", async () => {
    const circuitBreaker = { softThreshold: 1, hardThreshold: 2, windowMs: 60_000, probeRate: 1 };
    const config = parseConfig({ redis, circuitBreaker });
    const broker = createBroker({ redis, circuitBreaker });
    const agent = await broker.register({ budgetKey: "q3", initialBudget: 1000 });

    for (let i = 0; i < 2; i++) {
      const admit = (await broker.requestPermission({ agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
      await reportOutcome(config, { reservationId: admit.reservationId, success: false, retryable: true });
    }

    const queuedPromise = broker.requestPermission(
      { agentId: agent.agentId, target: "flaky", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 3000 },
    );

    await new Promise((r) => setTimeout(r, 100));
    // A separate, direct call acts as the recovering probe (probeRate=1 forces it deterministically).
    const probe = (await broker.requestPermission({ agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
    await reportOutcome(config, { reservationId: probe.reservationId, success: true });

    const result = await queuedPromise;
    expect(result.allowed).toBe(true);
  });

  it("times out with queue_timeout when the condition never resolves in time", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "q4", initialBudget: 0 }); // never topped up

    const result = await broker.requestPermission(
      { agentId: agent.agentId, target: "t", estimatedCost: 10 },
      { mode: "queue", queueTimeout: 300 },
    );
    expect(result).toEqual({ allowed: false, reason: "queue_timeout" });
  });

  it("denies unknown_agent immediately in queue mode, without polling", async () => {
    const broker = createBroker({ redis });
    const start = Date.now();
    const result = await broker.requestPermission(
      { agentId: "never-existed", target: "t", estimatedCost: 1 },
      { mode: "queue", queueTimeout: 5000 },
    );
    const elapsed = Date.now() - start;

    expect(result).toEqual({ allowed: false, reason: "unknown_agent" });
    expect(elapsed).toBeLessThan(200); // nowhere near queueTimeout — proves it never entered the poll loop
  });
});