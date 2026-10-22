/**
 * Runs inside a forked child process (see harness.ts). Receives a task name and params over
 * IPC, imports the built library fresh in this process's own memory space, executes the task,
 * and reports the result back over IPC. This file is the thing that makes our cross-process
 * tests actually cross-process: everything it does happens in a separate OS process with its
 * own V8 instance, not inside the parent test runner's event loop.
 */
import { createBroker } from "../../src/index.js";
import type { BrokerOptions } from "../../src/index.js";
import { TEST_REDIS_URL } from "./redis.js";
import { Redis } from "ioredis";

export interface WorkerTask {
  task: "requestPermission" | "reportOutcome" | "registerChild" | "registerRoot";
  params: Record<string, unknown>;
  /** Broker config overrides for this task (maxDepth, circuitBreaker, concurrencyLimit, etc).
   * Without this, the worker always built createBroker({ redis }) with library defaults,
   * silently ignoring whatever config.* the spawning test intended (maxDepth, circuitBreaker
   * thresholds, concurrencyLimit) — so a cross-process test asserting on a non-default config
   * was actually exercising default behavior in the worker process the whole time. Functions
   * (hooks) can't cross IPC, so this is everything in BrokerOptions except redis and hooks. */
  config?: Omit<BrokerOptions, "redis" | "hooks">;
}
export type WorkerResult = { ok: true; result: unknown } | { ok: false; error: string };

async function run(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  await redis.connect();

  process.on("message", async (msg: WorkerTask) => {
    try {
      const broker = createBroker({ redis, ...(msg.config ?? {}) });
      let result: unknown;
            switch (msg.task) {
        case "requestPermission":
          result = await broker.requestPermission(msg.params as unknown as Parameters<typeof broker.requestPermission>[0]);
          break;
        case "reportOutcome":
          result = await broker.reportOutcome(msg.params as unknown as Parameters<typeof broker.reportOutcome>[0]);
          break;
        case "registerChild":
          result = await broker.register(msg.params as { parentId: string });
          break;
        case "registerRoot":
          result = await broker.register(msg.params as { budgetKey?: string; initialBudget?: number });
          break;
        default:
          throw new Error(`unknown task: ${(msg as WorkerTask).task}`);
      }
      process.send?.({ ok: true, result } satisfies WorkerResult);
    } catch (error) {
      process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResult);
    }
  });

  // Tell the parent we're ready to receive tasks — forking and connecting to Redis both take
  // real time, and the parent must not send a task before this process can handle it.
  process.send?.({ ok: true, result: "ready" } satisfies WorkerResult);
}

run().catch((error) => {
  process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResult);
  process.exit(1);
});