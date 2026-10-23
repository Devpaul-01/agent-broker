/**
 * M3 — Admission script latency distribution (MEASUREMENT_PLAN.md).
 *
 * Research question: what is the actual latency of one requestPermission -> reportOutcome
 * pair (the atomic admission Lua script, end to end) on a warm, local, unloaded Redis?
 *
 * This is a SYNTHETIC BENCHMARK on localhost Redis — a best-case absolute number, not a
 * production measurement and not a comparison against any historical implementation.
 *
 * Usage:
 *   npx tsx measurement/bench/m3-admission-latency.ts [--n=1000] [--warmup=50] [--compare]
 *
 *   --compare also runs a hand-written, deliberately non-atomic 3-round-trip equivalent
 *   (separate GET budget / GET concurrency / GET circuit state, no writes) purely to quantify
 *   what bundling into one atomic script costs or saves versus 3 naive round trips. This is a
 *   CURRENT, SYNTHETIC comparison, built only for this benchmark — it does not reproduce any
 *   historical version of agent-broker and must never be reported as a historical improvement.
 */
import { Redis } from "ioredis";
import { createBroker } from "../../src/index.js";
import { keys } from "../../src/redis/keys.js";
import { TEST_REDIS_URL } from "../../test/helpers/redis.js";
import { collectRunMetadata, summarizeLatencies, saveResult } from "./metadata.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: number) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? Number(found.split("=")[1]) : fallback;
  };
  return {
    n: get("n", 1000),
    warmup: get("warmup", 50),
    compare: args.includes("--compare"),
  };
}

/** A deliberately non-atomic, 3-round-trip "naive equivalent" of the real admission check.
 * Built ONLY for this benchmark's --compare mode. Not a reconstruction of any prior
 * agent-broker implementation, and not correctness-safe under concurrency (that's the whole
 * point the real atomic script exists to avoid) — never use this path for anything but timing. */
async function naiveThreeRoundTripCheck(redis: Redis, budgetKey: string, target: string): Promise<void> {
  await redis.get(keys.budget(budgetKey));
  await redis.get(keys.concurrency(target, budgetKey));
  await redis.get(keys.circuitState(target));
}

async function timeAdmissionCalls(
  broker: ReturnType<typeof createBroker>,
  agentId: string,
  target: string,
  count: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint();
    const result = await broker.requestPermission({ agentId, target, estimatedCost: 1 });
    if (!result.allowed) {
      throw new Error(
        `benchmark invalidated: call ${i} was denied (${"reason" in result ? result.reason : "?"}) — ` +
          `budget ran out mid-benchmark, increase initialBudget`,
      );
    }
    // reportOutcome immediately so budget/concurrency return to baseline before the next call,
    // and so the timed pair matches the real request/response lifecycle an actual caller uses.
    await broker.reportOutcome({ reservationId: result.reservationId, success: true, actualCost: 1 });
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1_000_000); // ns -> ms
  }
  return samples;
}

async function main() {
  const { n, warmup, compare } = parseArgs();
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  await redis.connect();
  await redis.flushdb();

  const metadata = await collectRunMetadata(redis);
  console.log(`[M3] run ${metadata.runId} — commit ${metadata.repo.commitSha.slice(0, 12)} — Redis ${metadata.redis.version}`);
  console.log(`[M3] n=${n} warmup=${warmup} compare=${compare}`);

  const broker = createBroker({ redis });
  const totalCallsNeeded = n + warmup;
  const agent = await broker.register({ budgetKey: `m3-bench-${metadata.runId}`, initialBudget: totalCallsNeeded * 2 });

  console.log(`[M3] warming up (${warmup} discarded calls)...`);
  await timeAdmissionCalls(broker, agent.agentId, "m3-bench-target", warmup);

  console.log(`[M3] timing ${n} sequential requestPermission+reportOutcome pairs...`);
  const samples = await timeAdmissionCalls(broker, agent.agentId, "m3-bench-target", n);
  const atomicSummary = summarizeLatencies(samples);
  console.log(`[M3] atomic script: median=${atomicSummary.medianMs}ms p90=${atomicSummary.p90Ms}ms p95=${atomicSummary.p95Ms}ms p99=${atomicSummary.p99Ms}ms`);

  let naiveSummary: ReturnType<typeof summarizeLatencies> | undefined;
  if (compare) {
    console.log(`[M3] timing ${n} naive 3-round-trip reads (synthetic comparison, not atomic, not safe under concurrency)...`);
    const naiveSamples: number[] = [];
    for (let i = 0; i < warmup; i++) await naiveThreeRoundTripCheck(redis, agent.budgetKey, "m3-bench-target"); // warm up this path too
    for (let i = 0; i < n; i++) {
      const start = process.hrtime.bigint();
      await naiveThreeRoundTripCheck(redis, agent.budgetKey, "m3-bench-target");
      const end = process.hrtime.bigint();
      naiveSamples.push(Number(end - start) / 1_000_000);
    }
    naiveSummary = summarizeLatencies(naiveSamples);
    console.log(`[M3] naive 3-round-trip: median=${naiveSummary.medianMs}ms p90=${naiveSummary.p90Ms}ms p95=${naiveSummary.p95Ms}ms p99=${naiveSummary.p99Ms}ms`);
  }

  // Correctness: each call reserves estimatedCost=1 and reports actualCost=1, so the refund
  // (estimatedCost - actualCost) is 0 every time — the pool should drop by exactly 1 per call,
  // not stay flat. (Net-zero would require actualCost=0, i.e. "ended up costing nothing.")
  const finalBalance = Number(await redis.get(keys.budget(agent.budgetKey)));
  const expectedBalance = totalCallsNeeded * 2 - totalCallsNeeded; // initial pool minus 1 per call
  const correctness = {
    expectedFinalBalance: expectedBalance,
    actualFinalBalance: finalBalance,
    balanceConsistent: finalBalance === expectedBalance,
  };
  console.log(`[M3] correctness: balance ${finalBalance} (expected ${expectedBalance}) — ${correctness.balanceConsistent ? "OK" : "MISMATCH"}`);

  const result = {
    experiment: "M3-admission-latency",
    metadata,
    workload: {
      n,
      warmupIterations: warmup,
      concurrencyLevel: 1,
      target: "m3-bench-target",
      estimatedCostPerCall: 1,
      environment: "local Redis, localhost, single sequential client — best-case, not representative of production network latency",
    },
    results: {
      atomicAdmissionScript: atomicSummary,
      ...(naiveSummary ? { naiveThreeRoundTripComparison: naiveSummary } : {}),
    },
    correctness,
    limitations: [
      "Single-machine, localhost Redis: lower bound / best case, not representative of real network latency to a managed Redis instance.",
      "Sequential (concurrency=1): does not reflect latency under contention — see M7 in METRICS_AUDIT.md for a concurrency sweep, not yet implemented.",
      compare
        ? "The 3-round-trip comparison is a synthetic reference built only for this benchmark, not a reconstruction of any historical agent-broker implementation, and is not correctness-safe under concurrency (no atomicity, no writes) — it exists purely to quantify round-trip count overhead."
        : "Run with --compare to also measure a synthetic non-atomic 3-round-trip reference for context.",
    ],
  };

  if (!correctness.balanceConsistent) {
    console.error("[M3] CORRECTNESS VIOLATION — preserving result anyway per measurement plan (never suppress a failure)");
  }

  const path = await saveResult("m3-admission-latency", metadata.runId, result);
  console.log(`[M3] result saved to ${path}`);

  await redis.quit();
}

main().catch((err) => {
  console.error("[M3] FAILED:", err);
  process.exit(1);
});
