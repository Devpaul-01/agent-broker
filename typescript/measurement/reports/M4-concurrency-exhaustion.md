# M4 — Concurrency-limit correctness under real cross-process contention

> **Note (added when this workspace was committed to the repo):** written against the repo's then-current flat layout. Every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`. Re-run against current `main` when this was committed: both scenarios still pass (see `measurement/results/` and `measurement/README.md`).

**Status:** Executed successfully. 3 independent full-file runs, both scenarios passing deterministically each time.

## Objective

Does `concurrencyLimit` — the in-flight-call cap, which is a distinct constraint from the shared budget pool — hold exactly when genuinely independent OS processes race for it simultaneously, with no slot ever released mid-race? This is the concurrency-axis counterpart to the budget-axis invariant that `test/integration/failure-modes/budget-contention.test.ts` already proves; no existing test in the repository exercised concurrency exhaustion specifically under real cross-process contention before this experiment (confirmed by inspection before writing any code — see `METRICS_AUDIT.md`'s "note before implementing" and the header comment in the test file itself).

## Implementation under test

The concurrency block of the `REQUEST_PERMISSION` Lua script in `src/admission/request-permission.ts` (`GET` concurrency counter → compare against `concurrencyLimit` → `INCR` on admit), exercised with an ample budget so the budget check never binds — isolating the concurrency check as the only possible source of denial.

## Environment

Same as M3: Redis 7.0.15 localhost, Node v22.22.2, 1 CPU core, commit `36f7674216389acae84cfa15986ac540cbaf54bd`.

## Workload

**Primary scenario:** 20 real forked OS processes (`child_process.fork()`, via `test/helpers/harness.ts`'s `spawnWorkers`), each independently calling `requestPermission` against the same `(target, budgetKey)` pair with `concurrencyLimit: 3` and ample budget (`workerCount * 10`). No process calls `reportOutcome` — this is deliberate: it guarantees every one of the 20 attempts genuinely races for the same 3 concurrency slots simultaneously, with no slot ever freed mid-test.

**Sanity-check scenario (same file):** identical setup but `concurrencyLimit: 25` (> worker count) — confirms all 20 processes are admitted when concurrency is not the binding constraint, which rules out the primary scenario's denials being an artifact of the test harness itself rather than the concurrency limit.

Both scenarios: fresh `flushdb` before each test, run 3 times as independent full-file executions.

## Results

| Run | Primary scenario (limit=3, 20 workers) | Sanity-check scenario (limit=25, 20 workers) |
|---|---|---|
| 1 | Pass — exactly 3 admitted, 17 denied, all `concurrency_exceeded` | Pass — all 20 admitted |
| 2 | Pass — exactly 3 admitted, 17 denied, all `concurrency_exceeded` | Pass — all 20 admitted |
| 3 | Pass — exactly 3 admitted, 17 denied, all `concurrency_exceeded` | Pass — all 20 admitted |

**Correctness assertions (all passed, all 3 runs):**
- Exactly `concurrencyLimit` (3) admissions, exactly `workerCount - concurrencyLimit` (17) denials
- Every denial's reason was `concurrency_exceeded` specifically — not `budget_exceeded` or any other reason (confirmed via a `Set` of denial reasons having size 1)
- The Redis-side concurrency counter itself (not just the call results returned to each worker) equaled exactly 3 after the race
- Final budget balance equaled `workerCount * 10 - concurrencyLimit` — confirming budget was essentially untouched and concurrency, not budget, was the binding constraint
- Zero worker-level errors in any run

No invariant violation occurred in any of the 6 total test executions (3 runs × 2 scenarios).

## Baseline comparison

Not applicable in the percentage sense — this is a correctness invariant (either the limit held exactly or it didn't), not a before/after performance comparison. The sanity-check scenario serves as the methodological "control" — proving the harness itself doesn't artificially deny or admit regardless of the limit.

## Interpretation

**What this demonstrates:** the concurrency-limiting mechanism is correctly enforced under real, independent-process contention — not just within a single process's local concurrency bookkeeping, and not just when requests happen to arrive serialized. 20 genuinely separate OS processes attempted simultaneous admission against a limit of 3, and exactly 3 were admitted every time, across 3 independent runs (60 total process-races observed with zero deviation). This closes the one gap identified during the Part One audit: budget-exhaustion correctness was already proven; concurrency-exhaustion correctness was not.

**What this does not demonstrate:** behavior when slots *are* released mid-race (a worker reports its outcome while others are still waiting) — that's a different, more complex interleaving not tested here. It also does not measure how long a denied process waits before being told "no" (that's closer to M3's latency question) — this experiment is purely about whether the count is exactly right, not how fast the decision arrives.

## Limitations

- Single-machine (all "independent processes" run on the same host) — no real network partition between them.
- Does not test the "slot released mid-race" interleaving (a process reports success while others are still contending) — a related but distinct scenario from what was tested here.
- 20-process scale is below what a large production fleet might run concurrently, though the underlying mechanism (Redis server-side atomicity via the Lua script) does not depend on process count for correctness — the scale was chosen to match M1's established scale for direct comparability, not because correctness would plausibly break at a different count.

## Resume suitability

**Resume-ready.** This is a real, newly-built, correctness-verified integration-test result that closes a specific, previously-identified gap:

> "Verified, via automated tests spawning 20 real independent OS processes, that the in-flight concurrency limit is enforced exactly under simultaneous contention — confirmed deterministically across repeated runs, with zero deviation."

Must be labeled as an **integration-test result**, not a production observation.

## Evidence trail

- Test: `measurement/bench/m4-concurrency-exhaustion.test.ts`
- Config: `measurement/vitest.config.ts` (separate from the repo's own `vitest.config.ts`, which scopes discovery to `test/**` — kept the application's own config untouched per the implementation brief)
- Reproduce: `npx vitest run --config measurement/vitest.config.ts measurement/bench/m4-concurrency-exhaustion.test.ts --testTimeout=60000` (requires local Redis reachable at `redis://localhost:6379/15`)
- No separate raw-data JSON file — this is a pass/fail correctness test (like M1/M2), with the invariant checked via `expect()` assertions in the test itself; the test output (captured above) is the evidence.
