import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission } from "../../src/admission/request-permission.js";
import { parseConfig } from "../../src/config/index.js";
import type { Admitted } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
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

  async function agentWithCircuit(cb: Partial<import("../../src/config/index.js").CircuitBreakerOptions>) {
    const cfg = parseConfig({ redis, circuitBreaker: { softThreshold: 2, hardThreshold: 4, windowMs: 60_000, probeRate: 0.0001, ...cb } });
    const agent = await registerRoot(cfg, { budgetKey: `cb-${Math.random()}`, initialBudget: 100_000 }).then((r) => r.agent);
    return { cfg, agent };
  }

  it("attaches retryAfter once the failure count reaches softThreshold, without denying", async () => {
    const { cfg, agent } = await agentWithCircuit({});
    for (let i = 0; i < 2; i++) {
      const admit = (await requestPermission(cfg, { agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
      await reportOutcome(cfg, { reservationId: admit.reservationId, success: false, retryable: true });
    }
    const result = await requestPermission(cfg, { agentId: agent.agentId, target: "flaky", estimatedCost: 1 });
    expect(result.allowed).toBe(true);
    expect((result as Admitted).retryAfter).toBeGreaterThan(0);
  });

  it("opens the circuit at hardThreshold and denies subsequent calls with circuit_open", async () => {
    const { cfg, agent } = await agentWithCircuit({});
    for (let i = 0; i < 4; i++) {
      const admit = (await requestPermission(cfg, { agentId: agent.agentId, target: "down", estimatedCost: 1 })) as Admitted;
      await reportOutcome(cfg, { reservationId: admit.reservationId, success: false, retryable: true });
    }
    const result = await requestPermission(cfg, { agentId: agent.agentId, target: "down", estimatedCost: 1 });
    expect(result).toEqual({ allowed: false, reason: "circuit_open" });
    expect(await redis.get(keys.circuitState("down"))).toBe("open");
  });

  it("does not count non-retryable failures toward the circuit", async () => {
    const { cfg, agent } = await agentWithCircuit({});
    for (let i = 0; i < 10; i++) {
      const admit = (await requestPermission(cfg, { agentId: agent.agentId, target: "picky", estimatedCost: 1 })) as Admitted;
      await reportOutcome(cfg, { reservationId: admit.reservationId, success: false, retryable: false });
    }
    const result = await requestPermission(cfg, { agentId: agent.agentId, target: "picky", estimatedCost: 1 });
    expect(result.allowed).toBe(true);
    expect((result as Admitted).retryAfter).toBeUndefined();
  });

  it("admits only a probe while open (deterministic via probeRate=1), and a successful probe closes the circuit", async () => {
    const { cfg, agent } = await agentWithCircuit({ probeRate: 1 }); // force every open-state call to be a probe
    for (let i = 0; i < 4; i++) {
      const admit = (await requestPermission(cfg, { agentId: agent.agentId, target: "recovering", estimatedCost: 1 })) as Admitted;
      await reportOutcome(cfg, { reservationId: admit.reservationId, success: false, retryable: true });
    }
    expect(await redis.get(keys.circuitState("recovering"))).toBe("open");

    const probe = (await requestPermission(cfg, { agentId: agent.agentId, target: "recovering", estimatedCost: 1 })) as Admitted;
    expect(probe.allowed).toBe(true); // admitted as the probe despite the open circuit
    await reportOutcome(cfg, { reservationId: probe.reservationId, success: true });

    expect(await redis.get(keys.circuitState("recovering"))).toBe("closed");
    const after = await requestPermission(cfg, { agentId: agent.agentId, target: "recovering", estimatedCost: 1 });
    expect(after.allowed).toBe(true); // fully recovered, not just probe-admitted
  });

  it("denies non-probe calls while open even with probeRate set (probeRate=0 would violate Invariant 11, so use a near-zero rate)", async () => {
    const { cfg, agent } = await agentWithCircuit({ probeRate: 0.0001 }); // effectively never draws a probe in this test
    for (let i = 0; i < 4; i++) {
      const admit = (await requestPermission(cfg, { agentId: agent.agentId, target: "still-down", estimatedCost: 1 })) as Admitted;
      await reportOutcome(cfg, { reservationId: admit.reservationId, success: false, retryable: true });
    }
    const result = await requestPermission(cfg, { agentId: agent.agentId, target: "still-down", estimatedCost: 1 });
    expect(result).toEqual({ allowed: false, reason: "circuit_open" });
  });

  it("denies concurrency_exceeded once the limit is reached, leaving budget untouched", async () => {
    const agent = await registerRoot(parseConfig({ redis, concurrencyLimit: 2 }), {
      budgetKey: `conc-${Math.random()}`, initialBudget: 1000,
    }).then((r) => r.agent);
    const limitedConfig = parseConfig({ redis, concurrencyLimit: 2 });

    const first = await requestPermission(limitedConfig, { agentId: agent.agentId, target: "t", estimatedCost: 10 });
    const second = await requestPermission(limitedConfig, { agentId: agent.agentId, target: "t", estimatedCost: 10 });
    const third = await requestPermission(limitedConfig, { agentId: agent.agentId, target: "t", estimatedCost: 10 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third).toEqual({ allowed: false, reason: "concurrency_exceeded" });
    expect(await redis.get(keys.concurrency("t", agent.budgetKey))).toBe("2");
    // The third call's cost must not have been reserved from the budget.
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("980");
  });

  it("scopes concurrency per (target, budgetKey): a different target is unaffected by the same agent's limit", async () => {
    const agent = await registerRoot(parseConfig({ redis, concurrencyLimit: 1 }), {
      budgetKey: `scope-${Math.random()}`, initialBudget: 1000,
    }).then((r) => r.agent);
    const limitedConfig = parseConfig({ redis, concurrencyLimit: 1 });

    const first = await requestPermission(limitedConfig, { agentId: agent.agentId, target: "t1", estimatedCost: 10 });
    const second = await requestPermission(limitedConfig, { agentId: agent.agentId, target: "t2", estimatedCost: 10 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true); // different target, separate counter
  });

  // Invariant 13, under real contention.
  it("admits exactly the concurrency limit under real concurrent callers, never over", async () => {
    const agent = await registerRoot(parseConfig({ redis, concurrencyLimit: 5 }), {
      budgetKey: `race-${Math.random()}`, initialBudget: 100_000,
    }).then((r) => r.agent);
    const clients = Array.from({ length: 20 }, () => redis.duplicate());
    try {
      const results = await Promise.all(
        clients.map((c) =>
          requestPermission(parseConfig({ redis: c, concurrencyLimit: 5 }), {
            agentId: agent.agentId, target: "shared-target", estimatedCost: 1,
          }),
        ),
      );
      const admitted = results.filter((r) => r.allowed).length;
      expect(admitted).toBe(5);
      expect(await redis.get(keys.concurrency("shared-target", agent.budgetKey))).toBe("5");
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it("admits, reserves the estimated cost, and records a refundable reservation", async () => {
    const agent = await root(1000);
    const result = await requestPermission(config, { agentId: agent.agentId, target: "groq:llama", estimatedCost: 300 });

    expect(result).toEqual({ allowed: true, reservationId: expect.any(String) });
    if (!result.allowed || result.reservationId === null) throw new Error("unreachable");

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
