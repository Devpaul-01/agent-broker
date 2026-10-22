import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Single source of truth for which files are test files. test:unit and test:integration
    // narrow this with --dir, which filters against this same include pattern rather than
    // using a separate glob — so there is exactly one place that defines "what counts as a
    // test file," and the two npm scripts can never drift out of sync with it.
    include: ["test/**/*.test.ts"],

    // Integration test files share one real Redis database (db 15) and each file's beforeEach
    // calls FLUSHDB. fileParallelism: false is Vitest's documented equivalent of maxWorkers: 1
    // (confirmed against the Vitest 5 docs after the poolOptions.threads.singleThread key was
    // removed in Vitest 2 and silently ignored here, which caused two earlier false CI
    // failures). This forces every test file through one worker, so flushes and tests across
    // files never interleave.
    fileParallelism: false,
  },
});