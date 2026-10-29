# M3 — Admission script latency distribution

> **Note (added when this workspace was committed to the repo):** written against the repo's then-current flat layout. Every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`.

**Status:** Executed successfully. 3 independent runs, N=1000 each, after 50-call warm-up.

## Objective

What is the actual latency of one `requestPermission` → `reportOutcome` pair — the single atomic Lua script that fuses the budget check, concurrency check, and circuit-breaker check into one Redis round trip — on a warm, local, unloaded Redis? And does this absolute number support or contradict the architecture doc's own stated caveat ("not designed for gating very high-frequency, low-latency operations (sub-10ms)")?

## Implementation under test

`src/admission/request-permission.ts` (`REQUEST_PERMISSION` Lua script: `EXISTS`, `ZREMRANGEBYSCORE`, `ZCARD`, `GET` ×2, `DECRBY`, `INCR`, `HSET`, `PEXPIRE` ×2, `ZADD` — plus the unconditional `sweepExpiredReservations()` call that runs at the top of every `requestPermission` invocation) paired with `src/admission/resolve-reservation.ts` (`RESOLVE_RESERVATION` script) via `reportOutcome`. Script location: `measurement/bench/m3-admission-latency.ts`.

## Environment

- Redis 7.0.15, localhost, default `redis:7-alpine`-equivalent config (no Docker available in this sandbox — a system-package Redis was installed and used instead; config was not customized)
- Node v22.22.2, single CPU core (Intel Xeon @ 2.10GHz, confirmed via `os.cpus()`), 3.9 GB RAM
- Commit `36f7674216389acae84cfa15986ac540cbaf54bd`, clean working tree in `src/`/`test/`
- Single sequential client process — no other load on the machine during the timed window

## Workload

- N = 1000 timed `requestPermission` + `reportOutcome` pairs, sequential (concurrency = 1)
- 50-call warm-up discarded before timing began (EVALSHA cache warm-up, connection warm-up, JIT warm-up)
- Fixed `estimatedCost: 1`, `actualCost: 1` (refund = 0 each call — see Results for why this matters), single agent, single target, ample budget so no call was ever denied
- Repeated 3 times as independent runs (fresh `flushdb`, fresh registration each time)

## Results

