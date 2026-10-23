# RESUME_METRIC_RECOMMENDATIONS.md — agent-broker

Your existing agent-broker bullets were audited in `RESUME_METRICS_AUDIT.md` and found to already be accurate — none needed correction. This document does **not** propose replacing or rewording any of them. It covers only the narrow question left open: does the new M3/M4/M5 evidence support any *additional* bullet, and if so, exactly what should it say.

Per your instruction, I'm not trying to force measurements onto bullets that can't honestly carry them. Two of the three new experiments clear the bar for a resume addition; one does not, and I'm saying so directly rather than padding the list.

## Recommended additions

| Resume bullet | Evidence type | Source of metric | Supporting artifact | Conditions | Limitations |
|---|---|---|---|---|---|
| "Verified exact concurrency-limit enforcement under 20-process contention via a dedicated cross-process test (zero deviation across repeated runs)" | Integration-test result | M4, executed in this session | `measurement/bench/m4-concurrency-exhaustion.test.ts`; report: `measurement/reports/M4-concurrency-exhaustion.md` | Local Redis, 1-CPU sandbox, 20 real forked processes, `concurrencyLimit: 3`, 3 independent runs | Single-machine only; does not test the "slot released mid-race" interleaving |
| "Verified crash recovery: a killed process's reservation is automatically swept and refunded by a subsequent caller, with no double-refund on a racing late report" | Integration-test result | M5, executed in this session | `measurement/bench/m5-crash-recovery.test.ts`; report: `measurement/reports/M5-crash-recovery.md` | Local Redis, 1-CPU sandbox, real `child_process.kill()`, 3 independent runs, 2 scenarios each | Recovery is lazy (triggered by someone else's next call) — no bounded recovery-time SLA exists by design; short TTL (500ms) used for test speed, not the library's 30s default |

## Rejected: M3 (admission latency) as a standalone resume bullet

**Not recommended as its own bullet**, for a specific reason: a bare "median 0.25ms admission latency" number, without context, invites the question "compared to what?" — and the honest answer is "nothing; there's no historical baseline and no production traffic." A lone absolute-latency bullet on a resume reads as a performance claim, and this project's actual strength is correctness under real concurrency, not speed. Forcing a latency number onto the resume when the project's much stronger evidence is correctness-based would be optimizing for "looks quantitative" over "is the most persuasive true thing available" — exactly what the original brief says not to do.

**Where it's still useful:** as a number to have ready if an interviewer asks "how much overhead does your coordination layer add?" — see the interview prep section below. It's real, correctly measured, and worth knowing cold; it's just not resume-bullet material on its own.

## What this means for the resume as a whole

Your agent-broker section is already strong and already honest. The two additions above are genuine, newly-earned evidence that fills gaps the original bullets didn't claim to cover (concurrency-limit correctness specifically, and crash recovery specifically) — they're incremental, not replacements. If you add them, I'd suggest placing them after the existing "Multi-Process Test Harness" bullet, since they extend that same evidence base (the same `child_process.fork()` harness) rather than introducing a new mechanism.

If you'd rather not add anything and keep the section as-is, that's also a completely reasonable call — the existing bullets already accurately represent a well-tested, well-designed system, and six precise bullets with zero fabricated numbers is a stronger signal than eight bullets with two added just because new tests happened to pass.

---

## Interview preparation — strongest evidence, explained

For each of the three strongest results (two recommended bullets plus M3 as background knowledge), here's what to say if asked how the number was obtained.

### "20 processes raced for 10 budget slots, exact count every time" (M1 — existing bullet)

- **What was measured:** whether a shared Redis-backed budget pool can be overdrawn when independent OS processes request admission simultaneously.
- **How it was measured:** `child_process.fork()` spawns 20 genuinely separate Node.js processes (not Promises in one process — separate V8 instances, separate OS processes), each independently calling `requestPermission` against a budget sized for exactly 10 admissions at the configured cost. Communication is via IPC, same as a real multi-process deployment would use Redis as its only shared state.
- **Baseline:** none needed — this is a correctness invariant (never overdrawn), not a percentage. The informal "baseline" is "what a naive read-then-write implementation would do under this race" (go negative) — that naive version isn't built in this codebase; it's a mental model for why the test matters, not a measured comparison.
- **Result:** exactly 10 admitted, 10 denied, every run, across at least 5 independent executions in this and the prior session.
- **What it demonstrates:** the single atomic Lua script correctly serializes the check-and-decrement, because Redis executes the whole script as one atomic unit — no window exists for two processes to both read "budget available" before either writes.
- **What it does not demonstrate:** behavior across a real network partition between processes (single-machine test); behavior at a scale beyond 30 processes (untested, though the mechanism doesn't depend on process count for correctness).

### "Concurrency limit held exactly under 20-process contention" (M4 — new)

- **What was measured:** the same class of question as M1, but for the in-flight concurrency cap rather than the budget pool — a separate, independently-enforced constraint.
- **How it was measured:** same harness as M1, 20 real forked processes, `concurrencyLimit: 3`, ample budget so budget could never be the binding constraint, no process releases its slot (no `reportOutcome` call) so all 20 attempts genuinely contend for 3 slots simultaneously.
- **Baseline:** a sanity-check scenario in the same test file with `concurrencyLimit: 25` (greater than the worker count) — confirms all 20 are admitted when concurrency isn't the binding constraint, ruling out "the test harness always denies some fraction" as an alternative explanation for the tight-limit result.
- **Result:** exactly 3 admitted, 17 denied specifically with reason `concurrency_exceeded` (not budget-related), every run across 3 independent executions.
- **What it demonstrates:** this was a real, confirmed gap in the existing test suite before I wrote it — the existing budget tests proved the budget axis but left the concurrency axis's cross-process behavior unverified. This closes that gap with the same evidentiary standard as M1.
- **What it does not demonstrate:** behavior when slots are released mid-race (a different interleaving, not tested here).

### "Crash recovery verified via real process kill" (M5 — new)

- **What was measured:** whether a reservation created by a process that then genuinely dies (not "forgets to call", but is actually killed) gets correctly cleaned up, and whether a late report racing that cleanup causes a double-refund.
- **How it was measured:** a worker process is admitted (reservation created, budget reserved), then killed via `child.kill()` — a real SIGTERM to a real OS process. The test waits past the reservation's TTL, then has a second, independent process make any call — this triggers the library's lazy sweep (which runs unconditionally at the top of every `requestPermission` call, by design). A third scenario then has a late `reportOutcome` arrive from yet another process after the sweep already resolved the reservation, checking it's correctly rejected as `already_resolved`.
- **Baseline:** none needed — correctness demonstrated as a before/after within one run (budget untouched before the trigger, correctly refunded after), not a comparison between implementations.
- **Result:** full refund confirmed, concurrency released, reservation marked resolved, removed from the expiring set — and the late-report race correctly rejected with no double-refund. All passing across 3 independent runs, both scenarios.
- **What it demonstrates:** the library's deliberate architectural choice (lazy, call-triggered cleanup rather than a background timer — an explicit design decision, not an oversight) works correctly, including the specific edge case of a genuinely dead process, not just a same-process "forgot to report."
- **What it does not demonstrate — and this is worth volunteering, not waiting to be asked:** a bounded recovery-time SLA. Because cleanup is lazy, in a fully idle system with no further calls from anyone, an orphaned reservation could theoretically sit unswept indefinitely. This is a real, known trade-off of the design (choosing simplicity and no background process over a guaranteed recovery window), and being able to name it unprompted is a stronger signal than only presenting the result that worked.

### "Admission script median latency ~0.25ms" (M3 — background knowledge, not a resume bullet)

- **What was measured:** the absolute wall-clock cost of one `requestPermission` + `reportOutcome` pair — the real atomic Lua script, not a synthetic stand-in — on local Redis.
- **How it was measured:** 1000 sequential timed calls after a 50-call warm-up (to exclude EVALSHA script-caching and connection-warmup effects from the timed sample), `process.hrtime.bigint()` around just the call itself.
- **Baseline:** an optional, clearly-labeled synthetic comparison — a hand-written, non-atomic 3-round-trip equivalent (three separate `GET`s, no writes) — built only to show what bundling into one atomic script costs relative to three plain reads, not to reconstruct any historical implementation.
- **Result:** median 0.22–0.25ms, p99 under 5ms, consistent across 3 independent runs of 1000 calls each. The naive 3-round-trip reference ran at ~0.04ms median — confirming round-trip count, not script complexity, is the dominant cost, and that the atomic version's extra work (writes, multiple checks) adds roughly 0.2ms over three bare reads.
- **What it demonstrates:** on local, unloaded Redis, the coordination overhead this library adds is well under a millisecond at the median.
- **What it does not demonstrate:** production latency (no real network hop was measured); latency under concurrent contention (this was sequential only); any historical improvement (no historical baseline exists to compare against).
- **Why it's not a resume bullet:** without a meaningful point of comparison, a bare latency number reads as a performance claim this project isn't really making — its real strength, backed by much stronger evidence, is correctness under real multi-process contention, not raw speed.
