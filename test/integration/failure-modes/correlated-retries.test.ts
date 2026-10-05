import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../../src/agents/register.js";
import { parseConfig } from "../../../src/config/index.js";
import { keys } from "../../../src/redis/keys.js";
import { connectTestRedis } from "../../helpers/redis.js";
import { killAll, spawnWorkers, type WorkerHandle } from "../../helpers/harness.js";
import type { WorkerResult } from "../../helpers/worker.js";
import type { Admitted, Denied } from "../../../src/admission/request-permission.js";

/** Narrows a WorkerResult to its success arm and unwraps the value. */
function unwrap<T = unknown>(r: WorkerResult): T {
  if (!r.ok) throw new Error(`worker task failed: ${r.error}`);
  return r.result as T;
}

/**
 * Section 14, required failure-mode test: correlated/amplified retries (problem A — the first
 * of the three core problems stated at the start of this project) are prevented by shared,
 * cross-process circuit-breaker state.
 *
 * Unlike the budget and depth tests, which prove a safety invariant holds under concurrency,
 * this test needs to prove something structurally different: that failures recorded by one
 * process actually govern admission decisions made by a different process that never recorded
 * any failures of its own. A test that only checked "the circuit eventually opens" would pass
 * even for a broker with a per-process, uncoordinated circuit breaker — the thing that
 * specifically proves Redis-shared state is doing the work is a process with zero local
 * history being denied because of another process's history.
 */
describe("failure mode: correlated retries prevented by shared circuit-breaker state", () => {
  let redis: Awaited<ReturnType<typeof connectTestRedis>>;
  let config: ReturnType<typeof parseConfig>;
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

  async function freshAgent(cb: { softThreshold: number; hardThreshold: number; windowMs: number; probeRate: number }) {
    config = parseConfig({ redis, circuitBreaker: cb });
    const { agent } = await registerRoot(config, { budgetKey: `cb-${Math.random()}`, initialBudget: 100_000 });
    return agent;
  }

  it("a process with zero local history is denied purely because of a different process's failure history", async () => {
    const agent = await freshAgent({ softThreshold: 2, hardThreshold: 4, windowMs: 60_000, probeRate: 0.0001 });

    workers = await spawnWorkers(2); // worker 0 drives the target to open; worker 1 has never touched it
    for (let i = 0; i < 4; i++) {
      const admit = await workers[0]!.run({
        task: "requestPermission",
        params: { agentId: agent.agentId, target: "flaky-target", estimatedCost: 1 },
      });
      const admitted = unwrap<Admitted | Denied>(admit);
      expect(admitted.allowed).toBe(true); // all 4 admitted — below the point where this process itself gets denied
      await workers[0]!.run({
        task: "reportOutcome",
        params: { reservationId: (admitted as Admitted).reservationId, success: false, retryable: true },
      });
    }
    expect(await redis.get(keys.circuitState("flaky-target"))).toBe("open");

    // Worker 1 has made ZERO calls against this target. If the circuit breaker were local to
    // each process (no real Redis coordination), worker 1's own failure count would be 0,
    // nowhere near hardThreshold, and it would sail through. It must not.
    const freshProcessAttempt = await workers[1]!.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "flaky-target", estimatedCost: 1 },
    });
    expect(unwrap<Admitted | Denied>(freshProcessAttempt)).toEqual({ allowed: false, reason: "circuit_open" });
  });

  // The amplification story, told directly: without coordination, every independent process
  // would make its own locally-rational decision to try, and all would pile onto an already-
  // struggling target. With the broker, once the circuit is open, concurrent processes are
  // overwhelmingly denied outright — none of them reach the (simulated) downstream call.
  it("many concurrent processes hitting an already-open circuit are denied outright, not amplifying load on the target", async () => {
    const agent = await freshAgent({ softThreshold: 2, hardThreshold: 3, windowMs: 60_000, probeRate: 0.0001 });

    workers = await spawnWorkers(21); // 1 to open the circuit, 20 to represent the "amplification" attempt
    for (let i = 0; i < 3; i++) {
      const admit = await workers[0]!.run({
        task: "requestPermission",
        params: { agentId: agent.agentId, target: "overloaded-target", estimatedCost: 1 },
      });
      const admitted = unwrap<Admitted | Denied>(admit);
      await workers[0]!.run({
        task: "reportOutcome",
        params: { reservationId: (admitted as Admitted).reservationId, success: false, retryable: true },
      });
    }
    expect(await redis.get(keys.circuitState("overloaded-target"))).toBe("open");

    // All 20 remaining, previously-uninvolved processes attempt simultaneously — this is the
    // retry storm. With probeRate effectively 0, essentially none should be admitted.
    const results = await Promise.all(
      workers.slice(1).map((w) =>
        w.run({ task: "requestPermission", params: { agentId: agent.agentId, target: "overloaded-target", estimatedCost: 1 } }),
      ),
    );
    const decisions = results.map((r) => unwrap<Admitted | Denied>(r));
    const admittedCount = decisions.filter((d) => d.allowed === true).length;
    const deniedCount = decisions.filter((d) => d.allowed === false).length;

    // With probeRate=0.0001 across 20 independent draws, zero probe admissions is overwhelmingly
    // likely but not mathematically guaranteed — asserting "at most 1" keeps this test honest
    // about the probabilistic nature of probe selection rather than asserting a false certainty.
    expect(admittedCount).toBeLessThanOrEqual(1);
    expect(deniedCount).toBeGreaterThanOrEqual(19);
    expect(decisions.filter((d) => d.allowed === false && d.reason === "circuit_open")).toHaveLength(deniedCount);
  });

  it("one process's successful probe recovers the circuit for every other waiting process, not just itself", async () => {
    const agent = await freshAgent({ softThreshold: 1, hardThreshold: 2, windowMs: 60_000, probeRate: 1 }); // force every open-state call to be a probe candidate

    workers = await spawnWorkers(3); // worker 0 opens it, worker 1 performs the recovering probe, worker 2 benefits without acting
    for (let i = 0; i < 2; i++) {
      const admit = await workers[0]!.run({
        task: "requestPermission",
        params: { agentId: agent.agentId, target: "recovering-target", estimatedCost: 1 },
      });
      const admitted = unwrap<Admitted | Denied>(admit);
      await workers[0]!.run({
        task: "reportOutcome",
        params: { reservationId: (admitted as Admitted).reservationId, success: false, retryable: true },
      });
    }
    expect(await redis.get(keys.circuitState("recovering-target"))).toBe("open");

    // Worker 1 is admitted as the probe (probeRate=1 forces this deterministically) and reports success.
    const probeAttempt = await workers[1]!.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "recovering-target", estimatedCost: 1 },
    });
    const probeResult = unwrap<Admitted | Denied>(probeAttempt);
    expect(probeResult.allowed).toBe(true);
    await workers[1]!.run({
      task: "reportOutcome",
      params: { reservationId: (probeResult as Admitted).reservationId, success: true },
    });
    expect(await redis.get(keys.circuitState("recovering-target"))).toBe("closed");

    // Worker 2 never made a probe attempt itself — it benefits purely from worker 1's success,
    // which is the recovery-side mirror of the first test in this file.
    const benefitsFromRecovery = await workers[2]!.run({
      task: "requestPermission",
      params: { agentId: agent.agentId, target: "recovering-target", estimatedCost: 1 },
    });
    expect(unwrap<Admitted | Denied>(benefitsFromRecovery).allowed).toBe(true);
  });
});