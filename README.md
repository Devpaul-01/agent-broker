# agent-broker

**A Redis-backed coordination gate for multi-process agent and LLM-calling systems.**

`agent-broker` answers one question, correctly, under real concurrency, across real process boundaries: *"Is this call allowed to happen right now?"* — accounting for shared budget, delegation depth, in-flight concurrency, and recent failure history against the target you're about to call.

It does **not** make the call for you. It is a pure permission gate: you ask before, you report after, you stay in full control of how the actual request happens.

```
your process → broker.requestPermission(...) → { allowed: true, reservationId }
your process → (you make the real call yourself, however you want)
your process → broker.reportOutcome({ reservationId, success, actualCost })
```

---

## Why this exists

If you run more than one process — or more than one agent, or more than one user session — against a shared downstream resource (an LLM provider, a rate-limited API, anything with a cost and a failure mode), you eventually hit three problems that don't show up until you're running at real concurrency:

1. **Correlated retries.** Every process retries sanely on its own. Collectively, ten processes retrying twice each just sent a downstream service a burst of 20 near-simultaneous requests it had no way to anticipate.
2. **Budget races.** Two processes both check "do I have enough budget left?" a few milliseconds apart. Both see yes. Both spend. The shared pool goes negative, and neither process did anything wrong in isolation.
3. **Unbounded recursive delegation.** An agent spawns a sub-agent, which spawns another. Nothing about any single node in that tree can see or limit how deep the *whole tree* has gotten — depth is a property of the tree, not of any one process.

Each of these looks fine from inside any single process and only becomes a problem in aggregate — which means no single process can fix it by being better-written. You need a shared point of coordination. `agent-broker` is that point, using Redis as the thing every process actually has in common.

## What this is not

