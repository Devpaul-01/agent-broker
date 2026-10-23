import { defineConfig } from "vitest/config";

// Separate from the repo's own vitest.config.ts (which intentionally scopes to test/**) so
// that measurement/bench/*.test.ts experiments can run without modifying the application's
// own test configuration. Same fileParallelism rationale as the repo's config: these files
// share one real Redis database and each flushes it in beforeEach.
export default defineConfig({
  test: {
    include: ["measurement/bench/**/*.test.ts"],
    fileParallelism: false,
  },
});
