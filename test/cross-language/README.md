# Cross-language tests

Proves the TypeScript and Python implementations of Agent Broker actually interoperate through
the same Redis instance — not just that each language's own test suite passes independently.
See `docs/python-port/IMPLEMENTATION_PLAN.md` (Milestone 5) and
`docs/python-port/ARCHITECTURE.md` for why this directory exists at the repository root rather
than inside either language's own test tree.

## How it works

- `py_worker.py` and `ts_worker.ts` are standalone subprocess workers, one per language, each
  running the real `Broker` from its own language's source against real Redis. They speak an
  identical JSON-Lines protocol over stdin/stdout (one JSON task object in per line, one JSON
  result object out per line) — a transport neither language needs anything beyond its standard
  library to drive, and the reason this works at all: Node's native IPC channel (used by
  `test/helpers/worker.ts`, the TS-only cross-process harness) only exists between two Node
  processes, so a Python parent can't use it directly.
- `harness.py` spawns either worker as a real OS subprocess and drives it over that protocol.
- `test_cross_language.py` holds the **cooperation** scenarios: one worker of each language in
  the same test, with assertions that read the *other* language's result, or Redis directly, to
  confirm both sides genuinely observe the same coordination state (e.g. TS registers, Python
  admits against it).
- `fixtures/behavioral_cases.json` + `test_shared_cases.py` hold the **equivalence** scenarios: a
  language-neutral operation sequence (initial budget, a list of `requestPermission`/
  `reportOutcome` steps, expected results, expected final Redis state, invariants) defined once
  and replayed unchanged through *each* language's worker in turn — proving the same case
  produces the same result independent of which language executed it, which is a different (and
  equally necessary) claim from the cooperation scenarios proving two *different* languages can
  act on one shared piece of state together.

## Prerequisites

- A reachable Redis at `redis://localhost:6379/15` (override with `TEST_REDIS_URL`) — same
  requirement, same database, as every other integration test in this repository. See
  `docs/python-port/BASELINE.md` for how this was provisioned in the sandbox this port was
  built in.
- `npx` on `PATH` (to run `ts_worker.ts` via `tsx`, unbuilt — same as every other TS integration
  test in this repository).
- The Python package installed (`pip install -e python/`, or just having `python/src` on
  `PYTHONPATH`, which `harness.py` and the test file already arrange via `sys.path.insert`).
- Node dependencies installed at the repository root (`npm install`).

## Running

```bash
# From the repository root:
python3 -m pytest test/cross-language/ -v

# Or from python/, same result (test/cross-language is outside the python/ package but pytest
# will still discover it if pointed at the path explicitly):
cd python && python3 -m pytest ../test/cross-language/ -v
```

These tests are never silently skipped if Redis or `npx` is unavailable — a missing prerequisite
surfaces as a clear failure (a `WorkerHandle` that fails to report ready, or a Redis connection
error), the same fail-loud philosophy as every other integration test in this repository (see
`test/helpers/redis.ts` and `python/tests/integration/conftest.py`).

## Adding a new cross-language scenario

Use the existing tests in `test_cross_language.py` as a template: spawn `workers` (the fixture
gives you `(ts, py)`), call `.run(task_name, params, config=...)` on whichever language should
perform each step, and assert on the result — or on Redis directly via the `redis_client`
fixture, which is often the stronger assertion since it doesn't depend on trusting either
worker's own self-report.
