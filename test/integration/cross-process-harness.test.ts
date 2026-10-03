import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { connectTestRedis } from "../helpers/redis.js";
import { killAll, spawnWorkers, type WorkerHandle } from "../helpers/harness.js";

describe("cross-process test harness (real Redis, real child processes)", () => {
  let redis: Awaited<ReturnType<typeof connectTestRedis>>;
  let workers: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = await connectTestRedis();
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterEach(() => {
    killAll(workers);
    workers = [];
  });

  it("spawns a real separate process and gets a reply over IPC", async () => {
    workers = await spawnWorkers(1);
    const result = await workers[0]!.run({ task: "registerRoot", params: { budgetKey: "harness-smoke", initialBudget: 100 } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ depth: 0, budgetKey: "harness-smoke" });
    }
  });

  // Proves "real process" rather than "same process, different async context": the worker's
  // Redis write must be visible to the parent's own, separately-connected Redis client.
  it("writes made by a worker process are visible to the parent's own Redis connection", async () => {
    workers = await spawnWorkers(1);
    const result = await workers[0]!.run({ task: "registerRoot", params: { budgetKey: "visibility-check", initialBudget: 500 } });
    expect(result.ok).toBe(true);

    const stored = await redis.get("budget:17:visibility-check"); // "visibility-check".length === 17
    expect(stored).toBe("500");
  });

  it("runs several independent worker processes concurrently", async () => {
    workers = await spawnWorkers(5);
    const results = await Promise.all(
      workers.map((w, i) => w.run({ task: "registerRoot", params: { budgetKey: `concurrent-${i}`, initialBudget: 10 * i } })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("reports a thrown library error back to the parent rather than silently succeeding", async () => {
    workers = await spawnWorkers(1);
    // Omitting both budgetKey and initialBudget is a known BrokerArgumentError case.
    const result = await workers[0]!.run({ task: "registerRoot", params: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("initialBudget");
    }
  });
});