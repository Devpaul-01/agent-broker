# agent-broker

> ⚠️ **Status: Under active development.** This project is not finished. The design is complete and documented, but the implementation is still being built. The API may change before a stable release.

`agent-broker` is an in-process TypeScript library that coordinates behavior across multiple independent processes (agent instances) that all call a shared downstream resource, such as an LLM provider. Redis is the shared state layer, so separate processes that know nothing about each other can still make coordinated decisions.

📐 **Read the full architecture and design rationale:** [docs/agent-broker-architecture.md](./docs/agent-broker-architecture.md)

---

## The problem

When multiple processes each handle retries, budgets, and concurrency on their own, each can look well-behaved in isolation while the aggregate behavior is not:

- **Correlated retries.** Three processes each retry twice against the same target. Each one looks reasonable alone, but together they send a burst the target cannot absorb.
- **Shared budget overspend.** Several processes check a shared budget at the same moment, all pass the check, and together overspend it.
- **Unbounded delegation.** Agents spawn sub-agents, which spawn more. No single node can see the depth of the whole tree.

`agent-broker` is the shared point of visibility that makes coordinated decisions possible.

## What it does

The broker is a **pure permission gate**. It never makes downstream calls itself. Your code asks for permission, makes its own call, and reports the outcome back.

It provides three mechanisms:

1. **Circuit breaking across processes.** A three-state breaker (closed, open, recovering) with probe-based recovery. Soft and hard thresholds apply coordinated backpressure to every caller against a target.
2. **Cost-based budgets with reservations.** Budget is checked and reserved atomically before a call, then reconciled against actual cost afterward. Concurrent callers cannot collectively overspend.
3. **Delegation depth limits.** Depth is computed by the broker from registered parent state. Callers cannot self-report or spoof it.

Concurrency limits are tracked separately, per `target` and `budgetKey`, with `deny` or `queue` modes.

## What it is not

- Not an agent framework. It has no concept of prompts, tasks, or reasoning.
- Not an LLM SDK or a provider abstraction.
- Not a general-purpose rate limiter or HTTP gateway.
- Not a security boundary against a fully malicious process owner. It prevents accidental and architectural bypasses. See the architecture doc for the full trust model.
- Not designed for sub-10ms operations. It is intended for LLM-call-scale latencies.

## Planned usage

This is the intended API. It is not yet implemented, and details may change.

```ts
import { createBroker } from 'agent-broker';

const broker = createBroker({
  redis: redisClient,            // you supply the connection
  maxDepth: 5,
  defaultReservationTtl: 30_000,
  maxReservationTtl: 300_000,
  onRedisUnavailable: 'deny',
  circuitBreaker: {
    softThreshold: 5,
    hardThreshold: 20,
    windowMs: 60_000,
    probeRate: 0.1,
  },
});

// Register a root agent with a shared budget
const root = await broker.register({ budgetKey: 'user-123', initialBudget: 5000 });

// Register a child (depth, rootId, and budgetKey are derived, never passed)
const child = await broker.register({ parentId: root.agentId });

// Ask permission before each attempt
const decision = await broker.requestPermission({
  agentId: child.agentId,
  target: 'groq:llama-3.3-70b-versatile',
  estimatedCost: 800,
  ttl: 15_000,
  mode: 'deny',
});

if (decision.allowed) {
  // ...make your own downstream call here...
  await broker.reportOutcome({
    reservationId: decision.reservationId,
    success: true,
    actualCost: 743,
  });
}
```

Denial is returned as `{ allowed: false, reason }`, not thrown. Reasons include `budget_exceeded`, `depth_exceeded`, `circuit_open`, `concurrency_limit`, and `coordination_unavailable`. Genuine errors, such as a misconfigured Redis connection, still throw.

## Design highlights

- **Redis is the only shared infrastructure.** Two processes pointed at the same Redis share state. Two apps pointed at different Redis instances share nothing.
- **Atomic admission.** All budget, concurrency, and circuit checks run in one Lua script, so no race can interleave between them.
- **Config is immutable per broker instance.** Different limits mean a different broker instance.
- **Unknown cost is explicit.** Pass `costUnknown: true` rather than a made-up number. Silent defaults would corrupt accounting.
- **Lazy reservation cleanup.** Expired reservations are cleaned up on the next touch, so no keyspace notifications or extra subscriber process are needed.

## Testing approach

- Budget, concurrency, and circuit logic is tested against a **real Redis instance**, not a mock. Mocks cannot reproduce real atomic behavior under concurrency.
- The core claims are proven with **cross-process tests** using `child_process.fork()`, so separate OS processes coordinate only through Redis.
- Three failure-mode tests cover correlated retries, budget contention, and recursive depth (including a spoofed-depth case).

## Roadmap

- [ ] Redis layer and Lua script loading
- [ ] Agent registration, delegation, and heartbeat/TTL
- [ ] Combined admission script (budget, concurrency, circuit breaker)
- [ ] Public API wiring
- [ ] Observability hooks
- [ ] Testing harness and cross-process failure-mode tests
- [ ] Stable release

## Documentation

- [Architecture & design handoff](./docs/agent-broker-architecture.md): the full design, rationale, rejected alternatives, invariants, and ADR log.

## License

TBD
