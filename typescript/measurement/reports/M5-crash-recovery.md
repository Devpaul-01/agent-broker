# M5 — Crash recovery (lazy cleanup) across real processes

> **Note (added when this workspace was committed to the repo):** written against the repo's then-current flat layout. Every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`. Re-run against current `main` when this was committed: both scenarios still pass (see `measurement/results/` and `measurement/README.md`).

**Status:** Executed successfully. 3 independent full-file runs, both scenarios passing deterministically each time.

## Objective

When a process is admitted (reservation created, budget reserved) and then genuinely crashes — the OS process itself dies — before calling `reportOutcome`, is the reservation correctly swept and the budget refunded once a *different* process's subsequent call triggers the lazy sweep? And if a late `reportOutcome` from a third process arrives after the sweep has already resolved the reservation but before its Redis hash is physically deleted, is it correctly rejected without double-refunding?

## A correction made during implementation (reported per the measurement plan's instruction to record corrections found while building, not just while auditing)

The original experiment design in `MEASUREMENT_PLAN.md` said to wait past `ttl + RESERVATION_GRACE_MS` (i.e., `ttl + 5000ms`) before triggering the sweep. Rereading `src/admission/cleanup.ts` and `src/admission/request-permission.ts` precisely while building this test showed that was imprecise: the sorted-set score used to determine sweep *eligibility* is `createdAt + ttl` alone — the grace period only delays how long the reservation's Redis hash fields survive *after* resolution (so a late report can still read `resolved: '1'` instead of finding nothing). Waiting past `ttl` alone (not `ttl + grace`) is sufficient for the next `requestPermission` call to sweep it, because `requestPermission` unconditionally calls `sweepExpiredReservations()` at the top of every invocation — this isn't probabilistic, it's guaranteed on the very next call from anyone. This correction was verified empirically: the test passes using `ttl`-only waits, confirming the corrected reading of the source was right.

## Implementation under test

`src/admission/cleanup.ts` (`sweepExpiredReservations`) and `src/admission/resolve-reservation.ts`'s idempotency guard (the `resolved` field check that produces `already_resolved`), plus `request-permission.ts`'s unconditional sweep-on-every-call behavior.

## Environment

Same as M3/M4: Redis 7.0.15 localhost, Node v22.22.2, 1 CPU core, commit `36f7674216389acae84cfa15986ac540cbaf54bd`.

## Workload

**Scenario 1 (crash + sweep):** Worker A is admitted (`estimatedCost: 300`, `ttl: 500ms`) against a pool of 1000. Worker A is then genuinely killed (`child.kill()` — a real SIGTERM to a real OS process, not a same-process "forgot to call" simulation). The test waits past the 500ms TTL, then confirms the budget is still untouched (nothing has triggered a sweep yet). A second, independent worker (Worker B) then makes an unrelated `requestPermission` call — this is the trigger. The test confirms: full refund (budget back to 999, i.e. 700 + 300 refund − 1 for Worker B's own call), concurrency counter released to 0, the reservation hash's `resolved` field set to `'1'`, and the reservation removed from the expiring sorted set.

**Scenario 2 (late-report race):** Worker A is admitted and killed, same as above. Worker B triggers the sweep. Then a *third*, independent Worker C calls `reportOutcome` for the same (already-swept) reservation, simulating a report that was delayed (slow network, GC pause) and arrives only after the sweep already resolved it on the crashed worker's behalf. The test confirms this is rejected with `already_resolved`, and the budget is unchanged by this late call (no double-refund).

Both scenarios: fresh `flushdb` before each test, 3 independent full-file runs.

## Results

| Run | Scenario 1 (crash → sweep → refund) | Scenario 2 (late report → already_resolved) |
|---|---|---|
| 1 | Pass | Pass |
| 2 | Pass | Pass |
| 3 | Pass | Pass |

**Correctness assertions (all passed, all 3 runs):**
- Scenario 1: budget balance before sweep trigger = 700 (unchanged); after the trigger call = 999 (full refund of 300, minus the trigger's own cost of 1); concurrency counter = 0; `resolved` field = `'1'`; reservation absent from the expiring sorted set.
- Scenario 2: the late report's own result has `allowed: false` with `reason: "already_resolved"`; budget balance unchanged by the late call (compared exactly against the post-sweep balance).

Zero worker-level errors in any of the 6 total test executions (3 runs × 2 scenarios).

## Baseline comparison

Not applicable in the percentage sense, consistent with M1/M2/M4 — this is a correctness invariant demonstrated at two points in time within one run (before sweep vs. after sweep), not a performance comparison between two implementations.

## Interpretation

**What this demonstrates:** the library's deliberate design choice to use lazy, call-triggered cleanup rather than a background timer (documented as ADR-0001) correctly recovers an orphaned reservation — including the specific case where the abandoning process has genuinely died, not merely "forgotten" to report within the same process — and does so without a double-refund race when a stale report arrives after the fact. This is exactly the kind of recovery-after-failure evidence the measurement plan prioritized as potentially more valuable than a plain latency number, and it validates a real, named architectural trade-off (lazy vs. timer-driven cleanup) with evidence rather than leaving it as an unverified design claim.

**What this does not demonstrate:** recovery time as a bounded SLA. Because cleanup is lazy — triggered only by someone else's *next* `requestPermission` call — recovery time in a genuinely idle system (no further calls from anyone) is unbounded in the worst case. This experiment confirms the mechanism works correctly once triggered; it does not and cannot establish a maximum recovery latency, because none exists by design. This is a real, honest limitation of the architecture, not an artifact of the test, and is worth being ready to discuss directly in an interview.

## Limitations

- Single-machine — all three "independent processes" share one host.
- Short TTL (500ms) was used specifically to keep wall-clock test time reasonable; the library's own default is 30 seconds. The mechanism being tested does not depend on the specific TTL value, so this substitution is methodologically sound, but it's worth stating plainly rather than letting a reader assume 500ms reflects a production default.
- The "lazy, not timer-driven" recovery-time caveat above is a genuine, unresolved architectural property, not something this experiment can round off — don't let the passing test imply a bounded recovery SLA exists.
- Only one specific interleaving (crash → wait past TTL → trigger → late report after sweep) was tested in scenario 2. A late report arriving *during* the sweep itself (a tighter race window) was not tested and would need a more precisely timed experiment.

## Resume suitability

**Resume-ready.** This closes the one remaining P0 correctness gap and demonstrates a deliberate architectural trade-off with real evidence:

> "Verified, via tests that genuinely kill a worker process mid-reservation, that abandoned reservations are automatically recovered — budget refunded and concurrency released — once triggered by a subsequent call from an independent process, with no double-refund if a delayed report races the recovery."

Must be labeled as an **integration-test result**. The "recovery time is unbounded in a fully idle system" caveat should be mentioned if the claim is pressed further in an interview — see `RESUME_METRIC_RECOMMENDATIONS.md`.

## Evidence trail

- Test: `measurement/bench/m5-crash-recovery.test.ts`
- Config: `measurement/vitest.config.ts`
- Reproduce: `npx vitest run --config measurement/vitest.config.ts measurement/bench/m5-crash-recovery.test.ts --testTimeout=30000` (requires local Redis reachable at `redis://localhost:6379/15`)
- No separate raw-data JSON file — pass/fail correctness test, evidence is the assertion output captured above.
