# Architecture

This document describes `agent-broker` as it exists today — the public API, the data model, the invariants it guarantees, and the failure behavior you should expect. It supersedes the original design handoff document for anything the two disagree on (notably, circuit-breaker recovery — see [ADR-0010](adr/0010-single-probe-circuit-recovery.md)). The original handoff document is kept in the repository as a historical design record; read it if you want the full reasoning trail behind decisions, including rejected alternatives, from the initial design session.

---

## 1. What this library is

An in-process TypeScript library, backed by Redis, that answers one question safely under real multi-process concurrency: *"is this call allowed to happen right now?"* — given a shared budget, a shared delegation-depth limit, a shared concurrency limit, and shared recent-failure history for the thing you're about to call.

It coordinates **three independent concerns**, each real and each insufficient on its own:

- **Budget.** A reservation-based system: `estimatedCost` is atomically checked-and-reserved at admission time, then reconciled against `actualCost` once you report back.
- **Delegation depth.** A tree of agents (`register`/`registerChild`), with depth computed and enforced centrally, never trusted from caller self-report.
- **Retry/failure correlation.** A cross-process circuit breaker per `target`, so one process's failures inform every other process's admission decisions against that same target.

It does not execute downstream calls, does not know what a "prompt" or a "model" is beyond an opaque `target` string, and is not a security boundary against a fully adversarial caller. See [Section 8, Trust and security](#8-trust-and-security-boundaries).

## 2. The core problem, restated once

Three independent processes retrying twice each, after a shared downstream target starts failing, each look completely reasonable in isolation — "I only retried twice." In aggregate, the target just received six near-simultaneous retries with no single process aware the other two existed. The same shape of problem recurs for budget (two processes both see "enough budget" a moment before either spends it) and for delegation depth (no single node in a fan-out tree can see how deep the whole tree has gotten). All three need a shared point of visibility that no single process can provide on its own. That shared point is Redis, and this library is the coordination logic built on top of it.

## 3. Request lifecycle

```
caller → requestPermission({ agentId, target, estimatedCost, ttl?, mode?, queueTimeout? })
  → one atomic Lua script checks, in order: agent existence, circuit-breaker state,
    budget, concurrency
  → on success: reserves estimatedCost, creates a reservation record, increments the
    concurrency counter, refreshes the agent's heartbeat TTL
  → returns { allowed: true, reservationId, retryAfter? }
    or { allowed: false, reason }

caller → (performs the actual downstream call — entirely outside this library)

caller → reportOutcome({ reservationId, success, actualCost?, retryable? })
  → one atomic Lua script reconciles the reservation: refunds/adjusts the budget pool,
    releases the concurrency slot, and (if retryable: true and success: false) feeds
    the shared circuit-breaker window
  → returns { allowed: true, costUnknown, poolMissing } or a denial
```

The broker's knowledge of "did this succeed" is entirely second-hand — it never sees a response or a status code, only what `reportOutcome` tells it. This is a deliberate, accepted boundary; see [Section 8](#8-trust-and-security-boundaries).

## 4. Agent model

An agent is a node in a delegation tree: a broker-issued ID, a depth, a parent reference (or none, if root), a `rootId`, and a `budgetKey`. Depth, `rootId`, and `budgetKey` are always computed by the broker from its own stored state about the parent — never accepted as raw values a caller asserts about itself. A caller may reference existing state by ID (`register({ parentId })`); it may never supply derived facts about that state.

`budgetKey` defaults to the root's own broker-issued ID (private by default). Explicit cross-root sharing requires passing the same string at each root's registration.

Registrations carry a TTL, refreshed on every `requestPermission`/`reportOutcome` call from that agent (heartbeat-on-call). A crashed or idle agent simply stops heartbeating and expires — this is the actual safety net. An optional `deregister()` is a courtesy for orderly shutdown, not a substitute for TTL expiry, since no code can run after a hard kill.

## 5. Budget mechanics

Direct deduction (decrement only after a call completes) was considered and rejected: two concurrent calls could both pass a "do we have enough budget" check before either deducts, and the pool over-admits by up to the sum of both calls. **Reservation** — atomically check-and-decrement the *estimated* cost at admission, reconcile against *actual* cost afterward — is the only one of the two that actually closes that race.

Reconciliation refund formula (see [ADR-0002](adr/0002-reportoutcome-refund-formula.md) for the full table and the correction made during design):

```
refund = estimatedCost - actualCost   (whenever actualCost is given, regardless of success)
refund = 0, costUnknown: true          (success, no actualCost given)
refund = estimatedCost                 (failure, no actualCost given — full refund)
```

**A pool can go negative via reconciliation, when `actualCost > estimatedCost`.** This is distinct from, and weaker than, the admission-time guarantee: admission can never push the pool negative; reconciliation can, because you cannot un-generate tokens that were already produced. The overrun is bounded to roughly one call's estimation error and self-corrects — the next `requestPermission` against that pool sees the reduced balance and denies accordingly.

## 6. Concurrency limiting

A separate mechanism from depth — depth constrains tree *shape* (how many delegation levels deep), not how many calls are happening *simultaneously*. A tree capped at depth 3 can still have thousands of depth-1 agents all calling at once; nothing about depth prevents that. Tracked per `(target, budgetKey)` pair, enforced as an atomic increment/decrement inside the same combined admission script as the budget check — never a separate round trip, which would reopen the exact race this design exists to close.

## 7. Circuit breaker

Per-`target` sliding-window failure tracking via a Redis sorted set (`member = reservationId`, `score = timestamp`), trimmed with `ZREMRANGEBYSCORE` on every check to avoid fixed-window boundary artifacts. Only failures explicitly reported as `retryable: true` feed this window — a caller's own non-retryable bugs (bad API key, malformed request) must never be able to trip a healthy target's circuit for every other caller sharing it. This distinction (ADR-10 in the original handoff document's ADR log) is load-bearing: conflating retryable and non-retryable failures into one counter would let an unrelated caller-side bug falsely trip the circuit for a target that's actually healthy.

**Two states, not three:** `closed` and `open`. While open, a small configurable fraction of calls (`probeRate`) are still admitted as probes — without this, no success could ever be reported, and the system could never learn the target has recovered. **One successful probe closes the circuit immediately** and clears the failure window; this is a deliberate simplification of the original three-state `closed/open/recovering` design — see [ADR-0010](adr/0010-single-probe-circuit-recovery.md) for the reasoning and the accepted tradeoff.

The probe-slot draw happens inside the same atomic script as everything else — a separate read-then-decide step would let concurrent callers all read the same pre-decision state and all be admitted as probes simultaneously, breaking the "only a trickle" guarantee at exactly the moment the target is most fragile.

## 8. Trust and security boundaries

As an in-process library, the consuming application fundamentally controls its own inputs. This library prevents *accidental and architectural* bypass, not deliberate evasion by a fully uncooperative caller. Protected: agent identity/depth/root spoofing (always broker-derived), ordinary concurrent overspend, accidental unbounded recursion. Not protected: a caller that avoids the delegation API entirely to dodge depth limits, a caller that misreports `retryable`/`actualCost`/`success` (never independently verifiable, since the broker never observes the real downstream call), a caller that never calls `reportOutcome` at all (bounded by TTL, not eliminated). None of this is an oversight — see the README's [Trust model](../README.md#trust-model) section and the original handoff document's Section 17 for the full discussion.

## 9. Failure model

| Scenario | Behavior |
|---|---|
| Redis unreachable | Governed by `onRedisUnavailable` (`'deny'` default, `'allow'` opt-in). Never silently treated as success. |
| Caller crashes after admission, before reporting | Indistinguishable from "crashed mid-call" — handled identically via reservation TTL expiry, release is automatic. |
| Budget pool deleted externally | Refund is skipped (no silent recreation), reservation still resolves fully, response includes `poolMissing: true`. See [ADR-0003](adr/0003-budget-pool-deletion-handling.md). |
| Network timeout ambiguity (request never arrived vs. response lost) | Not solved — this is a fundamental, general distributed-systems limitation. Bounded via reservation TTL, not eliminated. |
| Reservation never resolved at all | Lazily swept on a later, unrelated `requestPermission` call once logically expired (see [ADR-0001](adr/0001-reservation-ttl-and-lazy-cleanup.md)); resolved as a full refund, and explicitly excluded from circuit-breaker accounting, since an abandoned reservation is evidence about the *caller* crashing, not the *target* failing. |

## 10. Redis data model

| Key | Type | Purpose |
|---|---|---|
| `agent:{agentId}` | Hash, TTL | Identity, depth, parent, root, budget key, heartbeat |
| `budget:{seg(budgetKey)}` | String (integer), no TTL | Remaining lifetime budget for the pool |
| `reservation:{reservationId}` | Hash, TTL = callerTtl + grace | Reservation data, kept alive past logical expiry for late reconciliation |
| `reservations:expiring` | Sorted set, no TTL | One set total; member = reservationId, score = logical expiry; drives lazy cleanup |
| `concurrency:{seg(target)}{seg(budgetKey)}` | String (integer) | In-flight call count for this pair |
| `circuit:{seg(target)}` | Sorted set | Sliding-window retryable-failure timestamps |
| `circuit:{seg(target)}:state` | String | `"open"` or absent (treated as closed) |

`seg()` length-prefixes every caller-supplied string segment before composing a multi-part key — see [ADR-0008](adr/0008-length-prefixed-key-segments.md) for why a plain `:`-join would let two unrelated `(target, budgetKey)` pairs collide on one counter.

## 11. Atomicity

Any operation that reads shared Redis state and then conditionally writes based on that read is one atomic Lua script (`EVAL`/`EVALSHA`), never two round trips — between any two round trips, another process can interleave. This governs the three core scripts in this library:

- **`REQUEST_PERMISSION`** — agent existence, circuit state (including atomic probe-slot allocation), budget check-and-reserve, concurrency check-and-increment, all in one script.
- **`REGISTER_CHILD`** — parent existence/depth lookup and child creation in one script, closing the race where a parent could expire between a separate read and write.
- **`RESOLVE_RESERVATION`** — the single resolution path shared by both `reportOutcome` and lazy cleanup, so there is exactly one idempotency check (`resolved` flag) to get right, not two independently-written ones that must agree with each other.

## 12. Configuration

All `createBroker()` options are validated once and frozen for the instance's lifetime — see [ADR-0007](adr/0007-immutable-broker-config.md) for why no runtime-mutation path exists. The Redis connection itself is always caller-supplied; the library never creates or manages one — see [ADR-0006](adr/0006-no-owned-redis-connection.md).

## 13. Observability

Four hooks (`onDecision`, `onOutcome`, `onCircuitStateChange`, `onCleanup`), fire-and-forget by design — a throwing or slow hook can never affect the broker's own result or latency. See [ADR-0009](adr/0009-fire-and-forget-hooks.md). This is deliberately not a metrics platform or a dashboard; see [`positioning.md`](positioning.md) for the honest state of observability maturity and what's planned.

## 14. Testing

Layered by what actually needs Redis:

- **Pure logic** (input validation, return shapes) — no Redis, mocked or omitted.
- **Redis integration** (budget, concurrency, circuit breaker, atomicity) — real local Redis via Docker, never a mock. The entire value of this library rests on true atomic behavior under real concurrency, which a mock of the exact thing being verified cannot faithfully reproduce.
- **Cross-process** (the tests proving the actual core claim) — genuinely separate OS processes via `child_process.fork()`, not `Worker` threads or same-process `Promise.all` tricks, since those can share memory in ways that would make a real coordination bug invisible. See [ADR-0005](adr/0005-cross-process-test-harness.md).

## 15. What this is not

Not an LLM/AI gateway in the Portkey/LiteLLM/Cloudflare-AI-Gateway sense — those sit in the request path and route/cache/proxy the actual call. This library never touches the provider. Not a general-purpose rate limiter — the three mechanisms here are specific to the failure shapes this project targets, not a general traffic-shaping toolkit. Not an LLM SDK — no concept of prompts, models-as-objects, or provider-specific request/response shapes. See [`positioning.md`](positioning.md) for the full, honest comparison against the current AI-gateway landscape, including where this library's primitives already map onto real agent-delegation patterns and what's still missing before an agent-framework team would adopt it as-is.
