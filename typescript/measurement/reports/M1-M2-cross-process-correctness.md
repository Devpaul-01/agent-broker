# M1 & M2 — Budget-contention and circuit-breaker correctness across real processes

> **Note (added when this workspace was committed to the repo):** written against the repo's then-current flat layout. Every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`.

**Status:** Executed successfully in the prior audit session and reconfirmed in this session (one additional full-suite run, see below). These use the repository's own existing test files — `test/integration/failure-modes/budget-contention.test.ts` (M1) and `test/integration/failure-modes/correlated-retries.test.ts` (M2) — not new measurement-workspace code, since `METRICS_AUDIT.md` identified they already existed and only needed to be run and reported, not built.

## Objective

**M1:** Does a shared budget pool stay exactly correct (never overdrawn, never under-admitting) when genuinely independent OS processes race for it concurrently?

**M2:** Does circuit-breaker state genuinely propagate across independent processes — such that a process with zero local failure history is denied because of *another* process's failures, and a single process's recovery probe reopens the circuit for a third process that never acted — rather than each process keeping its own uncoordinated local breaker?

## Implementation under test

M1: the budget block of `REQUEST_PERMISSION` (`src/admission/request-permission.ts`). M2: the circuit-breaker blocks of `REQUEST_PERMISSION` and the failure-window/probe-recovery logic in `RESOLVE_RESERVATION` (`src/admission/resolve-reservation.ts`).

## Environment

Redis 7.0.15 localhost, Node v22.22.2, 1 CPU core, commit `36f7674216389acae84cfa15986ac540cbaf54bd`.

## Workload

**M1** (`budget-contention.test.ts`, 3 scenarios): 20 real forked processes racing a budget sized for exactly 10 admissions; 30 processes racing a budget sized for exactly 3; 15 processes with a comfortable budget (sanity check).

**M2** (`correlated-retries.test.ts`, 3 scenarios): 2 processes (one drives the circuit open via failures, a second with zero local history attempts once); 20 uninvolved processes hitting an already-open circuit simultaneously (retry-storm, `probeRate: 0.0001`); 3 processes (one opens the circuit, one is forced through as a probe and recovers it, a third — never involved — benefits from that recovery).

## Results

Across this session and the prior session, the full `test/integration/failure-modes/` directory plus `test/integration/cross-process-harness.test.ts` and `test/integration/failure-modes/depth-spoofing.test.ts` have been run **at least 5 times combined**, always at full originally-designed scale, with **zero failures**:

| Scenario | Scale | Outcome (every run) |
|---|---|---|
| M1: tight budget race | 20 processes, budget for 10 | Exactly 10 admitted, every run |
| M1: tighter budget race | 30 processes, budget for 3 | Exactly 3 admitted, every run |
| M1: comfortable budget | 15 processes | All correctly admitted, every run |
| M2: zero-history denial | 2 processes | Zero-history process denied with `circuit_open`, every run |
| M2: retry storm | 20 processes vs. open circuit | ≤1 admitted (observed: 0 every run so far), rest denied outright |
| M2: probe recovery | 3 processes | Uninvolved third process succeeds purely from another's recovery, every run |

This session's incremental confirmation run (`npx vitest run test/unit test/integration --testTimeout=120000`): **27/27 files, 188/188 tests pass**, including all 6 scenarios above.

One in-session finding from the prior audit, restated here for the evidence trail: an initial attempt at these scenarios under Vitest's *default* per-test timeout failed with `ERR_IPC_CHANNEL_CLOSED` on this sandbox's single CPU core. That was a timeout artifact, not a correctness problem — re-running with `--testTimeout=120000` passed cleanly every time since. This correction is recorded in `MEASUREMENT_PLAN.md` as well.

## Baseline comparison

Not applicable — both are correctness invariants, not performance comparisons.

## Interpretation

**What this demonstrates:** the two hardest problems a naive multi-process coordination system typically gets wrong — budget races (TOCTOU) and correlated retries from uncoordinated local circuit breakers — are both correctly handled here, demonstrated with real OS processes communicating only through Redis, not simulated concurrency within one process.

**What this does not demonstrate:** behavior under real network partition between processes (single-machine only); behavior at a scale larger than 30 processes; the retry-storm scenario's `probeRate: 0.0001` makes "zero accidental probes" overwhelmingly likely, not mathematically guaranteed — the test's own assertion (`≤1`) reflects that honestly, and so does this report.

## Limitations

Single-machine; `probeRate: 0.0001` is a probabilistic bound stated as such, not a guarantee; process counts (20–30) are below a large production fleet, though the mechanism (Redis-side Lua atomicity) is not expected to depend on process count for correctness.

## How to cite this result

**Citable as-is.** Both are strong, repeatable, zero-exception correctness results:

> "Verified, via automated tests spawning 20–30 real independent OS processes, that a shared budget pool cannot be overdrawn and that circuit-breaker state is correctly shared (not locally duplicated) across processes — including a process with zero local failure history being correctly denied due to another process's failures, and one process's recovery reopening the circuit for others. 188/188 tests passing across the full suite."

Must be labeled as **integration-test results**, not production observations.

## Evidence trail

- Tests: `test/integration/failure-modes/budget-contention.test.ts`, `test/integration/failure-modes/correlated-retries.test.ts` (pre-existing in the repository, not authored as part of this audit)
- Reproduce: `npx vitest run test/integration/failure-modes --testTimeout=120000` (requires local Redis reachable at `redis://localhost:6379/15`)
- Full-suite reproduce: `npx vitest run test/unit test/integration --testTimeout=120000`
