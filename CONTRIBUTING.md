# Contributing

Thanks for looking at `agent-broker`. This is a small, focused library — contributions that
keep it that way are especially welcome.

## Local setup

Requires Node.js 22+ and Docker (for the local Redis used by integration tests).

```bash
git clone https://github.com/Devpaul-01/agent-broker.git
cd agent-broker/typescript
npm ci
```

The TypeScript implementation lives in `typescript/` (mirroring `python/` for the Python port) —
run all `npm` commands below from inside that folder.

## Running checks locally

```bash
npm run typecheck        # tsc --noEmit
npm run test:unit        # fast, no Redis required
npm run redis:up         # starts redis:7-alpine via docker-compose, waits for healthy
npm run test:integration # Redis-backed tests, including the cross-process harness
npm run redis:down       # stop and remove the Redis container
npm run build            # tsc -p tsconfig.build.json -> dist/
```

`npm test` runs the full suite (unit + integration) and expects Redis to already be reachable —
run `npm run redis:up` first, or point `TEST_REDIS_URL` at an existing instance.

## Before opening a pull request

- Run the full check list above; all of it should pass locally, not just `test:unit`.
- If you touched `typescript/src/`, make sure `npm run build` still produces a clean `dist/` and
  `npm run typecheck` is clean — these are both enforced in CI but worth checking locally first.
- If your change affects documented behavior (anything in README.md or
  `docs/ARCHITECTURE.md`), update the relevant doc in the same PR. Treat the
  implementation as the source of truth and the docs as something that must track it — see
  `docs/adr/` for the convention this project uses to record *why* a decision was made, not just
  what it is.
- If you're changing or adding to the public API (anything exported from
  `typescript/src/index.ts`), explain
  the reasoning in the PR description: what problem it solves, and why the existing API couldn't
  express it. This project intentionally keeps its public surface small (see
  [ADR-0004](docs/adr/0004-no-provider-abstraction.md) for an example of a deliberate scope
  boundary) — new public API is a real cost, not a free addition.
- Keep PRs focused. A PR that fixes one thing is easier to review, easier to revert if wrong, and
  easier to cite in a changelog entry than one that bundles several unrelated changes.

## What CI checks

CI is split into one workflow per concern under `.github/workflows/`. Each runs on pushes and pull
requests that touch the paths it cares about (and can also be started manually), so a
TypeScript-only change doesn't wait on the Python matrix and vice versa.

1. **`typescript.yml`** — runs on changes under `typescript/`.
   - **`test`**: `npm ci`, `npm run typecheck`, then the full suite (`npm test`) against a real
     Redis service container, with `typescript/` as the working directory.
   - **`pack-and-install`** (depends on `test`): builds, runs `npm pack`, installs the actual
     packed tarball into an independent consumer project, and runs a real smoke test against it,
     across both supported `ioredis` majors (`^5` and `^6`). This verifies the *published
     artifact* works, not just the source tree — see [RELEASE.md](RELEASE.md).
2. **`python.yml`** — runs on changes under `python/` or `typescript/src/` (the Python unit tests
   diff its Lua scripts and public API against the TypeScript source).
   - **`test`**: Python 3.10–3.13 matrix; `mypy --strict`, unit tests, then integration tests
     against a real Redis service container.
   - **`build`** (depends on `test`): builds the sdist and wheel, installs the wheel into a clean
     virtualenv, and imports it.
3. **`cross-language.yml`** — runs on changes under `typescript/`, `python/`, or
   `test/cross-language/`. Installs both toolchains and runs the cross-language suite, which
   proves a TypeScript process and a Python process coordinate through one shared Redis.

Because each workflow is path-filtered, don't mark these as *required* status checks in branch
protection without also adding a catch-all job — a skipped workflow never reports a status.

To run the Python and cross-language checks locally:

```bash
cd python && pip install -e ".[dev]"
mypy --strict src/agent_broker && pytest tests/unit tests/integration
cd .. && pytest test/cross-language/ -v   # also needs `npm ci` in typescript/ and Redis running
```

## Architecture decision records

If a PR makes a deliberate design choice that isn't obvious from the code alone — especially
anything involving atomicity, failure handling, or the Redis data model — consider adding an ADR
under `docs/adr/`, following the numbering and format of the existing ones. These exist so future
readers (including future contributors) don't have to reverse-engineer *why* something works the
way it does from the implementation alone.

## Reporting bugs or requesting features

Open a GitHub issue. For anything that might be a security issue rather than an ordinary bug, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.
