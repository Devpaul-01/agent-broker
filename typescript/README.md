# agent-broker (TypeScript)

**A Redis-backed admission gate for multi-process agent and LLM-calling systems.** This is the
TypeScript implementation, published on npm as [`agent-broker`](https://www.npmjs.com/package/agent-broker).
A Python implementation of the same library lives in [`../python/`](../python/) (not yet
published); both coordinate through the same Redis data model.

`agent-broker` answers *"is this call allowed to happen right now?"*, accounting for shared
budget, delegation depth, in-flight concurrency, and recent failure history against a target. It
never makes the call for you: you ask before, you report after.

The project overview, the problems it solves, and the engineering highlights are in the
[root README](../README.md). The design is in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## Install

```bash
npm install agent-broker ioredis
```

Requires Node.js 22+ and a reachable Redis. `ioredis` (`^5` or `^6`) is a peer dependency: you
create the client and pass it in; the library never owns a connection.

## Use

```ts
import { createBroker } from "agent-broker";
import { Redis } from "ioredis";

const broker = createBroker({ redis: new Redis(process.env.REDIS_URL) });

const root = await broker.register({ budgetKey: "user-123", initialBudget: 5000 });

const decision = await broker.requestPermission({
  agentId: root.agentId,
  target: "groq:llama-3.3-70b-versatile",
  estimatedCost: 800,
});
if (!decision.allowed) throw new Error(`denied: ${decision.reason}`);

// ... make your real call ...

await broker.reportOutcome({
  reservationId: decision.reservationId,
  success: true,
  actualCost: 743,
});
```

## API

Everything is exported from [`src/index.ts`](src/index.ts). The `Broker` returned by
`createBroker(options)` has:

| Method | Purpose |
|---|---|
| `register({ budgetKey?, initialBudget? })` | Register a root agent (and create its budget pool on first use). |
| `register({ parentId })` | Register a child; depth, root and budget key are broker-derived. Returns a `RegisterDenial` (`depth_exceeded` / `unknown_agent`) instead of throwing. |
| `requestPermission(input, queueOptions?)` | Atomic admission. Returns `Admitted` or `Denied`. Pass `{ mode: "queue", queueTimeout, signal? }` to wait instead of being denied. |
| `reportOutcome({ reservationId, success, actualCost?, retryable? })` | Resolve a reservation. `retryable` is required when `success` is `false`. |
| `deregister(agentId)` | Remove an agent identity immediately (otherwise it expires by TTL). |
| `addBudget(budgetKey, amount)` | Additive top-up of an existing pool. |

Configuration (limits, TTLs, circuit breaker, `onRedisUnavailable`, hooks) is documented in the
[root README](../README.md#configuration). Unexpected conditions throw `BrokerError`,
`BrokerConfigError` or `BrokerArgumentError`; expected outcomes such as a denial are returned,
not thrown.

## Develop and test

Run from this directory.

```bash
npm ci
npm run typecheck
npm run test:unit          # no Redis needed
npm run redis:up           # redis:7-alpine via docker compose
npm run test:integration   # real Redis, including the cross-process harness
npm run build              # tsc -p tsconfig.build.json -> dist/
npm run redis:down
```

Integration tests use `redis://localhost:6379/15` (override with `TEST_REDIS_URL`) and flush that
database. The cross-language tests that exercise this package against the Python one are in
[`../test/cross-language/`](../test/cross-language/). Measurement experiments and their reports
are in [`measurement/`](measurement/RESULTS_SUMMARY.md).
