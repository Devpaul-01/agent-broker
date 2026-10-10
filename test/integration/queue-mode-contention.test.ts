import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBroker } from "../../src/broker.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { connectTestRedis } from "../helpers/redis.js";
import type { Admitted } from "../../src/admission/request-permission.js";

/**
 * Closes a gap flagged by an external audit: every existing queue-mode test (queue-mode.test.ts)
 * queues exactly one caller. This file proves behavior under genuine multi-caller contention —
 * many simultaneous queued calls against a resource with capacity for only some of them.
 *
 * Deliberately does NOT assert ordering/fairness (e.g. first-queued-first-served): nothing in
 * queue mode's design promises FIFO — each queued call is an independent polling loop racing
 * the same admission script on its own schedule, so whichever poll happens to land when a slot
 * frees wins. Asserting strict ordering would test for a guarantee that was never made.
 */
describe("queue mode under multi-caller contention (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => { redis = await connectTestRedis(); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("10 queued callers against concurrency capacity of 3: all resolve, admitted count matches capacity as slots free up", async () => {
    const broker = createBroker({ redis, concurrencyLimit: 3 });
    const agent = await broker.register({ budgetKey: "contend-1", initialBudget: 10_000 });

    // Occupy all 3 slots up front with calls we control the resolution timing of.
    const holders = await Promise.all(
      Array.from({ length: 3 }, () => broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 1 })),
    );
    expect(holders.every((h) => h.allowed)).toBe(true);

    // 10 more callers queue simultaneously, all competing for the same 3 slots as they free up.
    const queuedPromises = Array.from({ length: 10 }, () =>
      broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 1 }, { mode: "queue", queueTimeout: 5000 }),
    );

    // Stagger-release the 3 held slots so queued callers have to actually wait and re-poll,
    // not just win on their very first attempt.
    const config = parseConfig({ redis });
    for (const holder of holders as Admitted[]) {
      await new Promise((r) => setTimeout(r, 150));
      await reportOutcome(config, { reservationId: holder.reservationId, success: true });
    }

    const results = await Promise.all(queuedPromises);
    expect(results.every((r) => r.allowed === true || r.allowed === false)).toBe(true); // no exceptions, no hangs
    const admitted = results.filter((r) => r.allowed === true);
    // Exactly the 3 freed slots should have been claimed by the queued callers (the 3 holders'
    // own slots are the only ones that opened up during this test's window).
    expect(admitted).toHaveLength(3);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "queue_timeout" || r.reason === "concurrency_exceeded")).toBe(true);
  });

  it("many queued callers against a permanently exhausted budget: all terminate via queue_timeout, none hang past queueTimeout", async () => {
    const broker = createBroker({ redis });
    const agent = await broker.register({ budgetKey: "contend-2", initialBudget: 0 }); // never funded

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        broker.requestPermission({ agentId: agent.agentId, target: "t", estimatedCost: 1 }, { mode: "queue", queueTimeout: 400 }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(results.every((r) => r.allowed === false && r.reason === "queue_timeout")).toBe(true);
    // All 15 independent poll loops should terminate close to queueTimeout, not drift wildly
    // past it — proves the backoff cap keeps polling bounded even under this much contention.
    expect(elapsed).toBeLessThan(1500);
  });

  it("circuit-open contention: many queued callers admitted together once a single probe recovers the circuit", async () => {
    const circuitBreaker = { softThreshold: 1, hardThreshold: 2, windowMs: 60_000, probeRate: 1 };
    const broker = createBroker({ redis, circuitBreaker });
    const config = parseConfig({ redis, circuitBreaker });
    const agent = await broker.register({ budgetKey: "contend-3", initialBudget: 10_000 });

    for (let i = 0; i < 2; i++) {
      const admit = (await broker.requestPermission({ agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
      await reportOutcome(config, { reservationId: admit.reservationId, success: false, retryable: true });
    }

    const queuedPromises = Array.from({ length: 8 }, () =>
      broker.requestPermission({ agentId: agent.agentId, target: "flaky", estimatedCost: 1 }, { mode: "queue", queueTimeout: 3000 }),
    );

    await new Promise((r) => setTimeout(r, 150));
    const probe = (await broker.requestPermission({ agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
    await reportOutcome(config, { reservationId: probe.reservationId, success: true }); // closes the circuit for everyone

    const results = await Promise.all(queuedPromises);
    // Once closed, every queued caller's next poll should succeed — none should still be
    // circuit_open-denied, and none should have needed to burn their full queueTimeout.
    expect(results.every((r) => r.allowed === true)).toBe(true);
  });
});