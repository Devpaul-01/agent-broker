# METRICS_AUDIT.md — agent-broker

> **Note (added when this workspace was committed to the repo):** written against the repo's then-current flat layout (`src/`, `test/` at the root). The TypeScript package has since moved to `typescript/`, so every `src/...` and `test/...` path below should be read as `typescript/src/...` and `typescript/test/...`.

**Repository:** https://github.com/Devpaul-01/agent-broker
**Commit inspected:** `36f7674216389acae84cfa15986ac540cbaf54bd` (branch `main`, merge of PR #1 "Release readiness cleanup")
**Inspection date:** 2026-10-13
**Environment:** Node v22.22.2, npm 10.9.7, TypeScript 5.6, vitest 5.0.2, ioredis 5.4.1. No Docker/Redis reachable in this sandbox (see Blockers).

---

## 0. What this project actually is

`agent-broker` is **not a web application**. It has zero HTTP endpoints, zero routes, zero controllers. It is a pure Node.js/TypeScript library (`npm install agent-broker`) exposing exactly **6 public methods** on one `Broker` interface (`src/broker.ts`):

```
register(RegisterRootInput)      -> RootAgent
register(RegisterChildInput)     -> ChildAgent | RegisterDenial
requestPermission(input)         -> Admitted | Denied
requestPermission(input, queue)  -> Admitted | Denied   (polling variant)
reportOutcome(input)             -> Resolved | ReportDenial
deregister(agentId)              -> DeregisterResult
addBudget(budgetKey, amount)     -> AddBudgetResult | AddBudgetDenial
```

It coordinates three things across **independent Node.js processes**, using Redis as the only shared state: (1) a shared spending budget, (2) an in-flight concurrency limit per `(target, budgetKey)`, and (3) a cross-process circuit breaker per `target`. All three checks are fused into **one atomic Lua script** per admission call (`src/admission/request-permission.ts`), and resolution (refund + concurrency release + circuit bookkeeping) is fused into a second atomic script (`src/admission/resolve-reservation.ts`) shared by both the explicit-report path and the lazy-cleanup path.

This framing matters directly for every metric below: "endpoint latency," "requests per second against a REST API," and "database query count per request" are **not applicable** — there is no database (only Redis) and no HTTP surface. The project's real engineering substance is distributed coordination correctness and the performance of a small number of atomic Redis operations, not CRUD throughput.

## 1. Source-of-truth inspection summary

| Area | Finding |
|---|---|
| Public API surface | 6 methods, `src/broker.ts`, typed, `Object.freeze`d factory, no implicit shared mutable state between broker instances (ADR-0007) |
| Atomic Lua scripts | 4: `REQUEST_PERMISSION` (7 keys), `RESOLVE_RESERVATION` (6 keys), `REGISTER_CHILD` (2 keys), `ADD_BUDGET` (1 key). Defined via one shared `defineScript`/`runScript` helper (`src/redis/script.ts`) using EVALSHA-with-EVAL-fallback. |
| Redis key namespaces | 7, all centralized in `src/redis/keys.ts`, length-prefixed to prevent ambiguous key collisions across caller-supplied strings (documented rationale in-file) |
| ADRs | 26, in `docs/adr/`, each justifying one specific design decision (e.g. refund formula, TTL/heartbeat lifecycle, why `retryable` gates the circuit, why concurrency is distinct from depth) |
| Unit test files | 8 files / 88 tests — pure validation logic, **no Redis dependency**, run and verified in this session: **88/88 pass** |
| Integration test files | 19 files — **require a real, reachable Redis**; `test/helpers/redis.ts` throws loudly ("These tests need a real Redis and are never skipped") rather than silently skipping. Verified in this session: typecheck is clean, and one integration file correctly fails with a connection error when Redis is absent — confirming these are not fake/mocked. |
| Cross-process test harness | `test/helpers/harness.ts` + `test/helpers/worker.ts`: spawns **real `child_process.fork()`** processes, each with its own V8 instance, own Redis connection, communicating over IPC. Used by 4 test files, ~14 `it()` blocks, exercising up to 30 concurrent real OS processes. |
| Mock usage | None found in `src/`. The only "mock-like" test infrastructure is the IPC worker harness, which is real processes, not mocks. |
| Fault injection | Real (not mocked): `test/integration/redis-unavailable.test.ts` connects to `redis://127.0.0.1:1` (a genuinely unreachable port) to trigger `MaxRetriesPerRequestError` / `ECONNREFUSED` paths. |
| Performance/benchmark code | **None exists in the repository.** No `bench/` directory, no load-test script, no latency measurement code anywhere. This is the gap Part Two must fill. |
| Documentation self-awareness | `docs/ARCHITECTURE.md` already states two real limitations in writing: the library is "not designed for gating very high-frequency, low-latency operations (sub-10ms)," and "a single extremely popular target or budgetKey ... serializes on Redis's single-threaded command execution." These are falsifiable, specific claims — good benchmark candidates, and also a sign the author already understands the system's performance envelope rather than being naive about it. |

### Capability classification (per Section 3 of the brief)

| Capability | Status |
|---|---|
| Atomic budget+concurrency+circuit admission in one Redis round trip | **Implemented, exercised by unit tests (validation) and integration tests (logic + single-process concurrency)** |
| Cross-process correctness under real contention (budget, circuit, depth) | **Implemented and exercised by real multi-process tests** — this is the strongest, most distinctive evidence in the repo |
| Lazy reservation cleanup / idempotent resolution shared between report and sweep paths | **Implemented, exercised by `cleanup.test.ts` and the resolve-reservation idempotency assertions in `report-outcome.test.ts`** |
| Circuit breaker soft/hard threshold, single-probe recovery | **Implemented and exercised cross-process** (`correlated-retries.test.ts`) — including the "zero local history, denied anyway" and "one probe recovers everyone" cases, which are the correctness properties that actually matter |
| Redis-unavailable degraded mode (`allow`/`deny`) | **Implemented, exercised against a real unreachable socket**, not a mock |
| Queue mode (poll-with-backoff admission) | **Implemented, exercised in `queue-mode.test.ts`, `queue-mode-abort.test.ts`, `queue-mode-contention.test.ts`** — worth checking before relying on resume claims about it (see RESUME_METRICS_AUDIT.md) |
| Performance/latency/throughput under load | **Not implemented, not measured anywhere.** This is a pure gap, not a partially-tested area. |
| Resource consumption (memory, Redis memory growth) | **Not implemented, not measured.** |
| LLM provider integration | **Does not exist by design** (ADR-0004 "no provider abstraction") — the library explicitly never talks to a provider. Any resume claim implying agent-broker does LLM-call latency, token costs, or provider failover is describing a different layer than what this code does. |

---

## 2. Candidate inventory

Columns: **ID | Subsystem | Engineering property | Proposed metric | Measurement method | Baseline/comparison | Dependencies | Effort | Resume value | Main risks | Priority**

### P0 — Highest priority

| ID | Subsystem | Property | Metric | Method | Baseline | Deps | Effort | Resume value | Main risks |
|---|---|---|---|---|---|---|---|---|---|
| **M1** | Admission (budget) | Correctness under real cross-process contention | Count of admitted vs. denied calls vs. expected exact admission count; final pool balance | Already-written test (`budget-contention.test.ts`): 20–30 real forked processes racing a budget sized for exactly 3–10 admissions. **Already passes as a correctness test; needs to be re-run and reported as evidence, not re-invented.** | N/A — this is a correctness invariant (never-overdrawn), not a percentage comparison | Local Redis (Docker or binary) | Low (run existing suite, capture output) | Very high — directly disproves the common hidden bug in naive distributed rate limiters (TOCTOU race) | None if run as-is; risk only in *overclaiming* it as a performance result instead of a correctness result |
| **M2** | Admission (circuit breaker) | Cross-process shared state, not per-process local state | Boolean/categorical: does a zero-local-history process get denied because of another process's failures? Does one process's probe success recover the circuit for a process that never acted? | Already-written test (`correlated-retries.test.ts`), 3 scenarios | N/A — correctness invariant | Local Redis | Low (run existing suite) | Very high — this is the single most "senior distributed systems" result in the repo: it falsifies the specific failure mode (uncoordinated local circuit breakers) that naive multi-process systems have | None if reported honestly as what it is: a correctness demonstration, not a speed number |
| **M3** | Admission (single-script latency) | Per-call latency of the one atomic admission operation (the thing every other claim depends on) | Wall-clock time of `requestPermission` → `reportOutcome` pairs, median/p90/p95/p99, against a **warm, local, unloaded Redis**, N≥1000, after warm-up | None needed for an absolute number; optional comparison against a naive 3-round-trip equivalent (GET budget, GET concurrency, GET circuit state as 3 separate round trips) to quantify what "one atomic script" buys vs. "the naive non-atomic version of the same idea" | Local Redis, a small new benchmark script (does not exist yet) | Medium | High — this is the number a hiring manager will actually ask about ("what's the overhead of your coordination layer"), and the docs already claim "not suited to sub-10ms workloads," which this metric can directly confirm or correct | Must not be reported as "X ms in production" — it is a local, single-machine, single-Redis-instance number. Must document Redis version, network (localhost vs. real network), and hardware. |
| **M4** | Admission (concurrency under contention) | Does the concurrency limit hold exactly under real multi-process load, same way M1 proves it for budget | Count of admitted calls at a given `concurrencyLimit` vs. processes attempting simultaneously, across real forked processes | New test, same harness as M1/M2 (harness already exists; just a new scenario — `budget-contention.test.ts`'s third test already partially covers concurrency headroom but doesn't test concurrency *exhaustion* under real cross-process contention the way M1 tests budget exhaustion) | Local Redis | Low–Medium (harness reuse) | High — concurrency-exceeded is a documented denial reason with its own invariant (Invariant 13 in the architecture doc) but, unlike budget, has no dedicated cross-process exhaustion test yet | Should confirm this really is a gap before building it — see "capability classification" table; worth a quick grep before implementing |
| **M5** | Reliability (crash recovery) | A caller that crashes mid-call (never calls `reportOutcome`) — does its reservation get cleaned up and budget refunded within a bounded time, without double-refunding if `reportOutcome` *does* eventually race the sweep? | `cleanup.test.ts` already exists for the single-process case; a cross-process version (forked worker calls `requestPermission`, is killed before reporting, parent waits past TTL and confirms sweep + refund) is new work | Compare "orphaned reservation, never resolved" (would leak budget forever) vs. "swept after TTL+grace" (actual behavior) | Local Redis, harness reuse | Medium | High — recovery-after-failure is explicitly called out in the brief as potentially more valuable than a latency number, and this project's design (lazy cleanup, not a background timer — ADR-0001) is a specific, defensible choice worth being able to explain with evidence | Timing-sensitive test; must budget real wall-clock wait for TTL expiry, or use a short TTL configured for the test |

### P1 — Valuable, after P0

| ID | Subsystem | Property | Metric | Method | Baseline | Deps | Effort | Resume value | Main risks |
|---|---|---|---|---|---|---|---|---|---|
| **M6** | Queue mode | Throughput/latency of poll-with-backoff admission under contention vs. plain denial | p50/p90 time-to-admission when N processes queue for a budget that frees up over time, vs. immediate-mode denial count | `queue-mode-contention.test.ts` already exists and should be inspected before building new instrumentation — likely needs only better reporting, not new mechanism | Queue mode vs. non-queue mode under identical contention (same workload, mode toggled) | Local Redis | Medium | Medium — useful but not as distinctive as M1/M2; this is "a retry wrapper with backoff," which is good engineering but less novel than the atomic script | Backoff jitter makes results noisy by design (`JITTER_RATIO = 0.2`); must report distribution, not a single run |
| **M7** | Admission script | Relative cost of the atomic script at increasing concurrency (how median/p99 latency degrades as concurrent callers increase, given the documented hot-key serialization limit) | Same harness as M3, but sweep concurrency level (1, 10, 50, 200 simultaneous callers against **one** `(target, budgetKey)` pair) and plot latency vs. concurrency | Each concurrency level is its own baseline point on the same curve | Local Redis, benchmark script from M3 extended | Medium | High — this is the metric that empirically validates (or corrects) the architecture doc's own stated hot-key limitation. Turning the author's own documented caveat into measured evidence is a strong interview story ("I identified this limit by design, then confirmed it empirically") | Single-machine Redis won't show real network latency; must state this is a lower bound / best case, not a production ceiling |
| **M8** | Static counts | Implementation surface size | Public methods (6), Lua scripts (4), Redis key namespaces (7), ADRs (26), test files (27), total `it()` blocks (~113), cross-process `it()` blocks (~14) | Already counted in this audit via `grep`/`find`, reproducibly | N/A — these are facts, not comparisons | None | Trivial (already done) | Low–Medium on its own, but useful as supporting context for other claims ("tested under real multi-process concurrency in 14 dedicated scenarios," not a vague "thoroughly tested") | Must re-run the counting commands at time of resume-writing in case the repo has changed since this audit |
| **M9** | Redis-unavailable fault mode | Time-to-detect an unreachable Redis and correctly degrade (`allow`) or fail closed (`deny`) | Wall-clock time from call to returned decision, against the genuinely unreachable `127.0.0.1:1` setup already used in `redis-unavailable.test.ts` | `connectTimeout: 300` is already configured in the test; measuring how close actual detection time tracks that configured timeout is the useful number | Local, no real Redis needed (that's the point) | Low | Medium — useful for an SLA-style claim ("detects and degrades within ~300ms") but narrower in scope than M1/M2/M5 | Detection time is mostly a function of the configured `connectTimeout`/`maxRetriesPerRequest`, not really a property of agent-broker's own code — must describe it that way, not as if the library invented fast failure detection |

### P2 — Optional

| ID | Subsystem | Property | Metric | Method | Baseline | Deps | Effort | Resume value | Main risks |
|---|---|---|---|---|---|---|---|---|---|
| **M10** | Resource consumption | Redis memory growth per registered agent/reservation under sustained load | `INFO memory` before/after N registrations+admissions | Local Redis | Local Redis, scripting via `redis-cli` or ioredis `.info()` | Medium | Low–Medium — interesting but not what a backend hiring manager usually asks about for a coordination library | Hard to make this a clean, reproducible, meaningful number without a lot of care around Redis's own memory fragmentation behavior; risk of a misleading result is real |
| **M11** | Admission | EVALSHA-vs-EVAL fallback cost (cache-miss path in `runScript`) | Latency difference between a warm EVALSHA call and a forced cache-miss (after `SCRIPT FLUSH`) EVAL fallback | Direct comparison, same script, two code paths already written in `script.ts` | Local Redis | Low | Low — a real mechanism (`script.test.ts` already covers correctness of the fallback), but the performance delta is a known, well-understood Redis behavior, not something distinctive to this codebase | Low resume value relative to effort; mostly interesting as a "did you understand why you wrote it this way" interview answer, not a headline number |
| **M12** | Register / registerChild | Depth-chain registration latency as depth increases | Time to register a chain of N children sequentially | Local Redis | Low | Low | Depth is already correctness-tested (`depth-spoofing.test.ts`); the performance angle adds little since each `registerChild` call is O(1) (single atomic script, no chain traversal) — this is unlikely to reveal anything interesting, which is itself worth noting but not worth a dedicated benchmark | Low expected signal: probably flat regardless of depth, by design |

### Rejected

| ID | Candidate | Reason rejected |
|---|---|---|
| **R1** | "Endpoint latency," "requests per second," "database query duration" as stated in the brief's generic category list | Not applicable: no HTTP endpoints, no SQL/NoSQL database — only Redis. Measuring these as named would misrepresent the project. |
| **R2** | Cache hit ratio / cache invalidation metrics | There is no cache layer in this codebase (budget pools and concurrency counters are the primary data, not a cache in front of something else). Applying cache metrics here would be fabricating a category that doesn't exist in this implementation. |
| **R3** | LLM provider latency, time-to-first-token, token cost, provider failover | Explicitly out of scope by design (ADR-0004: "no provider abstraction"). The library never calls an LLM provider. Any benchmark here would be measuring a different system, not agent-broker. |
| **R4** | Real-time/WebSocket metrics (connection establishment, message throughput, reconnection) | No WebSocket or persistent-connection layer exists in this codebase. |
| **R5** | "N+1 query" / query-plan / index-effectiveness analysis | No relational database. Redis key design is already covered under M3/M7 (the actual performance-relevant mechanism here), not under SQL-style query-plan analysis, which doesn't apply. |
| **R6** | Historical "before/after" percentage-improvement claim for admission latency, if the resume contains one | Rejected as a *reproducible historical comparison* unless a literal prior commit/implementation exists to re-run as the baseline. See RESUME_METRICS_AUDIT.md — if no such baseline is recoverable, the honest path is a **current, clearly-labeled synthetic comparison** (e.g., atomic single-script vs. hypothetical 3-round-trip non-atomic equivalent), not a reconstructed historical number. |

---

## 3. Recommended first batch (what to implement first, and why)

**M1 and M2 first — immediately, before writing any new code.** They already exist as passing (when Redis is reachable) correctness tests. The only work needed is: get a local Redis running, run the existing suite, and capture/report the real output (pass/fail counts, final pool balances, circuit states) as documented evidence. This is the highest resume-value, lowest-effort, lowest-risk pair in the entire inventory — it is a correctness proof of exactly the two hardest problems a naive multi-process coordination system gets wrong (budget races, correlated retries via local-only circuit breakers), demonstrated with real OS processes, not simulated concurrency.

**M3 next.** Before any percentage or "fast" claim can be defended, there needs to be a baseline absolute number for the one operation everything else depends on: the atomic admission script's own latency distribution on a warm, local, unloaded Redis. This is also the number needed to sanity-check the architecture doc's own "not for sub-10ms workloads" claim.

**M5 third.** Recovery-after-crash is explicitly the kind of result the brief calls out as potentially more valuable than a plain latency number ("A correctness benchmark, recovery experiment, or concurrency test may be more valuable than a simple latency measurement"), and it tests a real design decision (lazy cleanup, ADR-0001) that the author chose deliberately over a background-timer alternative — a design trade-off a senior engineer would want to probe in an interview.

**M4 and M7 after that, time permitting.** M4 closes the one correctness gap directly parallel to M1 (concurrency exhaustion under real contention, not just budget exhaustion). M7 turns the architecture doc's own stated hot-key limitation into an empirical curve, which is a distinctive "I found my own system's limit and measured it" story.

M6, M8, M9 are solid P1 material for a second pass. M10–M12 are explicitly optional and lower-value relative to effort.

---

## Update: Redis was obtained, and the full existing test suite was actually run — 188/188 pass

A second `apt-get update` refreshed this sandbox's package mirror, after which `apt-get install redis-server` succeeded (the first attempt had 404'd on a stale mirror). A local Redis 7 instance was started (`redis-server --daemonize yes --port 6379`) and verified reachable.

**Correction to an earlier finding in this session:** an initial pass at the 20- and 30-process cross-process scenarios failed with `ERR_IPC_CHANNEL_CLOSED` under Vitest's default test timeout. I initially attributed this to this sandbox's single CPU core (`nproc` reports 1) being a hard ceiling on concurrently forked processes. That diagnosis was incomplete: re-running the same scenarios with an extended timeout (`--testTimeout=120000`) showed they are **not** capacity-limited — they simply take longer than the default timeout on a single core (the 30-process scenario takes ~13.5s; the full suite's cross-process tests together take ~50s). Once given enough time, every scenario passes at its full originally-designed scale. I'm stating this correction explicitly, in line with the brief's instruction to preserve and report findings honestly rather than let an earlier, more pessimistic claim stand uncorrected.

**Full results, actually executed in this session (full suite, single run, `npx vitest run test/unit test/integration --testTimeout=120000`):**

- **27/27 test files pass. 188/188 individual tests pass. Zero skips, zero failures.**
- `npm run typecheck` — clean.
- All 8 unit test files (88 tests, no Redis needed) — 88/88 pass.
- All non-fork integration tests against real Redis — pass, including genuine `ECONNREFUSED` fault injection in `redis-unavailable.test.ts` (confirmed in stderr output, not mocked) and the full `queue-mode`, `queue-mode-abort`, and `queue-mode-contention` suites.
- `cross-process-harness.test.ts` (4 tests, up to 5 real forked processes) — 4/4 pass.
- `depth-spoofing.test.ts` (4 tests, 1 forked worker each) — 4/4 pass.
- **`budget-contention.test.ts` (M1), at full designed scale** — 3/3 pass: 20 real forked processes racing a budget sized for exactly 10 admissions (exact result); 30 processes racing a budget sized for exactly 3 (exact result); 15 processes with a comfortable budget (all correctly admitted).
- **`correlated-retries.test.ts` (M2), at full designed scale** — 3/3 pass: a zero-local-history process denied purely by another process's failures; 20 uninvolved processes hitting an already-open circuit, denied outright rather than amplifying load; one process's successful recovery probe reopening the circuit for every other waiting process.

This means **M1 and M2's correctness invariants are now both confirmed with real, fully-executed evidence, at their full originally-designed scale, not a reduced approximation.** See `MEASUREMENT_PLAN.md` for the exact runs, timings, and the corrected diagnosis, and `RESUME_METRICS_AUDIT.md` for what this evidence does and does not support claiming on a resume.

## Residual work for Part Two

- M3 (absolute latency benchmark script) and M4/M5 (new concurrency-exhaustion and crash-recovery tests) were designed in `MEASUREMENT_PLAN.md` but not yet implemented — that remains Part Two's starting work. Redis is now confirmed reachable and fast enough in this environment to support building and running them.
- On a genuinely multi-core machine (standard CI, any dev laptop), the full cross-process suite should run well under the ~50s observed here — worth re-confirming timings there if wall-clock time becomes relevant to any future CI budget.
