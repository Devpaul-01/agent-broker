/**
 * M5 — Crash recovery (lazy cleanup) correctness across real processes (MEASUREMENT_PLAN.md).
 *
 * Research question: when a process is admitted (reservation created, budget reserved) and
 * then genuinely crashes — the OS process dies — before calling reportOutcome, does the
 * reservation get swept and the budget refunded once a subsequent requestPermission call
 * triggers the lazy sweep? And does a late report racing the sweep window resolve safely
 * without double-refunding?
 *
 * Correction made while implementing (recorded per MEASUREMENT_PLAN.md's instruction to note
 * corrections found during implementation): the original plan described waiting past
 * "ttl + grace" before the next requestPermission call. Rereading the source precisely
 * (sweepExpiredReservations / request-permission.ts) shows the sorted-set score used for sweep
 * eligibility is `createdAt + ttl` — the grace period (RESERVATION_GRACE_MS, 5000ms) only keeps
 * the Redis hash's fields alive long enough for a sweep to read them; it does not delay when a
 * reservation becomes sweep-eligible. So: waiting past `ttl` (not ttl+grace) is enough to let the
 * *next* requestPermission call sweep it — this is also what requestPermission's own
 * unconditional sweepExpiredReservations() call at the top of every invocation guarantees,
 * rather than leaving it probabilistic.
 *
 * Also found while implementing: test/integration/cleanup.test.ts already thoroughly covers
 * single-process abandonment (back-dating the sorted-set score to avoid waiting out a real TTL,
 * the cleanup/reportOutcome race, batch-size limiting, and circuit-breaker non-interference).
 * This file does NOT duplicate that — it adds the one thing that coverage cannot reach: a
 * reservation abandoned by a process that genuinely dies (SIGTERM via child_process.kill()),
 * and a late report arriving from a DIFFERENT process after the sweep has already run.
 *
 * Run: npx vitest run --config measurement/vitest.config.ts measurement/bench/m5-crash-recovery.test.ts --testTimeout=60000
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../../test/helpers/redis.js";
import { killAll, spawnWorkers, type WorkerHandle } from "../../test/helpers/harness.js";
import type { Admitted } from "../../src/admission/request-permission.js";
import type { Resolved, ReportDenial } from "../../src/admission/report-outcome.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("M5: crash recovery across real processes", () => {
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

  it("a worker process that is admitted and then genuinely killed has its reservation swept and budget refunded once a subsequent call from a different process triggers the sweep", async () => {
    const SHORT_TTL = 500; // ms — keep the real wall-clock wait small for a test, not the library default (30s)
    const { agent } = await registerRoot(config, { budgetKey: "m5-crash", initialBudget: 1000 });

    workers = await spawnWorkers(2);
    const [crashingWorker, laterCaller] = workers;

    // Worker 0 is admitted (reservation created, budget reserved) with a short TTL...
    const admitReply = await crashingWorker.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "m5-target", estimatedCost: 300, ttl: SHORT_TTL },
    });
    expect(admitReply.ok).toBe(true);
    const admitted = (admitReply as { ok: true; result: unknown }).result as Admitted;
    expect(admitted.allowed).toBe(true);
    const reservationId = admitted.reservationId;
    expect(reservationId).not.toBeNull();

    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("700"); // reserved, not yet refunded

    // ...and then genuinely dies, never calling reportOutcome. This is a real SIGTERM to a
    // real OS process — not a simulated "forgot to call" in the same process.
    crashingWorker.kill();
    await sleep(50); // let the OS actually tear the process down before we assert anything about it

    // Wait past the reservation's TTL (not TTL+grace — see the correction note above) so the
    // sorted-set score makes it sweep-eligible.
    await sleep(SHORT_TTL + 100);

    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("700"); // still untouched — nothing has triggered a sweep yet

    // A DIFFERENT, still-alive process makes any requestPermission call — this triggers the
    // lazy sweep inside its own call, per request-permission.ts's unconditional call to
    // sweepExpiredReservations() at the top of every invocation.
    const triggerReply = await laterCaller.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "m5-unrelated-target", estimatedCost: 1 },
    });
    expect(triggerReply.ok).toBe(true);

    // Correctness: full refund, concurrency released, reservation marked resolved, removed
    // from the expiring set.
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe("999"); // 700 + 300 refund - 1 (the trigger call's own cost)
    expect(await redis.get(keys.concurrency("m5-target", agent.budgetKey))).toBe("0");
    expect(await redis.hget(keys.reservation(reservationId!), "resolved")).toBe("1");
    expect(await redis.zscore(keys.reservationsExpiring(), reservationId!)).toBeNull();
  }, 30_000);

  it("a late reportOutcome from a different process, arriving after the sweep already resolved the reservation but before the grace-period hash deletion, is rejected as already_resolved and does not double-refund", async () => {
    const SHORT_TTL = 500;
    const { agent } = await registerRoot(config, { budgetKey: "m5-race", initialBudget: 1000 });

    workers = await spawnWorkers(3);
    const [crashingWorker, sweepTrigger, lateReporter] = workers;

    const admitReply = await crashingWorker.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "m5-race-target", estimatedCost: 300, ttl: SHORT_TTL },
    });
    const admitted = (admitReply as { ok: true; result: unknown }).result as Admitted;
    const reservationId = admitted.reservationId!;

    crashingWorker.kill();
    await sleep(50);
    await sleep(SHORT_TTL + 100);

    // Trigger the sweep from a second process.
    await sweepTrigger.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "m5-race-unrelated", estimatedCost: 1 },
    });
    expect(await redis.hget(keys.reservation(reservationId), "resolved")).toBe("1"); // swept already

    const balanceAfterSweep = await redis.get(keys.budget(agent.budgetKey));

    // Now a THIRD, independent process — the "late reporter" — calls reportOutcome for the
    // same reservation, simulating a caller whose report was delayed (slow network, GC pause)
    // and arrives only after the sweep already resolved it on its behalf. The hash is still
    // present (grace period has not elapsed), so this must hit the resolved-flag check and be
    // rejected as already_resolved, not silently succeed and double-refund.
    const lateReply = await lateReporter.run({
      task: "reportOutcome",
      params: { reservationId, success: true, actualCost: 50 },
    });
    expect(lateReply.ok).toBe(true);
    const lateResult = (lateReply as { ok: true; result: unknown }).result as Resolved | ReportDenial;
    expect(lateResult.allowed).toBe(false);
    expect((lateResult as ReportDenial).reason).toBe("already_resolved");

    // Budget must be unchanged by the late report — no double-refund.
    expect(await redis.get(keys.budget(agent.budgetKey))).toBe(balanceAfterSweep);
  }, 30_000);
});
