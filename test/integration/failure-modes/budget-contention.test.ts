import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../../src/agents/register.js";
import { parseConfig } from "../../../src/config/index.js";
import { keys } from "../../../src/redis/keys.js";
import { connectTestRedis } from "../../helpers/redis.js";
import { killAll, spawnWorkers, type WorkerHandle } from "../../helpers/harness.js";
import type { Admitted, Denied } from "../../../src/admission/request-permission.js";

/**
 * Section 14, required failure-mode test: budget contention.
 *
 * Proves Invariant 5 (a shared budget pool can never be overdrawn by concurrent admission)
 * holds across genuinely independent OS processes — not the single-process
 * Promise.all-with-duplicated-connections version already covered in the admission-budget
 * slice, which proves the Lua script's atomicity but not that separate processes actually
 * reach the same Redis state correctly. Each worker here is a real child_process.fork(), with
 * its own event loop, its own V8 instance, and its own Redis connection, all racing for the
 * same budget pool through the one thing they actually share: Redis.
 */
describe("failure mode: budget contention across real processes", () => {
  let redis: Awaited<ReturnType<typeof connectTestRedis>>;
  let config: ReturnType<typeof parseConfig>;
  let workers: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = await connectTestRedis();
    config = parseConfig({ redis });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterEach(() => {
    killAll(workers);
    workers = [];
  });

  it("admits exactly enough calls to exhaust a shared budget, never more, across 10 independent processes", async () => {
    // Room for exactly 10 calls of cost 100 — sized so the test fails loudly (admitted != 10)
    // rather than ambiguously if the atomicity guarantee breaks under real process contention.
    const { agent } = await registerRoot(config, { budgetKey: "cross-process-budget", initialBudget: 1000 });

    workers = await spawnWorkers(20); // 20 processes competing for budget for only 10 calls
    const results = await Promise.all(
      workers.map((w) => w.run({ task: "requestPermission", params: { agentId: agent.agentId, target: "shared-target", estimatedCost: 100 } })),
    );

    const admitted = results.filter((r) => r.ok && (r.result as Admitted | Denied).allowed === true);
    const denied = results.filter((r) => r.ok && (r.result as Admitted | Denied).allowed === false);
    const errored = results.filter((r) => !r.ok);

    // Fail loudly on any worker-level error first — a crashed worker reporting as "denied"
    // would be a false pass, exactly the harness failure mode called out in the previous slice.
    expect(errored, JSON.stringify(errored)).toHaveLength(0);
    expect(admitted).toHaveLength(10);
    expect(denied).toHaveLength(10);

    // The actual invariant: the pool must land at exactly zero, never negative, regardless of
    // how many of the 20 processes raced for it at the same instant.
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("0");

    // One reservation per real admission, none for denials — confirms the atomicity held at
    // the reservation-creation step too, not just the final counter value.
    const reservationKeys = await redis.keys("reservation:*");
    expect(reservationKeys).toHaveLength(10);
  });

  it("scales to a tighter race: 30 processes contending for budget sized for exactly 3 admissions", async () => {
    const { agent } = await registerRoot(config, { budgetKey: "tight-budget", initialBudget: 30 });

    workers = await spawnWorkers(30);
    const results = await Promise.all(
      workers.map((w) => w.run({ task: "requestPermission", params: { agentId: agent.agentId, target: "t", estimatedCost: 10 } })),
    );

    expect(results.filter((r) => !r.ok)).toHaveLength(0);
    const admitted = results.filter((r) => r.ok && (r.result as Admitted | Denied).allowed === true);
    expect(admitted).toHaveLength(3);
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("0");
  });

  // A sanity check in the other direction: plenty of budget, no contention expected, nothing
  // should ever be denied. Guards against an overly aggressive or miscounting admission check.
  it("admits every process when the budget comfortably covers all of them", async () => {
    const { agent } = await registerRoot(config, { budgetKey: "generous-budget", initialBudget: 100_000 });

    workers = await spawnWorkers(15);
    const results = await Promise.all(
      workers.map((w) => w.run({ task: "requestPermission", params: { agentId: agent.agentId, target: "t", estimatedCost: 10 } })),
    );

    expect(results.filter((r) => !r.ok)).toHaveLength(0);
    expect(results.every((r) => r.ok && (r.result as Admitted | Denied).allowed === true)).toBe(true);
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe(String(100_000 - 150));
  });
});