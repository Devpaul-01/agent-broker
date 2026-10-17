/**
 * Runs as a standalone subprocess (started by either a Node.js or a Python parent), executing
 * real `Broker` operations against real Redis on behalf of whichever side spawned it.
 *
 * This is the TypeScript counterpart to `py_worker.py`. It deliberately does NOT reuse
 * `test/helpers/worker.ts`, which speaks Node's native `child_process` IPC channel (`send`/
 * `message`) — a transport that only exists between two Node processes and that a Python parent
 * cannot drive. This file speaks the same transport `py_worker.py` does instead: JSON Lines over
 * stdin/stdout (one JSON task object per line in, one JSON result object per line out), so a
 * single harness written in either language can spawn and drive either worker uniformly. The
 * two files intentionally share field names and task-dispatch logic with `worker.ts`/`broker.ts`
 * — this file is a transport adapter around the same real `createBroker`, not a reimplementation
 * of broker logic for cross-language testing purposes.
 *
 * Protocol (byte-identical to py_worker.py's docstring):
 *
 *     stdin,  one line:  {"task": "requestPermission", "params": {...}, "config": {...}}
 *     stdout, one line:  {"ok": true, "result": {...}} | {"ok": false, "error": "..."}
 *
 * On startup, before reading any task, this process writes {"ok": true, "result": "ready"} to
 * stdout exactly once, the same readiness handshake py_worker.py performs.
 */
import { createInterface } from "node:readline";
import { Redis } from "ioredis";
import { createBroker, type Broker, type BrokerOptions } from "../../src/index.js";
import { TEST_REDIS_URL } from "../helpers/redis.js";

interface WorkerTask {
  task: "requestPermission" | "reportOutcome" | "registerChild" | "registerRoot";
  params: Record<string, unknown>;
  config?: Omit<BrokerOptions, "redis" | "hooks">;
}
type WorkerResult = { ok: true; result: unknown } | { ok: false; error: string };

function writeLine(obj: WorkerResult): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function runTask(broker: Broker, task: WorkerTask): Promise<unknown> {
  switch (task.task) {
    case "requestPermission":
      return broker.requestPermission(task.params as unknown as Parameters<typeof broker.requestPermission>[0]);
    case "reportOutcome":
      return broker.reportOutcome(task.params as unknown as Parameters<typeof broker.reportOutcome>[0]);
    case "registerChild":
      return broker.register(task.params as unknown as { parentId: string });
    case "registerRoot":
      return broker.register(task.params as unknown as { budgetKey?: string; initialBudget?: number });
    default:
      throw new Error(`unknown task: ${(task as WorkerTask).task}`);
  }
}

async function main(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  await redis.connect();

  writeLine({ ok: true, result: "ready" });

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const task = JSON.parse(trimmed) as WorkerTask;
    try {
      const broker = createBroker({ redis, ...(task.config ?? {}) });
      const result = await runTask(broker, task);
      writeLine({ ok: true, result });
    } catch (error) {
      writeLine({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

main().catch((error) => {
  writeLine({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
