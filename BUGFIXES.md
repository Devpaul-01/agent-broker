# Bug fixes — CI failures from job-logs (25)

All 18 failing tests from the CI run are now fixed. Full suite: **180/180 passing**, `tsc --noEmit` clean.

## 1. `src/redis/unavailable.ts` — real source bug

`isRedisUnavailableError` only matched connection-error codes (`ECONNREFUSED`, etc.) via the
error's `.code` property. A plain `new Error("connect ECONNREFUSED 127.0.0.1:6379")` (no `.code`
set — exactly what the unit tests construct) was never recognized as a Redis-unavailable error.

**Fix:** also match the known error codes as substrings of the error message, not just via `.code`.

## 2. `test/integration/report-outcome.test.ts` — test bugs

- Two tests asserted the wrong expected balance — the inline comment showing the arithmetic was
  correct, but the `toBe(...)` literal next to it wasn't (`"900"` should have been `"800"`, and
  `"800"` should have been `"500"`).
- Four tests called `reportOutcome(..., { success: false })` without the now-required `retryable`
  flag, which `reportOutcome`'s own validation correctly rejects.

**Fix:** corrected the two literals and added `retryable: true` to the four calls.

## 3. `docker-compose.yml` — malformed YAML + image typo

`redis:7-alphine` (typo) plus broken indentation under `ports:`/`healthcheck:` that doesn't parse
as valid YAML. Didn't affect CI (which uses the GitHub Actions `services:` block), but broke
`npm run redis:up` locally.

**Fix:** corrected the image name and re-indented the file.

## 4. Circuit breaker opened too late

The circuit was only flipped to `'open'` lazily, inside `request-permission.ts`'s script, the
*next time* `requestPermission` was called — never at the moment the threshold-crossing failure
was actually reported via `reportOutcome`. Tests expecting the circuit to be open immediately
after the Nth failure (with no extra "wasted" call) failed.

**Fix:** moved the threshold check into `resolve-reservation.ts`'s Lua script, so it opens the
circuit (and fires `onCircuitStateChange`) the moment the crossing failure is resolved. Threaded
`hardThreshold` through `resolveReservation`'s params and both its callers (`report-outcome.ts`,
`cleanup.ts`). `request-permission.ts` still carries its own redundant check as a fallback, but is
now a no-op once the circuit is already open.

## 5. `test/helpers/worker.ts` ignored custom broker config

The worker process always built `createBroker({ redis })` with library defaults, once, before
the first task arrived — so any test that spawned real worker processes expecting a custom
`maxDepth`, `circuitBreaker`, or `concurrencyLimit` silently got the defaults instead. This was
the actual cause of:

- `depth-spoofing.test.ts` — child created at depth 4 despite `maxDepth: 3`.
- `correlated-retries.test.ts` — circuit never opened (default `hardThreshold: 20`, not the
  test's `hardThreshold: 4`).
- `budget-contention.test.ts`'s "admits every process..." case — default `concurrencyLimit: 10`
  denied some of the 15 concurrent workers with `concurrency_exceeded`.

**Fix:** added an optional `config` field to `WorkerTask`, built the broker per-task from it
inside the message handler, and updated the three affected test files to pass their intended
config through on every worker call.

## 6. `cleanup.test.ts` — "sweeps at most CLEANUP_BATCH_SIZE..." (expected 5, got 8)

The test back-dated each reservation's sorted-set score (`ZADD ... Date.now() - 1`) **inside** the
creation loop, one at a time. Each subsequent iteration's own `requestPermission` call triggers a
lazy sweep, which picked up the just-backdated reservation from the *previous* iteration
immediately — so by the time the test's own trigger call ran, only one reservation was left
unswept, instead of all 8 being available for one batched sweep of 5.

**Fix:** back-date all 8 reservations together in one `Promise.all`, only after every reservation
has been created, so the batch-limit assertion is actually exercised.

## 7. `cross-process-harness.test.ts` — "writes made by a worker process are visible..."
(expected `'500'`, got `null`)

Not a flake, not a Redis race — the test hardcoded the wrong key. `keys.budget()` length-prefixes
the budget key (`budget:<len>:<key>`) to make keys unambiguous. The test asserted against
`"budget:17:visibility-check"`, but `"visibility-check".length === 16`, not 17. The actual key
written was `budget:16:visibility-check`, so the `redis.get(...)` call was always a guaranteed
miss, regardless of whether the write succeeded.

**Fix:** stopped hardcoding the key string; now imports and uses `keys.budget("visibility-check")`
directly, so it can never drift out of sync with the real key-building logic again.

## Note: two tests that looked flaky were an environment artifact, not a bug

`budget-contention.test.ts` and `correlated-retries.test.ts` spawn 10–30 real child processes.
On this sandbox (2 CPUs), forking that many `tsx`-loaded processes blew past the default 5000ms
per-test timeout, producing `ERR_IPC_CHANNEL_CLOSED` noise after the test runner moved on and
killed the workers mid-flight. Re-run with a generous `--testTimeout=60000`, all 6 of those tests
pass — confirming it's sandbox CPU contention, not a logic bug. CI's own log shows these same
suites finishing in 3–7 seconds total on GitHub's runners, consistent with this read. No source
or test change was made for this; flagging it here so it isn't mistaken for a regression in a
more constrained environment.

## Files changed

- `src/redis/unavailable.ts`
- `src/admission/resolve-reservation.ts`
- `src/admission/report-outcome.ts`
- `src/admission/cleanup.ts`
- `test/helpers/worker.ts`
- `test/integration/report-outcome.test.ts`
- `test/integration/cleanup.test.ts`
- `test/integration/cross-process-harness.test.ts`
- `test/integration/failure-modes/budget-contention.test.ts`
- `test/integration/failure-modes/correlated-retries.test.ts`
- `test/integration/failure-modes/depth-spoofing.test.ts`
- `docker-compose.yml`