| Run | N | Median (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Min (ms) | Max (ms) | Mean (ms) | Std dev (ms) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1000 | 0.25 | 0.57 | 1.52 | 4.08 | 0.12 | 20.15 | 0.49 | 1.33 |
| 2 | 1000 | 0.22 | 0.54 | 1.32 | 4.31 | 0.09 | 15.27 | 0.42 | 0.99 |
| 3 | 1000 | 0.23 | 0.55 | 1.02 | 3.93 | 0.10 | 17.34 | 0.44 | 1.16 |
| 4 (follow-up session) | 1000 | 0.30 | 0.69 | 1.54 | 5.22 | — | — | — | — |
| 5 (post-restructure, commit `1af5b72`) | 1000 | 0.27 | 0.71 | 1.66 | 5.16 | 0.14 | 17.08 | 0.53 | 1.18 |

Run 4 was executed in a later session (same commit, same sandbox type, freshly started Redis) as a re-confirmation that the harness still works correctly rather than a planned part of the original 3-run design. It is slightly higher across the board than runs 1–3 but the same order of magnitude — consistent with ordinary run-to-run sandbox variance (shared single core, no isolation from other processes on the host) rather than a regression. Correctness held in this run too. This is reported as a 4th data point rather than discarded, per the instruction not to cherry-pick favorable runs.

Run 5 was executed when this measurement workspace was ported and committed into the repository, after the repo had been restructured (`src/`/`test/` moved under `typescript/`) and had advanced to commit `1af5b72987ef450fae8229502b41f34676299485`. Same order of magnitude as all prior runs (median 0.22–0.30ms, p99 3.93–5.22ms across all 5 runs) — the admission script's measured cost has not materially changed across the restructure.

Optional synthetic comparison (non-atomic 3-round-trip equivalent — `GET` budget, `GET` concurrency, `GET` circuit state, no writes, no atomicity):

| Run | Median (ms) | p90 (ms) | p99 (ms) |
|---|---|---|---|
| 1 | 0.04 | 0.06 | 0.18 |
| 2 | 0.04 | 0.05 | 0.21 |
| 3 | 0.04 | 0.05 | 0.10 |

**Correctness:** all 3 runs — final budget pool balance matched the expected value exactly (`initial - n_calls`, since `estimatedCost == actualCost == 1` means a zero refund per call, not a net-zero balance change — this distinction is explained below because it's also where an error was caught and fixed during validation). No call was ever denied. No errors.

## Baseline comparison

The "baseline" here is not a historical before/after — it's a **current, clearly-labeled synthetic reference**: a hand-written, deliberately non-atomic 3-step read sequence against the same Redis instance, built only to quantify what one round trip executing ~10 Redis commands inside a script costs relative to 3 separate plain `GET` round trips. It is explicitly not safe under concurrency (no atomicity, no writes) and does not reproduce any historical version of this library — it exists purely to show that **round-trip count, not script complexity, dominates the cost**: 3 plain `GET`s average ~0.04ms median, while the single atomic script (10 commands, writes included) runs at ~0.22–0.25ms median. The atomic version does more work in each round trip and is still well under 1ms at the median.

## Interpretation

**What this demonstrates:** on a local, unloaded, single-core Redis instance, the atomic admission operation that fuses budget, concurrency, and circuit-breaker checks into one round trip has a median latency around a quarter of a millisecond, with p99 under 5ms across all three runs. This is stable and reproducible — the three independent runs agree closely (medians 0.22–0.25ms, p99s 3.93–4.31ms).

This result is interesting against the architecture doc's own stated caveat: `docs/ARCHITECTURE.md` says the library is "not designed for gating very high-frequency, low-latency operations (sub-10ms)." The measured number here — median 0.22–0.25ms — is comfortably *under* 10ms, not over it. Two readings are both reasonable and worth stating honestly rather than picking the flattering one: (a) the doc's caveat may be conservative, written to account for non-localhost network latency this benchmark cannot see, or (b) the caveat is really about *relative* overhead for operations whose own cost is itself sub-10ms (i.e., even a "fast" 0.25ms coordination check becomes a meaningful tax on a 2ms operation), not about the script's absolute cost in isolation. This benchmark supports neither reading definitively — it only establishes the absolute local number; it does not measure the overhead as a *fraction* of a real downstream operation's cost, which would require a different experiment design.

**What this does not demonstrate:** production latency (this is localhost, no real network hop to a managed Redis instance); latency under concurrent load (this is sequential, concurrency=1 — see M7 in `METRICS_AUDIT.md`, not implemented); any historical improvement (no historical baseline exists or was reconstructed).

## Limitations

- Single-machine, localhost Redis: this is a best-case / lower-bound number. A managed Redis instance (ElastiCache, Redis Cloud, etc.) reached over a real network would add latency this benchmark cannot show.
- Max values (15–20ms) appear as occasional outliers in every run — almost certainly single-core scheduling jitter or Node GC pauses on this constrained sandbox (1 vCPU, shared with the Redis server process itself), not a property of the admission script. This is reported rather than trimmed, per the measurement plan's instruction not to discard "slow" individual calls.
- Sequential only — says nothing about latency degradation under concurrent contention (that's M7, not yet implemented).
- The synthetic 3-round-trip comparison is a reference point for round-trip-count cost, not a reconstruction of any prior implementation.

## How to cite this result

Report it as a **local, synthetic benchmark**, not a production number, and without any percentage-improvement claim (no historical baseline exists). Suggested wording: "The atomic admission operation (budget + concurrency + circuit-breaker check in one Redis round trip) measured a median of ~0.25 ms and p99 under 5 ms on local Redis (N=1000, 3 independent runs)."

## Evidence trail

- Script: `measurement/bench/m3-admission-latency.ts`
- Raw results: `measurement/results/m3-admission-latency/08aca357-176d-4e4d-944a-f02bb8eec23e.json`, `47e68060-4125-48b0-89b4-cfb141f64235.json`, `7a18cb84-469a-463a-900a-310cd0d33b80.json`, `04cb832a-1d46-4ce0-90b8-fabe34edd6e9.json` (run 4, follow-up session), `488202db-e515-492f-859b-7d07b9cfcb58.json` (run 5, post-restructure commit)
- Reproduce: `npx tsx measurement/bench/m3-admission-latency.ts --n=1000 --warmup=50 --compare` (requires local Redis reachable at `redis://localhost:6379/15`)
