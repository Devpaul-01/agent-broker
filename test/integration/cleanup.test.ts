import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { asReserved } from "../helpers/admit.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("lazy cleanup of abandoned reservations (real Redis)", () => {
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

  async function abandon(budget: number, cost: number) {
    const agent = await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: budget }).then((r) => r.agent);
    const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: cost }));
    // Force logical expiry without waiting out the real TTL: back-date the sorted-set score.
    await redis.zadd(keys.reservationsExpiring(), Date.now() - 1, result.reservationId);
    return { agent, reservationId: result.reservationId };
  }

  it("refunds and releases a genuinely abandoned reservation on the next admission call", async () => {
    const { agent, reservationId } = await abandon(1000, 300);
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("700");
    expect(await redis.get(keys.concurrency("t", agent.budgetKey))).toBe("1");

    // Any requestPermission call triggers the sweep, including an unrelated one.
    const other = await registerRoot(config, { budgetKey: `other-${Math.random()}`, initialBudget: 10 }).then((r) => r.agent);
    await requestPermission(config, { agentId: other.agentId, target: "unrelated", estimatedCost: 1 });

    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("1000"); // fully refunded
    expect(await redis.get(keys.concurrency("t", agent.budgetKey))).toBe("0"); // released
    expect(await redis.hget(keys.reservation(reservationId), "resolved")).toBe("1");
    expect(await redis.zscore(keys.reservationsExpiring(), reservationId)).toBeNull();
  });

  it("leaves a reservation that has not logically expired yet untouched", async () => {
    const agent = await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent);
    const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 300 }));

    const other = await registerRoot(config, { budgetKey: `other-${Math.random()}`, initialBudget: 10 }).then((r) => r.agent);
    await requestPermission(config, { agentId: other.agentId, target: "unrelated", estimatedCost: 1 });

    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("700"); // still reserved, untouched
    expect(await redis.hget(keys.reservation(result.reservationId), "resolved")).toBeNull();
  });

  it("does not let an abandoned reservation count toward the circuit breaker", async () => {
    const cfg = parseConfig({ redis, circuitBreaker: { softThreshold: 2, hardThreshold: 3, windowMs: 60_000, probeRate: 0.0001 } });
    for (let i = 0; i < 5; i++) {
      const agent = await registerRoot(cfg, { budgetKey: `k${i}-${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent);
      const result = asReserved(await requestPermission(cfg, { agentId: agent.agentId, target: "shared-target", estimatedCost: 1 }));
      await redis.zadd(keys.reservationsExpiring(), Date.now() - 1, result.reservationId);
    }
    // Trigger sweeps against all 5 abandoned reservations.
    const trigger = await registerRoot(cfg, { budgetKey: `trigger-${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent);
    for (let i = 0; i < 2; i++) {
      await requestPermission(cfg, { agentId: trigger.agentId, target: "shared-target", estimatedCost: 1 });
    }
    expect(await redis.get(keys.circuitState("shared-target"))).toBeNull(); // never opened
    expect(await redis.zcard(keys.circuit("shared-target"))).toBe(0); // window never touched by cleanup
  });

  // The core idempotency guarantee, now across two different call sites rather than one.
  it("under a race between cleanup and a concurrent reportOutcome, exactly one resolution wins", async () => {
    const { agent, reservationId } = await abandon(1000, 300);
    const clients = Array.from({ length: 5 }, () => redis.duplicate());
    try {
      const results = await Promise.all([
        ...clients.map((c) => reportOutcome(parseConfig({ redis: c }), { reservationId, success: true, actualCost: 100 })),
        registerRoot(config, { budgetKey: `t-${Math.random()}`, initialBudget: 1 })
          .then((r) => r.agent)
          .then((a) => requestPermission(config, { agentId: a.agentId, target: "t", estimatedCost: 1 })),
      ]);
      const succeeded = results.filter((r) => "allowed" in r && r.allowed === true).length;
      // Either reportOutcome's explicit report or cleanup's full-refund resolves it — never both.
      const budget = Number(await redis.get(keys.budget(agent.budgetKey)));
      expect(budget === 1000 || budget === 900).toBe(true); // full refund (cleanup won) or partial (report won)
      expect(succeeded).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it("sweeps at most CLEANUP_BATCH_SIZE candidates per call, leaving the rest for a later call", async () => {
    const agents = await Promise.all(
      Array.from({ length: 8 }, () => registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent)),
    );
    const reservations: string[] = [];
    for (const agent of agents) {
      const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 10 }));
      await redis.zadd(keys.reservationsExpiring(), Date.now() - 1, result.reservationId);
      reservations.push(result.reservationId);
    }
    const trigger = await registerRoot(config, { budgetKey: `trigger-${Math.random()}`, initialBudget: 10 }).then((r) => r.agent);
    await requestPermission(config, { agentId: trigger.agentId, target: "t", estimatedCost: 1 });

    const resolvedCount = (
      await Promise.all(reservations.map((id) => redis.hget(keys.reservation(id), "resolved")))
    ).filter((v) => v === "1").length;
    expect(resolvedCount).toBe(5); // batch size, not all 8 at once
  });
});
