# Repository Audit — Agent Broker (TypeScript)

Baseline commit: `36f7674` (branch `main`, working tree clean at audit time).
This document reflects direct inspection of the source in `src/`, tests in `test/`, and the
existing ADR log in `docs/adr/`. It does not rely on the README for behavior claims.

## 1. What the library is

Agent Broker is a Redis-coordinated admission controller for independent Node.js processes
that call external resources ("targets", e.g. `groq:llama-3.3-70b`). It combines three
coordination mechanisms behind one admission decision:

1. **Shared budget** — an integer pool (`budget:<key>`) decremented atomically at admission
   and refunded at resolution.
2. **Concurrency limiting** — an in-flight counter per `(target, budgetKey)` pair.
3. **Circuit breaking** — a sliding-window failure counter per `target`, with a single-probe
   recovery model (ADR-0010).

It also provides a lightweight agent-identity/delegation model (root/child agents, bounded
depth) used to derive which budget pool and concurrency scope a call belongs to.

## 2. Public API surface (from `src/index.ts`, `src/broker.ts`)

`createBroker(options: BrokerOptions): Broker` — the single entry point. Returns a frozen
object with:

- `register(input)` — overloaded: `{ budgetKey?, initialBudget? }` registers a root agent;
  `{ parentId }` registers a child agent (depth derived from parent, capped by `maxDepth`).
- `requestPermission(input, queueOptions?)` — the core admission call. Without `queueOptions`,
  one atomic attempt. With `{ mode: "queue", queueTimeout, signal? }`, polls with capped,
  jittered exponential backoff (`src/admission/queue.ts`) until admitted, denied for a
  non-queueable reason, timed out, or aborted.
- `reportOutcome(input)` — resolves a reservation: refunds unused budget, releases the
  concurrency slot, and (if `retryable`) feeds the circuit breaker.
- `deregister(agentId)` — deletes an agent identity record immediately; does not touch
  outstanding reservations (they carry their own `budgetKey`/`target`, ADR-0003).
- `addBudget(budgetKey, amount)` — additive top-up only; requires the pool to already exist
  (ADR-0025).

Configuration (`src/config/index.ts`, `parseConfig`): `redis` (required, an `ioredis` client),
`maxDepth` (default 5), `agentTtl` (default 3,600,000 ms), `defaultReservationTtl` (30,000 ms),
`maxReservationTtl` (300,000 ms), `concurrencyLimit` (10), `onRedisUnavailable` (`"deny"` default
or `"allow"`), `circuitBreaker` (`softThreshold` 5, `hardThreshold` 20, `windowMs` 60,000,
`probeRate` 0.1), `hooks` (`onDecision`, `onOutcome`, `onCircuitStateChange`, `onCleanup`).
Invariants enforced at config time: `defaultReservationTtl <= maxReservationTtl`, and
`agentTtl >= maxReservationTtl` (so an agent cannot expire mid-call).

Errors: `BrokerConfigError` (bad options, thrown only from `createBroker`), `BrokerArgumentError`
(bad per-call arguments), `BrokerError` (genuine runtime failure, e.g. Redis/script errors or
unexpected script replies). Ordinary admission/resolution denials are **not** errors — they are
returned as `{ allowed: false, reason }` / `{ added: false, reason }` discriminated unions.

## 3. Core Redis-backed operations

All Lua scripts live inline as template strings next to the TypeScript that calls them
(`defineScript`/`runScript` in `src/redis/script.ts`), not in separate `.lua` files. There is
exactly one script per atomic operation; no script is duplicated.

| Operation | File | Script? | Keys touched |
|---|---|---|---|
| Admission (`requestPermission`) | `src/admission/request-permission.ts` | Yes, 7 KEYS | agent hash, budget pool, new reservation hash, expiring-reservations ZSET, concurrency counter, circuit failure ZSET, circuit state string |
| Resolution (`reportOutcome` → `resolveReservation`) | `src/admission/resolve-reservation.ts` | Yes, 6 KEYS | reservation hash, budget pool, concurrency counter, expiring-reservations ZSET, circuit failure ZSET, circuit state |
| Lazy cleanup sweep | `src/admission/cleanup.ts` | Calls `resolveReservation` per candidate (no separate script) | reads expiring ZSET via `ZRANGEBYSCORE`, delegates to resolution script |
| Register root agent | `src/agents/register.ts` | No — uses `MULTI`/`EXEC` (HSET + PEXPIRE + conditional `SET ... NX`) | agent hash, budget pool |
| Register child agent | `src/agents/register-child.ts` | Yes, 2 KEYS | parent agent hash (read), new child agent hash (write) |
| Deregister | `src/agents/deregister.ts` | No — single `DEL` | agent hash |
| Add budget | `src/budget/add-budget.ts` | Yes, 1 KEY | budget pool |

