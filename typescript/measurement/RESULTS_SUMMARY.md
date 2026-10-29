# RESULTS_SUMMARY.md — agent-broker measurement, consolidated

> **Note (added when this workspace was committed to the repo):** all work below was done against the commit's then-current flat layout (`src/`, `test/` at the repo root). The repo was later restructured so the TypeScript package lives under `typescript/` (mirroring `python/`), and this `measurement/` directory now lives at `typescript/measurement/`. Every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`. All experiments were re-verified to still pass against current `main` before this commit — see the top-level `measurement/README.md` for current repro commands.

**Repository:** https://github.com/Devpaul-01/agent-broker
**Commit:** `36f7674216389acae84cfa15986ac540cbaf54bd` (unchanged throughout Part One and Part Two — `src/` and `test/` were never modified)
**Environment:** Redis 7.0.15 (localhost), Node v22.22.2, 1 CPU core, 3.9 GB RAM, Linux

## Experiments executed

| ID | Experiment | Evidence type | Status | Result |
|---|---|---|---|---|
| M1 | Budget-pool correctness under cross-process contention | Integration-test result | **Executed, 188/188 passing, 5+ runs, zero failures** | Exactly correct admission counts (10/20, 3/30, 15/15) at every run |
| M2 | Circuit-breaker state correctly shared across processes | Integration-test result | **Executed, 188/188 passing, 5+ runs, zero failures** | Zero-history denial, retry-storm suppression, cross-process recovery all confirmed |
| M3 | Atomic admission script latency distribution | Synthetic benchmark | **Executed, N=1000, 3 independent runs** | Median 0.22–0.25ms, p99 3.93–4.31ms, correctness verified each run |
| M4 | Concurrency-limit correctness under cross-process contention | Integration-test result | **Executed, new test written, 3 independent runs, zero failures** | Exactly `concurrencyLimit` admitted under 20-process contention, every run |
| M5 | Crash recovery (lazy cleanup) across real processes | Integration-test result | **Executed, new test written, 3 independent runs, zero failures** | Full refund after real process kill + sweep; no double-refund on late report race |

**Not implemented in this phase (documented, not fabricated):**
- M7 (latency under increasing concurrency / hot-key sweep) — M3 measured sequential latency only; a concurrency sweep was out of scope for this phase's priority ordering.
- M6, M8, M9 (P1) and M10–M12 (P2) — per `METRICS_AUDIT.md`'s own prioritization, these were correctly deprioritized below the P0 batch, which is now complete.

## Re-confirmation (follow-up session)

A later session restarted Redis (the sandbox does not persist background processes across session boundaries — this has happened consistently and is treated as a routine, expected environment characteristic, not a bug) and re-ran the full repository suite, the M4/M5 measurement tests, and the M3 benchmark once more as a fresh confirmation. All still pass: 27/27 files and 188/188 tests in the repo suite, 4/4 in the M4/M5 measurement tests, and a 4th independent M3 run (median 0.30ms, p99 5.22ms — same order of magnitude as the original 3 runs, correctness held). No code was changed in this follow-up session; this was purely a verification pass.

## Second re-confirmation (committing this workspace into the repo, post-restructure)

