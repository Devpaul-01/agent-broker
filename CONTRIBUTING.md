# Contributing

Thanks for looking at `agent-broker`. This is a small, focused library — contributions that
keep it that way are especially welcome.

## Local setup

Requires Node.js 22+ and Docker (for the local Redis used by integration tests).

```bash
git clone https://github.com/Devpaul-01/agent-broker.git
cd agent-broker
npm ci
```

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
- If you touched `src/`, make sure `npm run build` still produces a clean `dist/` and
  `npm run typecheck` is clean — these are both enforced in CI but worth checking locally first.
- If your change affects documented behavior (anything in README.md or
  `docs/agent-broker-architecture.md`), update the relevant doc in the same PR. Treat the
  implementation as the source of truth and the docs as something that must track it — see
  `docs/adr/` for the convention this project uses to record *why* a decision was made, not just
  what it is.
- If you're changing or adding to the public API (anything exported from `src/index.ts`), explain
  the reasoning in the PR description: what problem it solves, and why the existing API couldn't
  express it. This project intentionally keeps its public surface small (see
  [ADR-0004](docs/adr/0004-no-provider-abstraction.md) for an example of a deliberate scope
  boundary) — new public API is a real cost, not a free addition.
- Keep PRs focused. A PR that fixes one thing is easier to review, easier to revert if wrong, and
  easier to cite in a changelog entry than one that bundles several unrelated changes.

## What CI checks

`.github/workflows/ci.yml` runs on every push and pull request:

1. **`test`** — `npm ci`, full test suite (`npm test`) against a real Redis service container.
2. **`pack-and-install`** (depends on `test` passing) — builds, runs `npm pack`, installs the
   actual packed tarball into an independent consumer project, and runs a real smoke test
   against it, across both supported `ioredis` majors (`^5` and `^6`). This is the test that
   verifies the *published artifact* works, not just the source tree — see
   [RELEASE.md](RELEASE.md) for why that distinction matters.

## Architecture decision records

If a PR makes a deliberate design choice that isn't obvious from the code alone — especially
anything involving atomicity, failure handling, or the Redis data model — consider adding an ADR
under `docs/adr/`, following the numbering and format of the existing ones. These exist so future
readers (including future contributors) don't have to reverse-engineer *why* something works the
way it does from the implementation alone.

## Reporting bugs or requesting features

Open a GitHub issue. For anything that might be a security issue rather than an ordinary bug, see
[SECURITY.md](SECURITY.md) instead of opening a public issue.