**Key construction** (`src/redis/keys.ts`) is centralized in one module and is the single source
of truth for Redis key names. Caller-supplied strings (`target`, `budgetKey`) are length-prefixed
(`"${value.length}:${value}"`) specifically so that two different `(a, b)` pairs can never collide
by concatenation ambiguity — this is called out as "Invariant 13" in both `keys.ts` and
`request-permission.ts`. Any Python port must reproduce this exact prefixing scheme byte-for-byte,
or cross-language key compatibility breaks silently.

### 3.1 `requestPermission` execution path

Order of checks inside the Lua script (documented in the script's own comment block, lines
37–88 of `request-permission.ts`): agent existence → circuit state (open/probe/closed) →
budget → concurrency. Nothing is written on any denial path. On admission, the script writes the
reservation hash, decrements budget, increments concurrency, schedules the reservation's expiry
in the `reservations:expiring` ZSET, and refreshes the agent's heartbeat/TTL — all inside one
`EVALSHA`/`EVAL`. The caller side (`request-permission.ts`, TypeScript) first calls
`sweepExpiredReservations` (lazy cleanup, bounded to 5 candidates per call), then reads the
agent's `budgetKey` with a plain `HGET` (safe to do outside the script per ADR: `budgetKey` is
immutable once set — ADR-0024), then invokes the script with a fresh UUID reservation ID and a
caller-generated random draw (`Math.random()`) used for circuit-breaker probe selection.

Circuit breaker semantics: a sliding-window failure count, trimmed via `ZREMRANGEBYSCORE` and
read via `ZCARD` on every admission call (never cached). `state == 'open'` is checked before the
fresh count — a long-open circuit does not silently reopen-eligible just because the window aged
below `hardThreshold`; recovery is only via a successful probe call (one admitted through normal
budget/concurrency checks, flagged `isProbe`). Soft threshold admits normally but attaches
`retryAfter` backpressure.

### 3.2 `resolveReservation` / resolution lifecycle

This is the **single** script used both by explicit `reportOutcome` calls and by the lazy
cleanup sweep — not two independently-written scripts. Idempotency (`resolved` flag, checked
and set atomically inside the script) is therefore a single guarantee that automatically covers
races between `reportOutcome` and cleanup racing the same reservation, rather than two guarantees
that would need to agree with each other.

Refund formula (ADR-0002): if `actualCost` was given, refund `estimatedCost - actualCost`
(can be negative, i.e. a top-up charge, if the actual cost exceeded the estimate); if not given
and `success` is true, refund `0` and set `costUnknown`; if not given and `success` is false,
refund the full `estimatedCost`. `poolMissing` is reported (not thrown) if the budget pool key
no longer exists when a refund is due — the reservation still resolves and concurrency is still
released.

Cleanup-vs-reportOutcome distinction: cleanup always calls with `feedsCircuit: false` — an
abandoned/crashed-caller reservation is evidence about the *caller*, never about the *target*,
so it must never count toward that target's circuit-breaker window (explicit in the code
comments, not merely in a doc).

Circuit transitions inside this script: a retryable failure is written into the failure ZSET and
trimmed; if the fresh count crosses `hardThreshold` and the circuit is not already open, it flips
to `'open'` here (not deferred to the next `requestPermission` call) — and fires
`onCircuitStateChange`. A successful probe resolution (`isProbe && success`) closes the circuit
and clears the failure window.

### 3.3 Queue mode (`src/admission/queue.ts`)

Pure client-side retry wrapper around `requestPermission` — no separate Lua script, no change to
admission correctness. Exponential backoff, base 50 ms, cap 1,000 ms, ±20% jitter. Only
`"unknown_agent"` is treated as non-queueable (queuing on it would poll pointlessly since nothing
about that outcome changes with time). Supports `AbortSignal`: checked at the top of every poll
iteration and also races the in-flight sleep, so an abort interrupts promptly rather than waiting
out the current backoff.