To save you a wrong assumption: this is **not** an LLM gateway in the sense of Portkey, LiteLLM, or Cloudflare AI Gateway. Those sit *in* the request path — they route, cache, and proxy the actual call to the provider. `agent-broker` never touches the provider at all. It solves a narrower, different problem: cross-process safety coordination, not request routing. See [`docs/agent-broker-architecture.md`](docs/agent-broker-architecture.md) for the full boundary discussion, and [`docs/positioning.md`](docs/positioning.md) for how this fits (and doesn't yet fit) into agent-framework workflows.

It is also not a security boundary against a malicious caller. It protects against *accidental* and *architectural* bypass — not against a process owner willing to lie to it. See [Trust model](#trust-model) below.

---

## Installation

```bash
npm install agent-broker ioredis
```

Requires Node.js 22 or later, and a reachable Redis instance (local, containerized, or managed).

`ioredis` is a peer dependency — you bring your own Redis connection; the library never manages one itself (see [ADR-0006](docs/adr/0006-no-owned-redis-connection.md)).

## Quick start

```ts
import { createBroker } from "agent-broker";
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const broker = createBroker({ redis });

// Register a root agent and fund its budget pool.
const root = await broker.register({ budgetKey: "user-123", initialBudget: 5000 });

// Before calling a downstream resource, ask permission.
const decision = await broker.requestPermission({
  agentId: root.agentId,
  target: "groq:llama-3.3-70b-versatile",
  estimatedCost: 800,
});

if (!decision.allowed) {
  // decision.reason: 'unknown_agent' | 'aborted' | 'budget_exceeded'
  //                | 'concurrency_exceeded' | 'circuit_open' | 'redis_unavailable' | 'queue_timeout'
  // ('aborted' and 'queue_timeout' only apply in queue mode — see "Queue mode" below.
  //  'depth_exceeded' is a register() reason, not a requestPermission() reason — see below.)
  throw new Error(`denied: ${decision.reason}`);
}

// Make your actual call however you normally would. agent-broker has no
// opinion about your SDK, your provider, or your prompt.
const response = await yourLLMClient.call(/* ... */);

// Report back so the reservation can be reconciled.
await broker.reportOutcome({
  reservationId: decision.reservationId,
  success: true,
  actualCost: response.usage.totalTokens,
});
```

### Delegating to a sub-agent

```ts
const child = await broker.register({ parentId: root.agentId });
// child.depth, child.rootId, child.budgetKey are all broker-derived —
// never something you pass in. See "Trust model" below for why.

if ("allowed" in child && child.allowed === false) {
  // child.reason === 'depth_exceeded' or 'unknown_agent'
}
```

### Handling a transient failure

```ts
await broker.reportOutcome({
  reservationId: decision.reservationId,
  success: false,
  retryable: true, // this failure counts toward shared circuit-breaker state
});
```

---

## Core concepts

| Concept | What it means here |
|---|---|
| **Agent** | A node in a delegation tree. Not a reasoning loop or a prompt — just an identity, a depth, a parent, and a budget key. Broker-issued, never caller-chosen. |
| **`target`** | An opaque string you choose to represent "which downstream thing is this." Convention: `provider:model` (e.g. `"anthropic:claude-opus"`). The broker doesn't parse it — it only groups shared state by it. |
| **`budgetKey`** | Scopes a shared spending pool. Defaults to the root agent's own ID (private by default). Pass the same key across unrelated roots to intentionally share a budget. |
| **Reservation** | A hold placed on `estimatedCost` at admission time, reconciled against `actualCost` once you report back. |
| **Circuit breaker** | Shared, cross-process failure tracking per `target`. Trips to `open` once recent `retryable: true` failures cross a threshold; recovers via a small trickle of probe calls. |

Full mechanics, invariants, and the reasoning behind each of these are in [`docs/agent-broker-architecture.md`](docs/agent-broker-architecture.md).

---

## Configuration

```ts
const broker = createBroker({
  redis,                                  // required — your own ioredis client
  maxDepth: 5,                            // delegation depth ceiling
  agentTtl: 3_600_000,                    // ms, how long an idle agent stays registered (must be >= maxReservationTtl)
  defaultReservationTtl: 30_000,          // ms, used when a call omits `ttl`
  maxReservationTtl: 300_000,             // ms, hard ceiling a caller's `ttl` cannot exceed
  concurrencyLimit: 10,                   // in-flight calls per (target, budgetKey) pair
  onRedisUnavailable: "deny",             // 'deny' | 'allow' — see "Failure behavior" below
  circuitBreaker: {
    softThreshold: 5,                     // failures before `retryAfter` backpressure appears
    hardThreshold: 20,                    // failures before the circuit opens
    windowMs: 60_000,                     // sliding window for failure counting
    probeRate: 0.1,                       // fraction of open-circuit calls admitted as recovery probes
  },
  hooks: {
    onDecision(event) {},                 // fires on every requestPermission outcome
    onOutcome(event) {},                  // fires on every reportOutcome call
    onCircuitStateChange(event) {},       // fires only on open/closed transitions
    onCleanup(event) {},                  // fires when a lazy sweep resolves an abandoned reservation
  },
});
```

All configuration is immutable for the lifetime of a broker instance. If you need different limits, construct a second broker instance rather than mutating this one — see [ADR-0007](docs/adr/0007-immutable-broker-config.md) for why.

## Failure behavior

If Redis is unreachable, `onRedisUnavailable` decides what happens, and it defaults to the conservative option:

- **`'deny'`** (default): calls are denied with `reason: 'redis_unavailable'`. The one moment coordination can't function is exactly the moment you don't want to silently lose the guarantees it provides.
- **`'allow'`**: calls are admitted without a reservation (`degraded: true`, `reservationId: null`). Pick this only if raw availability matters more than the coordination guarantees during an outage — this library will not make that tradeoff silently on your behalf.

See [`docs/agent-broker-architecture.md`](docs/agent-broker-architecture.md#12-failure-model) for the full breakdown of crash and timeout behavior.

## Queue mode

By default, a denied call is just denied (`mode: 'deny'`). If you'd rather wait for a slot/budget/recovery instead of handling the denial yourself:

```ts
await broker.requestPermission(
  { agentId, target, estimatedCost },
  { mode: "queue", queueTimeout: 10_000 },
);
```

This polls the same atomic admission path with backoff until admitted, `queueTimeout` elapses (`reason: 'queue_timeout'`), or the denial reason is one that waiting can never fix (`unknown_agent` returns immediately, not after a timeout). You can also pass an `AbortSignal` (`{ mode: "queue", signal }`) to cancel the wait externally; an aborted wait resolves with `reason: 'aborted'`.

---

## Trust model

This is an in-process library. The process that imports it fundamentally controls its own inputs. What `agent-broker` protects against, and what it explicitly does not, is worth stating plainly rather than overselling:

**Protected against:**
- A caller accidentally claiming a different agent identity, depth, parent, or root — impossible, since these are always broker-derived from stored state, never accepted as raw caller input.
- Ordinary concurrent overspend — closed via atomic check-and-reserve.
- Accidental unbounded recursion — closed via broker-enforced, registration-time depth checks.

**Not protected against (by design, not oversight):**
- A caller that simply doesn't use the delegation API honestly (e.g., registering a fresh root to "reset" its own depth rather than genuinely delegating). Nothing requires a caller to delegate through the API in the first place.
- A caller that misreports `retryable`, `actualCost`, or `success` on `reportOutcome` — the broker never observes your actual downstream call or response, so it has no independent way to verify what you tell it.
- A caller that never calls `reportOutcome` at all — bounded by reservation TTL, not eliminated.

If you need protection against a genuinely adversarial, non-cooperating caller, you need a boundary this library doesn't provide (e.g., a service-mode deployment with its own auth). See [`docs/agent-broker-architecture.md`](docs/agent-broker-architecture.md#17-security-and-trust-boundaries).

---

## Project status and roadmap

This library solves cross-process budget, depth, and retry-storm coordination, and that core is tested under real multi-process concurrency (see [`docs/agent-broker-architecture.md#14-testing-architecture`](docs/agent-broker-architecture.md#14-testing-architecture)). It does **not** yet have agent-aware call metadata, framework-protocol adapters (MCP or similar), or a built-in observability surface beyond the four hooks above — these are intentional, not finished, and the plan for closing that gap honestly (including why it's a layer on top rather than a rewrite) is in [`docs/positioning.md`](docs/positioning.md). If you're evaluating this for an agent-framework integration today, read that document first.

## Documentation

- [`docs/agent-broker-architecture.md`](docs/agent-broker-architecture.md) — full design rationale, invariants, Redis data model, failure model, and the ADR log
- [`docs/positioning.md`](docs/positioning.md) — honest take on what this is, what it isn't yet, and the intended path to agent-framework integration
- [`docs/adr/`](docs/adr/) — architecture decision records, including rejected alternatives
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, test commands, and PR expectations
- [`RELEASE.md`](RELEASE.md) — versioning policy and the release procedure
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes, oldest-unreleased-first

## License

MIT © see [LICENSE](LICENSE)
