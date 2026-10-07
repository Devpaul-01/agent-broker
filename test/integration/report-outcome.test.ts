import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { requestPermission } from "../../src/admission/request-permission.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { asReserved } from "../helpers/admit.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("reportOutcome (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;

  beforeAll(async () => {
    redis = await connectTestRedis();
    config = parseConfig({ redis, concurrencyLimit: 10 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  async function admitted(budget: number, cost: number): Promise<{ budgetKey: string; reservationId: string }> {
    const agent = await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: budget }).then((r) => r.agent);
    const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "t", estimatedCost: cost }));
    return { budgetKey: agent.budgetKey, reservationId: result.reservationId };
  }

  it("success + actualCost: refunds the unused portion (estimatedCost - actualCost)", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const result = await reportOutcome(config, { reservationId, success: true, actualCost: 200 });

    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(await redis.get(keys.budget(budgetKey))).toBe("900"); // 1000 - 300 + (300-200)
    expect(await redis.hget(keys.reservation(reservationId), "resolved")).toBe("1");
  });

  it("success + actualCost greater than estimate: pushes the pool below what was reserved (allowed on reconciliation)", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    await reportOutcome(config, { reservationId, success: true, actualCost: 500 });
    expect(await redis.get(keys.budget(budgetKey))).toBe("800"); // 1000 - 300 + (300-500) = 800
  });

  it("success with no actualCost: charges the full estimate and marks costUnknown", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const result = await reportOutcome(config, { reservationId, success: true });

    expect(result).toEqual({ allowed: true, costUnknown: true, poolMissing: false });
    expect(await redis.get(keys.budget(budgetKey))).toBe("700"); // no refund
    expect(await redis.hget(keys.reservation(reservationId), "costUnknown")).toBe("1");
  });

  it("failure with no actualCost: fully refunds the reservation", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const result = await reportOutcome(config, { reservationId, success: false });

    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(await redis.get(keys.budget(budgetKey))).toBe("1000"); // back to original
  });

  it("failure with actualCost: honors the given cost rather than assuming zero", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    await reportOutcome(config, { reservationId, success: false, actualCost: 50 });
    expect(await redis.get(keys.budget(budgetKey))).toBe("950"); // 1000 - 300 + (300-50)
  });

  it("releases the concurrency slot on resolution, regardless of success", async () => {
    const agent = await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent);
    const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "shared", estimatedCost: 10 }));

    expect(await redis.get(keys.concurrency("shared", agent.budgetKey))).toBe("1");
    await reportOutcome(config, { reservationId: result.reservationId, success: false });
    expect(await redis.get(keys.concurrency("shared", agent.budgetKey))).toBe("0");
  });

  it("removes the reservation from the expiring-reservations sorted set once resolved", async () => {
    const { reservationId } = await admitted(1000, 300);
    expect(await redis.zscore(keys.reservationsExpiring(), reservationId)).not.toBeNull();
    await reportOutcome(config, { reservationId, success: true, actualCost: 100 });
    expect(await redis.zscore(keys.reservationsExpiring(), reservationId)).toBeNull();
  });

  it("denies unknown_reservation for an id that never existed", async () => {
    expect(await reportOutcome(config, { reservationId: "ghost", success: true })).toEqual({
      allowed: false, reason: "unknown_reservation",
    });
  });

  // Core idempotency guarantee: a reservation's lifecycle closes exactly once.
  it("denies already_resolved on a second report, and does not refund or release twice", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const first = await reportOutcome(config, { reservationId, success: true, actualCost: 100 });
    const second = await reportOutcome(config, { reservationId, success: true, actualCost: 100 });

    expect(first).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(second).toEqual({ allowed: false, reason: "already_resolved" });
    expect(await redis.get(keys.budget(budgetKey))).toBe("900"); // only one refund applied
  });

  // Direct proof: a late report finds the reservation's data still intact thanks to the
  // grace-period TTL design, as long as it arrives before physical deletion.
  it("can still reconcile a reservation after its logical expiry, within the grace window", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const score = await redis.zscore(keys.reservationsExpiring(), reservationId);
    expect(Number(score)).toBeLessThanOrEqual(Date.now() + config.defaultReservationTtl);

    // Simulate logical expiry having already passed without the hash being physically gone yet.
    await redis.zadd(keys.reservationsExpiring(), Date.now() - 1, reservationId);
    const result = await reportOutcome(config, { reservationId, success: true, actualCost: 150 });

    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: false });
    expect(await redis.get(keys.budget(budgetKey))).toBe("850"); // 1000 - 300 + (300-150)
  });

  // Idempotency under real concurrency, not just sequential calls.
  it("under concurrent duplicate reports for the same reservation, exactly one succeeds", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    const clients = Array.from({ length: 10 }, () => redis.duplicate());
    try {
      const results = await Promise.all(
        clients.map((c) => reportOutcome(parseConfig({ redis: c }), { reservationId, success: true, actualCost: 100 })),
      );
      const succeeded = results.filter((r) => r.allowed).length;
      expect(succeeded).toBe(1);
      expect(await redis.get(keys.budget(budgetKey))).toBe("900"); // refunded exactly once
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });

  it("resolves the reservation even when the budget pool has been deleted externally, and reports poolMissing instead of silently recreating it", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    await redis.del(keys.budget(budgetKey)); // simulate external deletion — no DEL exists in our own code path

    const result = await reportOutcome(config, { reservationId, success: true, actualCost: 100 });

    expect(result).toEqual({ allowed: true, costUnknown: false, poolMissing: true });
    // The refund must not have silently recreated the pool.
    expect(await redis.exists(keys.budget(budgetKey))).toBe(0);
    // The reservation still resolves fully: no stuck state, no held-forever concurrency slot.
    expect(await redis.hget(keys.reservation(reservationId), "resolved")).toBe("1");
  });

  it("releases the concurrency slot even when the budget pool is missing", async () => {
    const agent = await registerRoot(config, { budgetKey: `k${Math.random()}`, initialBudget: 1000 }).then((r) => r.agent);
    const result = asReserved(await requestPermission(config, { agentId: agent.agentId, target: "shared", estimatedCost: 10 }));
    await redis.del(keys.budget(agent.budgetKey));

    await reportOutcome(config, { reservationId: result.reservationId, success: false });
    expect(await redis.get(keys.concurrency("shared", agent.budgetKey))).toBe("0");
  });

  it("does not report poolMissing when refund is zero (costUnknown path), even if the pool happens to be gone", async () => {
    const { budgetKey, reservationId } = await admitted(1000, 300);
    await redis.del(keys.budget(budgetKey));

    // success with no actualCost -> refund is 0 -> EXISTS is never checked -> poolMissing stays false
    const result = await reportOutcome(config, { reservationId, success: true });
    expect(result).toEqual({ allowed: true, costUnknown: true, poolMissing: false });
  });
});