## 4. Failure handling

- **Redis unavailability** (`src/redis/unavailable.ts`, `isRedisUnavailableError`): narrow,
  explicit detection — `MaxRetriesPerRequestError` by name, known Node socket error codes
  (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EHOSTUNREACH`, `ECONNRESET`) by `.code` or message
  substring, and a short list of ioredis message patterns. This is deliberately narrow so that a
  script bug or malformed reply is never miscategorized as "Redis unreachable" and silently
  swallowed by the `onRedisUnavailable` fallback path.
- `onRedisUnavailable: "deny"` (default) — Redis outage during `requestPermission` surfaces as
  `{ allowed: false, reason: "redis_unavailable" }`; during `reportOutcome`, throws `BrokerError`.
- `onRedisUnavailable: "allow"` — `requestPermission` returns `{ allowed: true, reservationId:
  null, degraded: true }` (no budget/concurrency/circuit state touched at all); `reportOutcome`
  with that reservation ID is a defined, Redis-free no-op (`degraded: true` result) — this is the
  one case where `reportOutcome(null)` is explicitly meaningful rather than a validation error.
- **Hooks never affect broker behavior**: `fireHook` (`src/hooks/fire.ts`) swallows all hook
  exceptions and rejected promises; hooks are fire-and-forget, not awaited by callers.

## 5. Existing test suite

- 8 unit test files, 88 tests, all pass in this environment with no Redis
  (`npm run test:unit`, verified during this audit).
- 19 integration test files under `test/integration/`, covering: broker public API, register,
  register-child, deregister, add-budget, report-outcome, request-permission, queue-mode (+
  contention + abort), cleanup, hooks, redis-unavailable, redis-infrastructure, script internals,
  cross-process harness, and three dedicated failure-mode suites (`budget-contention`,
  `correlated-retries`, `depth-spoofing`).
- Cross-process testing is a first-class, existing pattern: `test/helpers/harness.ts` forks real
  child processes (`node:child_process.fork`, running `worker.ts` unbuilt via `tsx`) and
  coordinates them over IPC — this is not something the Python port needs to invent, it already
  exists for TypeScript-vs-TypeScript multi-process contention tests and is a direct model for
  cross-language tests in Milestone 5.
- Integration tests require a real Redis on `redis://localhost:6379/15` (`TEST_REDIS_URL`
  override available) and **intentionally fail, not skip**, if Redis is unreachable
  (`test/helpers/redis.ts` throws with an explicit message rather than silently skipping).
- See `BASELINE.md` for this audit's actual run results.

## 6. Notable design decisions already recorded (ADR log, `docs/adr/`)

26 ADRs already exist and are directly relevant to the Python port's design, in particular:
ADR-0001 (reservation TTL / lazy cleanup, not a background timer), ADR-0002 (refund formula),
ADR-0003 (budget pool deletion handling), ADR-0006 (library never owns/creates a Redis
connection — callers always pass one in), ADR-0008 (length-prefixed key segments), ADR-0010
(single-probe circuit recovery), ADR-0023 (single combined admission script), ADR-0024
(immutable identity fields), ADR-0025 (additive-only budget). The Python port should extend this
ADR log for any genuinely new cross-language decisions rather than re-litigating settled ones.

## 7. What does *not* exist (do not invent)

- No separate `.lua` files — scripts are inline. A Python port can either embed the same script
  text inline, or extract both languages' scripts to a shared location (see `ARCHITECTURE.md`
  for the recommendation).
- No background/timer-driven cleanup process — cleanup is purely lazy, triggered from inside
  `requestPermission` (ADR-0001). A Python ögport must not add a background thread/task for this
  unless explicitly asked; doing so would be a behavioral divergence from the documented
  contract, not a neutral implementation detail.
- No rate limiting beyond the circuit breaker and concurrency cap (ADR-0022: rolling-window rate
  limiting was explicitly deferred, not implemented).
- No provider abstraction (ADR-0004) — `target` is an opaque string (ADR-0011), not a structured
  provider/model object.
- No cross-instance/cross-broker-config sharing mechanism beyond "both point at the same Redis
  keys" (ADR-0016).
