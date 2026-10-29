# agent-broker measurement workspace

Audit, experiment design, and executed results for agent-broker's engineering properties. Start with `RESULTS_SUMMARY.md` for the consolidated picture.

## Documents

- `METRICS_AUDIT.md` — source-grounded inventory of every measurement opportunity found in the repo, prioritized P0–P2, plus rejected categories and why.
- `MEASUREMENT_PLAN.md` — experiment designs for the P0 batch (M1–M5), plus execution history and corrections found while implementing.
- `RESULTS_SUMMARY.md` — consolidated results across all five P0 experiments.
- `reports/` — one detailed report per experiment (objective, environment, workload, results, interpretation, limitations, how to cite it).

## Requirements

All commands below assume your working directory is `typescript/` (the repo was restructured into `typescript/` + `python/` after these experiments were first written; this `measurement/` directory now lives at `typescript/measurement/` and every command is run from there, same as the repo's own `npm test`).

- Node.js (tested with v22.22.2) and the repository's own dependencies (`npm install` from `typescript/`)
- A local Redis instance reachable at `redis://localhost:6379`, database index 15 (the project's own `test/helpers/redis.ts` convention — isolates test data from db 0)

Start Redis (pick one):
```bash
# Preferred, matches the project's own docker-compose.yml:
docker compose up -d --wait

# Or, if Docker is unavailable, any local Redis 7 binary:
redis-server --daemonize yes --port 6379
```

Verify: `redis-cli ping` should return `PONG`.

## Reproducing each experiment

### M1 & M2 — cross-process correctness (pre-existing repo tests)
```bash
npx vitest run test/integration/failure-modes --testTimeout=120000
```
Expect: all scenarios pass. Takes ~45–60s on a single-core machine (faster on multi-core); the `--testTimeout=120000` override is necessary on slow/constrained hardware — see `MEASUREMENT_PLAN.md` for why.

### M3 — admission latency benchmark
```bash
npx tsx measurement/bench/m3-admission-latency.ts --n=1000 --warmup=50 --compare
```
Flags: `--n` (timed samples, default 1000), `--warmup` (discarded samples first, default 50), `--compare` (also run the synthetic non-atomic 3-round-trip reference). Output is printed to stdout and saved as JSON under `measurement/results/m3-admission-latency/<runId>.json` — each run gets its own file, never overwritten.

### M4 — concurrency-exhaustion correctness (new test)
```bash
npx vitest run --config measurement/vitest.config.ts measurement/bench/m4-concurrency-exhaustion.test.ts --testTimeout=60000
```

### M5 — crash-recovery correctness (new test)
```bash
npx vitest run --config measurement/vitest.config.ts measurement/bench/m5-crash-recovery.test.ts --testTimeout=30000
```

### Everything in measurement/bench/ at once
```bash
npx vitest run --config measurement/vitest.config.ts --testTimeout=60000
```

### The full repository test suite (for context / regression check)
```bash
npx vitest run test/unit test/integration --testTimeout=120000
```
Expect: 27/27 files, 188/188 tests passing.

## Why a separate `measurement/vitest.config.ts`

The repository's own `vitest.config.ts` (at `typescript/vitest.config.ts`) intentionally scopes test discovery to `test/**`. Rather than modify that file (the implementation brief asked to avoid changing application configuration unless minimal and clearly justified), `measurement/vitest.config.ts` is a second, independent config scoped to `measurement/bench/**/*.test.ts`. The repository's own config and test suite are untouched — confirmed via `git status --short` showing only the new `measurement/` directory as a change under `typescript/` throughout this work.

## Notes on this environment

All results in this workspace were produced on a sandboxed, single-CPU-core machine. Absolute latency numbers (M3) are a best case for that hardware and should be treated as a lower bound, not a production estimate. Correctness results (M1, M2, M4, M5) do not depend on CPU count for their validity — Redis-side Lua script atomicity is what the correctness invariants rest on — but cross-process test *wall-clock time* is slower here than on typical multi-core CI hardware, which is why several commands above use an extended `--testTimeout`.
