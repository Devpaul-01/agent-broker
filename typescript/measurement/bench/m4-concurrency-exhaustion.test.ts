/**
 * M4 — Concurrency-limit correctness under real cross-process contention (MEASUREMENT_PLAN.md).
 *
 * Research question: does `concurrencyLimit` (the in-flight-calls cap, independent of budget)
 * hold exactly when genuinely independent OS processes race for it simultaneously — the same
 * property test/integration/failure-modes/budget-contention.test.ts already proves for the
 * *budget* axis, but which no existing test exercises for the *concurrency* axis under real
 * process contention.
 *
 * Confirmed gap before writing this (MEASUREMENT_PLAN.md "note before implementing"):
 * budget-contention.test.ts's third scenario ("admits every process when the budget comfortably
 * covers all of them") sets a wide concurrencyLimit specifically so concurrency is NOT the
 * constraint — it's a budget-headroom sanity check, not a concurrency-exhaustion test. No report
 * is ever sent in that scenario, so concurrency slots are never released either. This file fills
 * that specific gap: ample budget, a tight concurrencyLimit, all callers admitted simultaneously
 * with no releases — expect exactly concurrencyLimit admissions, the remainder denied with
 * concurrency_exceeded specifically, not budget_exceeded or any other reason.
 *
 * This is kept outside test/ deliberately: it is a new experiment written for this audit, not
 * a maintained library regression test, per MEASUREMENT_PLAN.md's "keep benchmark
 * infrastructure separate from normal application behavior whenever practical."
 *
 * Run: npx vitest run measurement/bench/m4-concurrency-exhaustion.test.ts --testTimeout=120000
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../../test/helpers/redis.js";
import { killAll, spawnWorkers, type WorkerHandle } from "../../test/helpers/harness.js";
import type { Admitted, Denied } from "../../src/admission/request-permission.js";

describe("M4: concurrency-limit exhaustion across real processes", () => {
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

  it("admits exactly concurrencyLimit processes, denies the rest with concurrency_exceeded, when budget is ample and no slot is ever released", async () => {
    const concurrencyLimit = 3;
    const workerCount = 20;
    const { agent } = await registerRoot(config, {
      budgetKey: "m4-concurrency-exhaustion",
      initialBudget: workerCount * 10, // generous — budget must never be the binding constraint here
    });

    workers = await spawnWorkers(workerCount);
    const results = await Promise.all(
      workers.map((w) =>
        w.run({
          task: "requestPermission",
          params: { agentId: agent.agentId, target: "m4-shared-target", estimatedCost: 1 },
          config: { concurrencyLimit },
        }),
      ),
    );

    for (const r of results) {
      expect(r.ok, `a worker errored: ${!r.ok ? r.error : ""}`).toBe(true);
    }

    const parsed = results.map((r) => (r.ok ? (r.result as Admitted | Denied) : null));
    const admitted = parsed.filter((r) => r?.allowed === true);
    const denied = parsed.filter((r) => r?.allowed === false);
    const deniedReasons = new Set(denied.map((r) => (r as Denied).reason));

    // Correctness assertions — the actual invariant under test, not just "it completed":
    expect(admitted).toHaveLength(concurrencyLimit);
    expect(denied).toHaveLength(workerCount - concurrencyLimit);
    expect(deniedReasons.size).toBe(1);
    expect(deniedReasons.has("concurrency_exceeded")).toBe(true);

    // The Redis-side counter itself must also equal the limit — not just the call results.
    const counterValue = await redis.get(keys.concurrency("m4-shared-target", agent.budgetKey));
    expect(Number(counterValue)).toBe(concurrencyLimit);

    // Budget must be essentially untouched relative to its ample size — confirms concurrency,
    // not budget, was the binding constraint (each admitted call reserved cost 1).
    const finalBudget = Number(await redis.get(keys.budget(agent.budgetKey)));
    expect(finalBudget).toBe(workerCount * 10 - concurrencyLimit);
  }, 60_000);

  it("sanity check in the other direction: a generous concurrencyLimit admits every process (confirms the tight-limit result above isn't an artifact of the harness)", async () => {
    const concurrencyLimit = 25;
    const workerCount = 20;
    const { agent } = await registerRoot(config, {
      budgetKey: "m4-concurrency-headroom",
      initialBudget: workerCount * 10,
    });

    workers = await spawnWorkers(workerCount);
    const results = await Promise.all(
      workers.map((w) =>
        w.run({
          task: "requestPermission",
          params: { agentId: agent.agentId, target: "m4-shared-target-2", estimatedCost: 1 },
          config: { concurrencyLimit },
        }),
      ),
    );

    for (const r of results) {
      expect(r.ok, `a worker errored: ${!r.ok ? r.error : ""}`).toBe(true);
    }
    const admitted = results.filter((r) => r.ok && (r.result as Admitted | Denied).allowed === true);
    expect(admitted).toHaveLength(workerCount);
  }, 60_000);
});
