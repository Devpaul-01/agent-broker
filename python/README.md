# agent-broker (Python)

**A Redis-backed coordination gate for multi-process agent and LLM-calling systems — the Python
implementation.**

This is a genuine Python port of [Agent Broker](../README.md), the TypeScript library in
[`typescript/`](../typescript) at the root of this repository: real Python, built on
[`redis-py`](https://github.com/redis/redis-py),
not a wrapper that shells out to Node.js. No Node.js installation is required to use this
package. It answers the same question, under the same guarantees, across real process and
language boundaries: *"Is this call allowed to happen right now?"* — accounting for shared
budget, delegation depth, in-flight concurrency, and recent failure history against the target
you're about to call.

It does **not** make the call for you. It is a pure permission gate: you ask before, you make
the real call yourself, you report after.

```
your process → broker.request_permission(...) → Admitted(reservation_id=...)
your process → (you make the real call yourself, however you want)
your process → broker.report_outcome(ReportOutcomeInput(reservation_id=..., success=..., actual_cost=...))
```

This package implements the same coordination model as the TypeScript package, against the same
Redis data model — the two can coordinate through one shared Redis instance (see
[Interoperating with the TypeScript package](#interoperating-with-the-typescript-package)
below). For the broader "why does this exist" discussion, see the
[root README](../README.md#the-problem-and-what-the-library-does-about-it) and
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## Status

**Not yet published.** This package has no PyPI release; install it from this repository (see
below). It is feature-complete relative to the TypeScript package's public API: every operation
on its `Broker` interface has a Python equivalent, and `agent_broker`'s top-level exports mirror
`typescript/src/index.ts` (enforced by `tests/unit/test_public_api.py`). How the two
implementations relate is documented in
[`docs/ARCHITECTURE.md` §23](../docs/ARCHITECTURE.md#23-typescript-and-python-implementations).

## Installation

The package is **not on PyPI yet**. Install it from this repository:

```bash
# directly from GitHub (default branch)
pip install "git+https://github.com/Devpaul-01/agent-broker.git#subdirectory=python"

# or from a checkout of this repository (editable; add [dev] for pytest and mypy)
pip install -e "python/[dev]"
```

The distribution name in `pyproject.toml` is `agent-broker`; the import name is `agent_broker`.

Requires Python 3.10 or later, and a reachable Redis instance (local, containerized, or
managed). `redis-py` is a regular dependency (installed automatically) — you still bring your
own Redis client instance to `create_broker`; this library never manages a connection itself,
the same design choice the TypeScript package makes (see
[ADR-0006](../docs/adr/0006-no-owned-redis-connection.md)).


## Quick start

```python
import asyncio
import redis.asyncio as redis
from agent_broker import (
    create_broker,
    BrokerOptions,
    RegisterRootInput,
    RequestPermissionInput,
    ReportOutcomeInput,
)

async def main():
    client = redis.Redis.from_url("redis://localhost:6379")
    broker = create_broker(BrokerOptions(redis=client))

    # Register a root agent and fund its budget pool.
    root = await broker.register(RegisterRootInput(budget_key="user-123", initial_budget=5000))

    # Before calling a downstream resource, ask permission.
    decision = await broker.request_permission(
        RequestPermissionInput(agent_id=root.agent_id, target="groq:llama-3.3-70b-versatile", estimated_cost=800)
    )

    if not decision.allowed:
        # decision.reason: "unknown_agent" | "aborted" | "budget_exceeded"
        #                | "concurrency_exceeded" | "circuit_open" | "redis_unavailable" | "queue_timeout"
        # ("aborted" and "queue_timeout" only apply in queue mode — see "Queue mode" below.
        #  "depth_exceeded" is a register() reason for child agents, not a request_permission() reason.)
        raise RuntimeError(f"denied: {decision.reason}")

    # Make your actual call however you normally would. agent-broker has no opinion about your
    # SDK, your provider, or your prompt.
    response = await your_llm_client.call(...)

    # Report back so the reservation can be reconciled.
    await broker.report_outcome(
        ReportOutcomeInput(reservation_id=decision.reservation_id, success=True, actual_cost=response.usage.total_tokens)
    )

asyncio.run(main())
```

### Delegating to a sub-agent

```python
from agent_broker import RegisterChildInput, RegisterDenial

child = await broker.register(RegisterChildInput(parent_id=root.agent_id))
# child.depth, child.root_id, child.budget_key are all broker-derived — never something you pass
# in. See "Trust model" in the root README for why.

if isinstance(child, RegisterDenial):
    # child.reason == "depth_exceeded" or "unknown_agent"
    ...
```

### Handling a transient failure

```python
await broker.report_outcome(
    ReportOutcomeInput(reservation_id=decision.reservation_id, success=False, retryable=True)
    # retryable=True means this failure counts toward shared circuit-breaker state
)
```

---

## Core concepts

Identical to the TypeScript package's — see
[Core concepts in the root README](../README.md#core-concepts) for the full table (agent,
`target`, `budget_key`, reservation, circuit breaker). The concepts and their Redis
representation are shared across both languages; only the calling convention differs.

## Configuration

```python
from agent_broker import BrokerOptions, CircuitBreakerOptions, BrokerHooks

broker = create_broker(BrokerOptions(
    redis=client,                       # required — your own redis.Redis or redis.asyncio.Redis
    max_depth=5,                        # delegation depth ceiling
    agent_ttl=3_600_000,                # ms, how long an idle agent stays registered (must be >= max_reservation_ttl)
    default_reservation_ttl=30_000,     # ms, used when a call omits `ttl`
    max_reservation_ttl=300_000,        # ms, hard ceiling a caller's `ttl` cannot exceed
    concurrency_limit=10,               # in-flight calls per (target, budget_key) pair
    on_redis_unavailable="deny",        # "deny" | "allow" — see "Failure behavior" below
    circuit_breaker=CircuitBreakerOptions(
        soft_threshold=5,               # failures before retry_after backpressure appears
        hard_threshold=20,              # failures before the circuit opens
        window_ms=60_000,               # sliding window for failure counting
        probe_rate=0.1,                 # fraction of open-circuit calls admitted as recovery probes
    ),
    hooks=BrokerHooks(
        on_decision=lambda event: ...,              # fires on every request_permission outcome
        on_outcome=lambda event: ...,                # fires on every report_outcome call
        on_circuit_state_change=lambda event: ...,   # fires only on open/closed transitions
        on_cleanup=lambda event: ...,                # fires when a lazy sweep resolves an abandoned reservation
    ),
))
```

All configuration is immutable for the lifetime of a `Broker` instance (`ResolvedConfig` is a
frozen dataclass) — construct a second instance if you need different limits, the same guidance
as the TypeScript package's own [ADR-0007](../docs/adr/0007-immutable-broker-config.md). Hooks
accept either a plain sync callable or an `async def` — both are fired-and-forgotten; an
exception raised inside a hook is swallowed and never affects broker behavior.

## Failure behavior

If Redis is unreachable, `on_redis_unavailable` decides what happens, and it defaults to the
conservative option — identical semantics to the TypeScript package:

- **`"deny"`** (default): calls are denied with `reason="redis_unavailable"`. The one moment
  coordination can't function is exactly the moment you don't want to silently lose the
  guarantees it provides.
- **`"allow"`**: calls are admitted without a reservation (`degraded=True`,
  `reservation_id=None`). Pick this only if raw availability matters more than the coordination
  guarantees during an outage.

See [Failure behavior in the root README](../README.md#failure-behavior) and
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#12-failure-model) for
the full breakdown of crash and timeout behavior, which this port follows exactly.

## Async usage, timeouts, and cancellation

Every `Broker` method is a coroutine (`async def`) — this package is async-first, matching the
all-`Promise`-based TypeScript API. There is currently no synchronous wrapper; if you need to
call this from non-async code, run it inside `asyncio.run(...)` or your framework's async
bridge.

**Cancellation:** an ordinary `asyncio.Task.cancel()` on a task running any `Broker` method
propagates as `asyncio.CancelledError`, as normal for any asyncio coroutine — each operation is
one atomic Redis round trip with no partial-application window Redis itself can land in, so a
cancelled call never leaves a half-applied reservation or budget change (verified directly: see
`python/tests/integration/failure_modes/test_cancellation.py`).

## Queue mode

By default, a denied call is just denied. If you'd rather wait for a slot/budget/recovery
instead of handling the denial yourself:

```python
from agent_broker import QueueOptions

result = await broker.request_permission(
    RequestPermissionInput(agent_id=agent_id, target=target, estimated_cost=cost),
    QueueOptions(queue_timeout=10_000),
)
```

This polls the same atomic admission path with backoff until admitted, `queue_timeout` elapses
(`reason="queue_timeout"`), or the denial reason is one that waiting can never fix
(`unknown_agent` returns immediately, not after a timeout). To cancel the wait externally, pass
a cooperative `asyncio.Event` as `cancel_event` — the Python equivalent of the TypeScript
package's `AbortSignal` (there is no `AbortSignal` in Python's standard library, and an
`asyncio.Event` is the idiomatic analog: set it from anywhere to interrupt the wait promptly);
an interrupted wait resolves with `reason="aborted"`, the same as `Broker.request_permission`'s
own `asyncio.Task.cancel()` propagating normally if you cancel the whole task instead:

```python
cancel_event = asyncio.Event()
task = asyncio.create_task(
    broker.request_permission(input, QueueOptions(queue_timeout=30_000, cancel_event=cancel_event))
)
# elsewhere:
cancel_event.set()  # interrupts the wait, returns {"allowed": False, "reason": "aborted"}
```

---

## Interoperating with the TypeScript package

Both implementations use byte-identical Redis key construction and the exact same Lua scripts
for every atomic operation — verified automatically on every test run by a test that diffs the
Python copies of each script against the TypeScript source they were copied from (see
[`docs/ARCHITECTURE.md` §23](../docs/ARCHITECTURE.md#23-typescript-and-python-implementations)). This means a
TypeScript process and a Python process can register agents, request permission, and resolve
reservations against the very same budget pool, target, and circuit-breaker state, as long as
both point at the same Redis instance/database. This is proven with real cross-process,
cross-language integration tests in
[`test/cross-language/`](../test/cross-language/README.md) at the repository root — not merely
asserted — covering: one language registering an agent the other calls `request_permission`
against, one language resolving a reservation the other created, both racing concurrently for
one shared budget pool, one language's failures opening the circuit breaker observed by the
other, and lazy cleanup in one language recovering a reservation abandoned by the other.

## Error handling

Three exception classes, mirroring the TypeScript package's error hierarchy exactly:

- `BrokerConfigError` — raised by `create_broker`/`parse_config` for invalid or missing
  configuration. Never raised after construction.
- `BrokerArgumentError` — raised when a per-call argument is malformed. Distinct from an
  ordinary denial: a malformed call *is* an error, a denied-but-well-formed call is not.
- `BrokerError` — a genuine runtime failure (a Redis/script error, or an unexpected reply
  shape). Ordinary admission/resolution denials are never exceptions in either language — they
  are returned as regular result objects (`Denied`, `ReportDenial`, `RegisterDenial`, etc.) with
  a `reason` field for you to branch on.

## Resource cleanup

This package never owns a Redis connection — you create and close your own `redis.Redis` /
`redis.asyncio.Redis` client exactly as you would for any other use of `redis-py`. There is
nothing additional to close on the `Broker` object itself.

## Concurrency and recovery behavior

Identical guarantees to the TypeScript package, proven under genuine multi-process contention
(not just concurrent `asyncio` tasks sharing one connection) in
`python/tests/integration/failure_modes/`: the shared budget pool can never be overdrawn
regardless of how many processes race for it; a process that crashes between reservation and
resolution has its reservation recovered by the next caller's lazy cleanup sweep with a full
refund; two workers racing to clean up the very same expired reservation refund it exactly once;
a caller that retries `report_outcome` after presuming a response was lost lands as
`already_resolved` rather than double-refunding.

## Testing and development

```bash
cd python
pip install -e ".[dev]"

pytest tests/unit          # no Redis required
pytest tests/integration   # requires a reachable Redis — see tests/integration/conftest.py
mypy --strict src/agent_broker
```

Integration tests point at `redis://localhost:6379/15` by default (override with
`TEST_REDIS_URL`) and are never silently skipped if Redis is unreachable — a missing Redis
surfaces as a clear, loud failure with instructions, the same philosophy as the TypeScript
package's own test suite. They **flush the database they run against** (database 15 by
default), so never point `TEST_REDIS_URL` at a Redis instance whose data you care about. A quick
local Redis: `docker run -d -p 6379:6379 redis:7-alpine`.

For cross-language tests, see [`test/cross-language/README.md`](../test/cross-language/README.md)
at the repository root — they additionally require `npx` on `PATH` to run the TypeScript worker.

## Known limitations

- Not yet published to PyPI.
- No synchronous API — every `Broker` method is a coroutine; see
  [Async usage](#async-usage-timeouts-and-cancellation) above.
- No dedicated test yet proving a hook callback receives the exact expected payload shape on a
  real event (hooks are wired into every call site that fires one in the TypeScript source, but
  this specific verification — mirroring the TypeScript suite's own `hooks.test.ts` — remains
  open).
- Supported Python versions: 3.10, 3.11, 3.12, 3.13 (tracks `redis-py`'s own supported range;
  developed and tested against 3.12 — see `pyproject.toml`'s `classifiers` for the full
  declared list).

## Related documentation

- [Root README](../README.md) — the TypeScript package, the project's "why this exists," trust
  model, and engineering highlights (all apply equally to this Python package, since both share
  the same design).
- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — full design
  rationale, invariants, Redis data model, and failure model.
- [`docs/adr/`](../docs/adr/) — architecture decision records.
- [`test/cross-language/`](../test/cross-language/README.md) — tests proving the TypeScript and
  Python implementations interoperate through one Redis.
- [`examples/`](examples/) — runnable example scripts.
