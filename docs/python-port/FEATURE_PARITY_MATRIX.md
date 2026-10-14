# Feature Parity Matrix

Baseline: commit `36f7674`. Status values use only: `Not started`, `Planned`, `In progress`,
`Implemented (untested)`, `Implemented (unit-tested)`, `Implemented (integration-tested)`,
`Blocked`. Nothing in this table may read as more complete than what has actually been built and
verified — see `docs/python-port/BASELINE.md` for why integration-level verification is currently
blocked in this environment.

| Feature | TypeScript implementation | Existing TS tests | Python implementation required | Shared protocol requirement | Validation strategy | Status |
|---|---|---|---|---|---|---|
| `createBroker` / config resolution | `src/config/index.ts` | `test/unit/config.test.ts` (17) | Yes — idiomatic constructor, same defaults and cross-field validation (`defaultReservationTtl <= maxReservationTtl`, `agentTtl >= maxReservationTtl`, `hardThreshold > softThreshold`, `0 < probeRate <= 1`) | No (local only) | Unit tests mirroring each TS validation case | Not started |
| `register()` — root agent | `src/agents/register.ts` | `test/integration/register.test.ts` | Yes | Yes — agent hash fields/TTL, budget pool `SET NX` semantics must match | Integration test against real Redis; cross-language: TS registers, Python reads and vice versa | Not started |
| `register()` — child agent | `src/agents/register-child.ts` | `test/integration/register-child.test.ts`, `test/integration/failure-modes/depth-spoofing.test.ts` | Yes, including the atomic Lua script | Yes — must reuse or byte-identically reproduce `REGISTER_CHILD` script | Integration + depth-exceeded adversarial test | Not started |
| `requestPermission()` core admission | `src/admission/request-permission.ts` | `test/integration/request-permission.test.ts`, `test/unit/request-permission-validation.test.ts` (13) | Yes, full atomic script reuse/equivalence | Yes — this is the central shared-protocol surface | Integration tests + cross-language concurrent-admission tests (Milestone 5) | Not started |
| Queue mode (`requestPermission` + `queueOptions`) | `src/admission/queue.ts` | `test/integration/queue-mode.test.ts`, `queue-mode-contention.test.ts`, `queue-mode-abort.test.ts`, `test/unit/queue-validation.test.ts` | Yes — backoff/jitter formula, cancellation semantics (Python: `asyncio.CancelledError`/cooperative cancellation token, to be decided in Milestone 1 API design) | No (client-side only; same underlying `requestPermission` calls are shared) | Unit (backoff math, validation) + integration (contention, abort) | Not started |
| `reportOutcome()` | `src/admission/report-outcome.ts` | `test/integration/report-outcome.test.ts`, `test/unit/report-outcome-validation.test.ts` (12) | Yes | Yes — refund formula and resolution script must match exactly | Integration tests incl. `null` degraded no-op path | Not started |
| Lazy cleanup sweep | `src/admission/cleanup.ts` | `test/integration/cleanup.test.ts` | Yes — triggered from inside `requestPermission`, not a background task | Yes — reads/writes the same `reservations:expiring` ZSET; must be cross-language-safe (TS process can clean up a Python-created reservation and vice versa) | Integration + cross-language cleanup test (Milestone 5 explicitly calls this out) | Not started |
| `deregister()` | `src/agents/deregister.ts` | `test/integration/deregister.test.ts` | Yes (trivial — single DEL) | Yes (same key) | Integration test | Not started |
| `addBudget()` | `src/budget/add-budget.ts` | `test/integration/add-budget.test.ts` | Yes, including the atomic Lua script | Yes | Integration test, incl. unknown-budget denial | Not started |
| Circuit breaker (soft/hard threshold, sliding window, single-probe recovery) | Inline in `request-permission.ts` + `resolve-reservation.ts` scripts | Covered across `request-permission.test.ts`, `report-outcome.test.ts`, `hooks.test.ts` | Yes — no separate script to port; it's embedded in the two scripts above | Yes | Integration tests for open/probe/closed transitions; cross-language: one language's failures open the circuit, the other observes `circuit_open` | Not started |
| Redis-unavailable handling (`onRedisUnavailable: deny\|allow`) | `src/redis/unavailable.ts` + call sites | `test/integration/redis-unavailable.test.ts`, `test/unit/redis-unavailable-detection.test.ts` (12) | Yes — Python needs its own narrow "is this connection-level" detection for its Redis client (error types differ from ioredis's) | No (detection logic is language-specific; externally observable behavior must match) | Unit tests for detection + integration test that kills Redis mid-call | Not started |
| Hooks (`onDecision`, `onOutcome`, `onCircuitStateChange`, `onCleanup`) | `src/hooks/fire.ts` + call sites | `test/integration/hooks.test.ts` | Yes — Python equivalent (callbacks or an async-friendly mechanism), fire-and-forget, exceptions swallowed | No | Unit (swallow behavior) + integration (fired on real events) | Not started |
| Error classes (`BrokerConfigError`, `BrokerArgumentError`, `BrokerError`) | `src/errors/index.ts` | Covered implicitly across validation tests | Yes — idiomatic Python exception hierarchy with equivalent semantics | No | Unit tests | Not started |
| Key construction / length-prefixing scheme | `src/redis/keys.ts` | `test/unit/keys.test.ts` (3) | Yes — must be byte-identical to TS output for any shared key | Yes, critical | Unit tests comparing against literal expected strings + a cross-language test asserting TS and Python produce identical keys for identical inputs | Not started |
| Script loader (EVALSHA w/ NOSCRIPT→EVAL fallback) | `src/redis/script.ts` | `test/integration/script.test.ts` | Yes — Python client's equivalent eval/evalsha fallback | Yes if scripts are shared | Integration test incl. forced `SCRIPT FLUSH` | Not started |
| Cross-process / multi-worker contention harness | `test/helpers/harness.ts`, `worker.ts` | Used by `cross-process-harness.test.ts`, `budget-contention.test.ts`, `correlated-retries.test.ts` | A Python equivalent (multiprocessing-based worker harness) is needed for Milestone 3/5 concurrency tests, and ideally a **cross-language** variant (Python harness spawning a Node worker or vice versa) for Milestone 5 | N/A (test infra) | N/A | Not started |
| Rolling-window rate limiting beyond circuit breaker | Explicitly **not implemented** (ADR-0022: deferred) | N/A | Not applicable | N/A | N/A | Not applicable — do not implement in Python either; would be a divergence from the documented TS contract |
| Provider/model abstraction | Explicitly **not implemented** (ADR-0004); `target` is an opaque string (ADR-0011) | N/A | Not applicable | N/A | N/A | Not applicable |
| Background/timer-driven cleanup | Explicitly **not implemented** (ADR-0001: lazy only) | N/A | Not applicable — Python must also use lazy, in-call cleanup | N/A | N/A | Not applicable |

## Reading this table

- "Not started" is the honest status for every implementation row right now. No Python code has
  been written yet — Milestone 0 is audit-only, as required by the prompt's own acceptance
  criteria ("Do not start the implementation until this milestone is complete").
- Rows marked "Not applicable" are features someone might assume exist (rate limiting beyond the
  circuit breaker, provider abstraction) but that the TypeScript implementation deliberately does
  not have, per its own ADR log. The Python port must not add them as "bonus" features — that
  would itself be a parity mismatch in the other direction.
- "Shared protocol requirement: Yes" rows are the ones where TypeScript and Python must agree on
  wire-level Redis behavior (key names, script semantics, serialization). These are the
  highest-risk, highest-priority rows for Milestone 2's cross-compatibility work.
