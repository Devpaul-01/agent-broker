# Implementation Plan

Baseline: commit `36f7674`. Each milestone below lists its goal, dependencies, expected files,
tests, acceptance criteria, and patch filename. This refines (not replaces) the milestone outline
in the original project brief, grounded in the actual feature inventory from `REPOSITORY_AUDIT.md`
and `FEATURE_PARITY_MATRIX.md`.

## M0 — Repository audit and architecture specification
**Status: complete.** Deliverables: `REPOSITORY_AUDIT.md`, `FEATURE_PARITY_MATRIX.md`,
`ARCHITECTURE.md`, `BASELINE.md`, this file. Patch: `patches/python-port/00-baseline-and-specification.patch`
(docs-only; no `src/` or `test/` changes, since this milestone performed no implementation).

## M1 — Python package foundation
**Depends on:** M0.
**Goal:** An installable, importable, empty-but-real Python package with config parsing, error
classes, and a connection-lifecycle story — no coordination logic yet.
**Files:** `python/pyproject.toml`, `python/src/agent_broker/__init__.py`,
`python/src/agent_broker/_config.py`, `python/src/agent_broker/_errors.py`,
`python/src/agent_broker/_keys.py`, `python/tests/unit/test_config.py`,
`python/tests/unit/test_keys.py`, `python/README.md`.
**Tests:** unit tests mirroring `test/unit/config.test.ts` (17 cases) and `test/unit/keys.test.ts`
(3 cases) — same inputs, same expected pass/fail, translated to `pytest`.
**Acceptance:** `pip install -e python/` succeeds; `import agent_broker` succeeds; `pytest
python/tests/unit` passes; root TS suite still green (re-run as a regression check, not assumed).
**Patch:** `01-python-package-foundation.patch`.

## M2 — Core coordination and shared Redis protocol
**Depends on:** M1.
**Goal:** `request_permission` and the key-construction/script-loading machinery, proven
byte-compatible with the TS key scheme and script text.
**Files:** `python/src/agent_broker/_scripts.py` (Lua sources, see `ARCHITECTURE.md` §2),
`python/src/agent_broker/_script_runner.py` (EVALSHA/NOSCRIPT→EVAL fallback, mirroring
`src/redis/script.ts`), `python/src/agent_broker/admission.py` (`request_permission`),
`python/tests/unit/test_script_equivalence.py` (extracts and diffs Lua text against the TS
source files — fails loudly if they ever diverge), `python/tests/integration/test_request_permission.py`.
**Tests:** integration tests mirroring `test/integration/request-permission.test.ts` (14 cases)
against real Redis; a new cross-language key-compatibility unit test (Python's `keys.*` functions
produce identical strings to TS's for the same inputs — golden values captured from the TS
implementation).
**Acceptance:** core admission works against real Redis; script-equivalence test passes; TS
suite still green.
**Patch:** `02-core-coordination.patch`.

## M3 — Concurrency, recovery, and distributed failure handling
**Depends on:** M2.
**Goal:** `resolve_reservation`/`report_outcome`, lazy cleanup sweep, and the registration/
delegation operations — i.e. everything needed for a reservation's full lifecycle.
**Files:** `python/src/agent_broker/resolution.py`, `python/src/agent_broker/cleanup.py`,
`python/src/agent_broker/agents.py` (register root/child, deregister), `python/src/agent_broker/budget.py`
(add_budget), plus integration tests mirroring `report-outcome.test.ts`, `cleanup.test.ts`,
`register.test.ts`, `register-child.test.ts`, `deregister.test.ts`, `add-budget.test.ts`.
**Failure-mode coverage required here** (per the brief's §5/Milestone 3 failure analysis),
reusing the existing cross-process pattern (`test/helpers/harness.ts`'s model, reimplemented with
Python's `multiprocessing` for Python-only concurrency tests): duplicate `report_outcome` calls
(idempotency via the `resolved` flag), lost-response handling, concurrent admission against a
shared budget (Python equivalent of `budget-contention.test.ts`), process termination before
resolution (lazy cleanup picks it up), cancellation mid-call, Redis connection drop
before/during/after a script call.
**Acceptance:** full reservation lifecycle works end-to-end in Python against real Redis;
concurrency/failure tests pass; TS suite still green.
**Patch:** `03-concurrency-and-recovery.patch`.

## M4 — Reliability features and remaining public APIs
**Depends on:** M3.
**Goal:** Queue mode, circuit-breaker observability, hooks, and any remaining config surface.
**Files:** `python/src/agent_broker/queue.py` (backoff/jitter + cancellation, mirroring
`src/admission/queue.ts`), `python/src/agent_broker/hooks.py`, `python/src/agent_broker/broker.py`
(the `create_broker`-equivalent top-level factory tying every module together into the public
`Broker` object), plus tests mirroring `queue-mode.test.ts`, `queue-mode-abort.test.ts`,
`queue-mode-contention.test.ts`, `hooks.test.ts`.
**Acceptance:** full public API surface implemented and tested; parity matrix updated to reflect
real status per row, not blanket "complete"; TS suite still green.
**Patch:** `04-reliability-features.patch`.

## M5 — Cross-language and adversarial testing
**Depends on:** M4.
**Goal:** Prove TS and Python actually interoperate over the same Redis state, not just that each
passes its own suite.
**Files:** `test/cross-language/` (new, at repo root — these tests exercise both languages, so
they don't belong inside either language's own test tree) with a small TS-side and Python-side
runner pair, plus shared JSON fixtures describing language-neutral test cases (initial state,
operation sequence, expected final state, invariants).
**Required scenarios** (from the brief, concretized against this repo's actual feature set): TS
registers a root agent, Python calls `request_permission` against it; Python registers, TS
resolves; both languages racing for the same budget pool (reuse the `budget-contention` pattern,
cross-language); one language's retryable failures open the circuit breaker, observed by the
other; cleanup sweep triggered by one language resolves a reservation created by the other.
**Acceptance:** cross-language scenarios pass against real Redis; concurrency/stress tests are
clearly labeled as such with a documented, reproducible invocation; any skip is reported with its
reason, never silently treated as a pass.
**Patch:** `05-cross-language-tests.patch`.

## M6 — Documentation, examples, and developer experience
**Depends on:** M5.
**Goal:** Discoverable, accurate docs; root README gets an additive section; Python package
builds cleanly.
**Files:** root `README.md` (additive section only), `python/README.md` (full Python docs),
`python/examples/*.py`, packaging verification notes.
**Acceptance:** docs match actual implemented behavior (no invented methods); `python -m build`
(or equivalent) produces a wheel and sdist that install and import cleanly without Node.js
present; root TS docs/install instructions unchanged and still accurate.
**Patch:** `06-documentation-and-release.patch`.

## Sequencing notes

- Each milestone's patch depends only on the previous milestone's patch applying cleanly — no
  milestone reaches ahead to touch files reserved for a later one.
- Every milestone re-runs the full existing TypeScript suite (`npm run typecheck && npm test`) as
  a regression gate, not just the new Python tests — this is the mechanism that satisfies
  "Existing TypeScript tests remain unaffected" on every single milestone, not just at the end.
- If a milestone's acceptance criteria cannot be fully met (e.g. a specific failure-mode scenario
  can't be reproduced deterministically), the milestone is marked `Blocked` in its manifest entry
  with the specific blocking reason — never silently marked complete.