By the time this `measurement/` workspace was ported into the repository as a commit, the repo had been restructured: the TypeScript package moved from a flat `src/`/`test/` at the root into `typescript/` (mirroring `python/`'s layout), at commit `1af5b72987ef450fae8229502b41f34676299485`. Before committing anything, the full repo suite and all three new experiments were re-run against this new commit from inside `typescript/`: **27/27 files, 188/188 tests** in the repo's own suite; M4 (both scenarios) and M5 (both scenarios) passing with the same invariants as every prior run; a 5th independent M3 run (median 0.27ms, p99 5.16ms — consistent with runs 1–4). No source or test file under `typescript/src/` or `typescript/test/` was modified; the only change committed is the new `typescript/measurement/` directory, carried over with import paths unchanged (they're still two directories up from `measurement/bench/`, which now resolves to `typescript/` instead of the old repo root — structurally identical, no edits needed). See `measurement/README.md` for the note on where paths now point.

## Headline numbers (all independently reproducible — see each experiment's report for exact commands)

- **Admission latency:** median 0.22–0.30ms, p99 under 5.3ms (N=1000, 4 runs across two sessions, local Redis)
- **Budget correctness:** 0 overdraws across 65+ real forked processes racing shared pools, multiple runs
- **Concurrency correctness:** exactly 3/20 admitted under a tight limit, 20/20 admitted under a generous one, 3 independent runs
- **Circuit-breaker correctness:** state genuinely shared across processes — not locally duplicated — confirmed in 3 distinct scenarios, multiple runs
- **Crash recovery:** real process kill → correct sweep → correct refund → no double-refund on a racing late report, 3 independent runs
- **Full repository test suite:** 27/27 files, 188/188 tests passing at full designed scale

## What was found to be wrong or imprecise along the way (reported honestly, not smoothed over)

1. **My own benchmark bug (M3):** the first validation run of the M3 harness flagged a "correctness violation" — I had assumed `estimatedCost == actualCost` produces a net-zero balance change per call. It doesn't: it produces a zero *refund*, meaning the pool correctly decreases by the reserved amount every call. This was a bug in my benchmark's own bookkeeping, not in agent-broker. Caught during the mandatory "validate on a small workload" step, fixed before the real N=1000 run, and reported here rather than silently corrected.
2. **My own plan's imprecision (M5):** the original `MEASUREMENT_PLAN.md` said to wait past `ttl + grace` before triggering a sweep. Rereading the source precisely while implementing showed sweep-eligibility uses `ttl` alone; `grace` only delays physical hash deletion after resolution. Corrected before running, verified empirically that the corrected understanding was right.
3. **An initial, incorrect diagnosis (M1/M2, prior session):** large-scale cross-process scenarios initially failed under Vitest's default timeout on this single-core sandbox. I initially (wrongly) concluded this was a hard process-count ceiling. A longer timeout showed every scenario passes at full scale — it was a speed, not a capacity, limit. This correction is recorded in `MEASUREMENT_PLAN.md` from the prior session and restated in `measurement/reports/M1-M2-cross-process-correctness.md`.

## Repository impact

`git status --short` at every checkpoint in this work showed only `package-lock.json` (from `npm install` — reverted before committing, since it was benign npm-metadata churn with no dependency version change) and the new, untracked `measurement/` directory. **No file under `typescript/src/` or `typescript/test/` was modified.** All new test code lives in `measurement/bench/`, discovered via a separate `measurement/vitest.config.ts` that does not alter the repository's own `typescript/vitest.config.ts`.

## File index

Lives at `typescript/measurement/` (the TypeScript package's own subdirectory, post-restructure):

```
typescript/measurement/
├── METRICS_AUDIT.md                              (Part One)
├── MEASUREMENT_PLAN.md                            (Part One, updated Part Two)
├── RESULTS_SUMMARY.md                             (this file)
├── README.md                                       (Part Two — reproduction instructions)
├── vitest.config.ts                                (Part Two — scoped test config for measurement/bench)
├── bench/
│   ├── metadata.ts                                 (shared run-metadata + stats helper)
│   ├── m3-admission-latency.ts                      (M3 benchmark script)
│   ├── m4-concurrency-exhaustion.test.ts            (M4 new integration test)
│   └── m5-crash-recovery.test.ts                    (M5 new integration test)
├── results/
│   └── m3-admission-latency/
│       ├── 08aca357-176d-4e4d-944a-f02bb8eec23e.json
│       ├── 47e68060-4125-48b0-89b4-cfb141f64235.json
│       ├── 7a18cb84-469a-463a-900a-310cd0d33b80.json
│       ├── 04cb832a-1d46-4ce0-90b8-fabe34edd6e9.json  (follow-up session)
│       └── 488202db-e515-492f-859b-7d07b9cfcb58.json  (post-restructure re-confirmation, commit 1af5b72)
└── reports/
    ├── M1-M2-cross-process-correctness.md
    ├── M3-admission-latency.md
    ├── M4-concurrency-exhaustion.md
    └── M5-crash-recovery.md
```
