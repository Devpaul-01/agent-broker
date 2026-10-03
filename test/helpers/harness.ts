import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WorkerResult, WorkerTask } from "./worker.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * A handle to one real, independent child process running worker.ts. Each call to run() sends
 * one task over IPC and waits for exactly one reply — tasks are not pipelined, since our usage
 * is "many processes each doing one thing concurrently," not "one process doing many things in
 * sequence," and keeping it one-task-per-call keeps the protocol trivial to reason about.
 */
export class WorkerHandle {
  private readonly child: ChildProcess;
  private ready: Promise<void>;

  constructor() {
    this.child = fork(WORKER_PATH, [], {
      execArgv: ["--import", "tsx"], // lets the forked process run worker.ts directly, unbuilt
      stdio: ["ignore", "inherit", "inherit", "ipc"], // surface worker console output in test logs
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("message", (msg: WorkerResult) => {
        if (msg.ok) resolve();
        else reject(new Error(`worker failed to start: ${msg.error}`));
      });
      this.child.once("error", reject);
      this.child.once("exit", (code) => {
        if (code !== 0 && code !== null) reject(new Error(`worker exited early with code ${code}`));
      });
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker did not respond within 5000ms for task ${task.task}`)), 5_000);
      this.child.once("message", (msg: WorkerResult) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      this.child.send(task);
    });
  }

  kill(): void {
    this.child.kill();
  }
}

/** Spawns `count` independent worker processes and waits for all of them to report ready. */
export async function spawnWorkers(count: number): Promise<WorkerHandle[]> {
  const workers = Array.from({ length: count }, () => new WorkerHandle());
  await Promise.all(workers.map((w) => w.waitUntilReady()));
  return workers;
}

export function killAll(workers: WorkerHandle[]): void {
  for (const w of workers) w.kill();
}