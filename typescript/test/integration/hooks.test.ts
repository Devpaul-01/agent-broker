import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission, type Admitted } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("observability hooks (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => { redis = await connectTestRedis(); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("fires onDecision on both admission and denial, never affecting the returned result", async () => {
    const onDecision = vi.fn();
    const config = parseConfig({ redis, hooks: { onDecision } });
    const agent = await registerRoot(config, { budgetKey: "hooks-1", initialBudget: 5 }).then((r) => r.agent);

    const admit = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 5 });
    const deny = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 5 });

    expect(admit.allowed).toBe(true); // unaffected by the hook being present
    expect(deny).toEqual({ allowed: false, reason: "budget_exceeded" });
    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent.agentId, target: "t", result: admit }));
  });

  it("fires onOutcome on reportOutcome, including the poolMissing case", async () => {
    const onOutcome = vi.fn();
    const config = parseConfig({ redis, hooks: { onOutcome } });
    const agent = await registerRoot(config, { budgetKey: "hooks-2", initialBudget: 100 }).then((r) => r.agent);
    const admit = (await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 50 })) as Admitted;

    await redis.del(keys.budget(agent.budgetKey));
    const result = await reportOutcome(config, { reservationId: admit.reservationId, success: true, actualCost: 10 });

    expect(onOutcome).toHaveBeenCalledWith({ reservationId: admit.reservationId, result });
    expect((result as { poolMissing: boolean }).poolMissing).toBe(true);
  });

  it("fires onCircuitStateChange exactly on open and close transitions, not on every denied call while open", async () => {
    const onCircuitStateChange = vi.fn();
    const config = parseConfig({
      redis, hooks: { onCircuitStateChange },
      circuitBreaker: { softThreshold: 1, hardThreshold: 2, windowMs: 60_000, probeRate: 1 },
    });
    const agent = await registerRoot(config, { budgetKey: "hooks-3", initialBudget: 1000 }).then((r) => r.agent);

    for (let i = 0; i < 2; i++) {
      const admit = (await requestPermission(config, { agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
      await reportOutcome(config, { reservationId: admit.reservationId, success: false, retryable: true });
    }
    expect(onCircuitStateChange).toHaveBeenCalledTimes(1);
    expect(onCircuitStateChange).toHaveBeenCalledWith({ target: "flaky", state: "open" });

    // A second denied call while already open must NOT fire a duplicate "open" event.
    await requestPermission(config, { agentId: agent.agentId, target: "flaky", estimatedCost: 1 });
    expect(onCircuitStateChange).toHaveBeenCalledTimes(1);

    const probe = (await requestPermission(config, { agentId: agent.agentId, target: "flaky", estimatedCost: 1 })) as Admitted;
    await reportOutcome(config, { reservationId: probe.reservationId, success: true });
    expect(onCircuitStateChange).toHaveBeenCalledTimes(2);
    expect(onCircuitStateChange).toHaveBeenLastCalledWith({ target: "flaky", state: "closed" });
  });

  it("fires onCleanup only when a sweep actually resolves an abandoned reservation", async () => {
    const onCleanup = vi.fn();
    const config = parseConfig({ redis, hooks: { onCleanup } });
    const agent = await registerRoot(config, { budgetKey: "hooks-4", initialBudget: 100 }).then((r) => r.agent);
    const admit = (await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 10 })) as Admitted;

    // No expiry yet — a sweep-triggering call should find nothing and not fire the hook.
    const other1 = await registerRoot(config, { budgetKey: "other1", initialBudget: 1 }).then((r) => r.agent);
    await requestPermission(config, { agentId: other1.agentId, target: "x", estimatedCost: 1 });
    expect(onCleanup).not.toHaveBeenCalled();
    if (admit.reservationId === null) {
  // degraded admission: there is no reservation to schedule
  throw new Error("cannot schedule expiry for a degraded admission (reservationId is null)");
}

    await redis.zadd(keys.reservationsExpiring(), Date.now() - 1, admit.reservationId);
    const other2 = await registerRoot(config, { budgetKey: "other2", initialBudget: 1 }).then((r) => r.agent);
    await requestPermission(config, { agentId: other2.agentId, target: "x", estimatedCost: 1 });

    expect(onCleanup).toHaveBeenCalledWith({ reservationId: admit.reservationId, target: "t", budgetKey: agent.budgetKey });
  });

  it("a throwing hook does not affect the broker's own result", async () => {
    const config = parseConfig({ redis, hooks: { onDecision: () => { throw new Error("integrator bug"); } } });
    const agent = await registerRoot(config, { budgetKey: "hooks-5", initialBudget: 10 }).then((r) => r.agent);

    const result = await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: 1 });
    expect(result.allowed).toBe(true); // the broker's own operation is unaffected
  });
});