# Python Port — Proposed Architecture

## 1. Repository structure decision

### Options considered

**A. Add `python/` at root, leave the current TS package exactly where it is.**
No change to `package.json`, `tsconfig*.json`, `dist/` output path, npm publish config, GitHub
links in `README.md`/`package.json.repository`, CI workflow paths, or any existing consumer's
`import` path. Purely additive.

**B. Move TS into `typescript/`, add `python/`, make the repo root a pure meta-folder.**
Symmetrical and "looks like a monorepo," but breaks `npm pack`/`npm publish` from root (npm
publishes whatever `package.json` is at the path you run it from), breaks the root-relative
`dist/index.js` paths in `package.json#main`/`#types`/`#exports`, requires rewriting
`tsconfig.build.json`'s `rootDir`/`outDir`, rewriting `vitest.config.ts`'s `include` glob,
rewriting `docker-compose.yml` consumers if anything depends on root-relative paths, and
rewriting every GitHub link that currently points at root-level files (README badges, `homepage`,
`bugs.url`). None of this is impossible, but it is unreviewable as a "Python-port" change — it's
an unrelated TypeScript repo-layout migration bundled into this task, which §1.1 of the project
brief explicitly forbids ("Do not rewrite, replace, reorganize, or break the TypeScript
implementation merely to make room for Python").

**C. A full workspace tool (npm workspaces / Turborepo / Nx) spanning both languages.**
Massive overkill for one Python package and one TS package that don't share a build toolchain at
all (one is `tsc`, the other will be a PEP 517 build backend). Adds a dependency and a mental
model with no payoff here — explicitly warned against in the brief ("Never create unnecessary
abstractions solely to make the architecture look sophisticated").

### Decision: Option A

```
agent-broker/                    (repo root — UNCHANGED: package.json, src/, test/, dist/, docs/adr/)
├── src/                         (TypeScript source — untouched)
├── test/                        (TypeScript tests — untouched)
├── package.json                 (TypeScript package manifest — untouched)
├── docs/
│   ├── adr/                     (existing ADR log — extended, not replaced)
│   └── python-port/             (this directory)
├── patches/
│   └── python-port/             (milestone patches)
└── python/                      (NEW — the entire Python package lives here)
    ├── pyproject.toml
    ├── README.md                (Python-specific quick start; root README links here)
    ├── src/
    │   └── agent_broker/
    │       ├── __init__.py
    │       ├── _lua/            (shared Lua script sources — see §2)
    │       ├── ...
    ├── tests/
    │   ├── unit/
    │   └── integration/
    └── examples/
```

This is the safest option because it guarantees, by construction, that every one of the "Review
C: Backward compatibility" checks in the final audit passes trivially: existing TS imports,
builds, tests, and publish paths are untouched because nothing under their paths changes at all.
The root README is edited additively (a new section), never restructured.

## 2. Shared Lua script source of truth

The TypeScript scripts are inline template strings (`src/admission/request-permission.ts`,
`src/admission/resolve-reservation.ts`, `src/agents/register-child.ts`,
`src/budget/add-budget.ts`) — there are no standalone `.lua` files today.

Two real options:

**A. Extract each script to a standalone `.lua` file under a new shared directory (e.g.
`scripts/lua/`), and have both the TS and Python code read/embed from there.**
Strongest guarantee of a single source of truth, but requires changing how the TS side loads its
scripts (`defineScript(source, n)` currently takes a literal string) — a build-time or
runtime file-read change to existing TS code, which §1.1 says to avoid unless "genuinely
necessary," and this isn't: the scripts aren't expected to change during this port.

**B. Treat the TypeScript source as authoritative; the Python port copies each script's Lua text
verbatim into its own Python source, with an automated equivality check (not a human "looks the
same" check) that fails CI if they ever drift.**
No TS changes at all. The equivalence check is a small script (Milestone 2) that parses the exact
Lua string literal out of each TS file (via a simple, deliberately dumb textual extraction, not a
full TS parser) and the exact Lua string out of the corresponding Python file, and asserts
byte-for-byte equality. This is the same spirit as a golden-file test and is easy to keep honest.

### Decision: Option B

Rationale: it satisfies "If both implementations use the same scripts, make their source of truth
explicit" (the TS files are explicitly documented, here and in code comments, as that source of
truth) without touching working TypeScript. If a later milestone decides the duplication is
unacceptable, extracting to shared `.lua` files remains available as a follow-up with its own
patch and its own TS-side review — not bundled into this port.

Each of the four scripts (`REQUEST_PERMISSION`, `RESOLVE_RESERVATION`, `REGISTER_CHILD`,
`ADD_BUDGET`) gets one Python module under `python/src/agent_broker/_scripts.py` holding the
identical Lua source as a triple-quoted string, with a comment pointing at the exact TS file and
line range it was copied from, and the Milestone 2 equivalence test enforces they never silently
diverge.

## 3. Python package shape

- **Distribution name**: `agent-broker` is unlikely to be free on PyPI (verify in Milestone 1 —
  do not assume); fallback candidates: `agent-broker-py`, `agentbroker`. Decided and recorded in
  Milestone 1, not guessed here.
- **Import name**: `agent_broker` (PEP 8 package naming; distribution name and import name are
  allowed to differ in Python, unlike npm).
- **Build backend**: Hatchling (`hatchling` via `pyproject.toml` `[build-system]`) — a common,
  dependency-light, non-opinionated choice; no particular reason to reach for Poetry/PDM here.
- **Redis client**: `redis-py` (the `redis` package, `redis.asyncio` submodule for the async
  client) — it is the de facto standard, actively maintained, supports `EVALSHA`/`EVAL` with
  NOSCRIPT fallback natively, and does not require a C extension by default. `aioredis` is
  deprecated/merged into `redis-py` upstream and should not be used.
- **Sync vs. async**: Agent Broker's own call pattern (short-lived admission/resolution calls
  from many independent workers, often inside async agent-orchestration frameworks already using
  `asyncio`) justifies an **async-first** public API (`async def request_permission(...)`,
  mirroring the TS implementation's own all-`Promise`-based surface), with a **sync wrapper**
  generated thinly over the async core for callers not in an event loop — not two independently
  maintained implementations of the coordination logic. This mirrors ADR-0006 (library never owns
  its own Redis connection — the Python port's constructor will likewise require an existing
  `redis.asyncio.Redis` or `redis.Redis` instance to be passed in, matching the sync/async choice
  the caller already made for their own client).
- **Cancellation**: Python's `asyncio.CancelledError` / `asyncio.timeout()` is the natural
  equivalent of the TS `AbortSignal` used by queue mode — queue mode's Python equivalent will
  accept a `timeout` and rely on standard task cancellation rather than inventing a bespoke signal
  object, but this needs explicit design-and-test coverage in Milestone 1/4, not silent
  assumption.
- **Supported Python versions**: determined in Milestone 1 against `redis-py`'s own supported
  range and whatever async features are used (expect 3.10+ as a floor; not finalized here).

## 4. What is explicitly out of scope for "architecture"

Per the brief: no provider abstraction, no rate limiting beyond the existing circuit breaker, no
background/timer-driven cleanup. The Python port's architecture inherits every one of these
non-goals from the TS implementation's own ADR log (ADR-0001, ADR-0004, ADR-0022) rather than
re-deciding them.
