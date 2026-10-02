import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Test files share one Redis database (db 15) and each file's beforeEach FLUSHDBs it.
    // fileParallelism: false only disables in-process concurrency; vitest still spawns
    // multiple worker processes by default, and separate processes happily FLUSHDB the
    // same database out from under each other mid-run. pool: "threads" with a single
    // worker forces every file through one process, so flushes and tests never interleave.
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});