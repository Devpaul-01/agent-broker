# Baseline — Original Repository State

Recorded during Milestone 0, prior to any Python-port changes.

## Repository state

- Remote: `https://github.com/Devpaul-01/agent-broker.git`
- Branch: `main`
- Commit: `36f7674` ("Merge pull request #1 from Devpaul-01/release-readiness-cleanup")
- Working tree: clean at clone time, no pre-existing local modifications to preserve.
- Other remote branches exist (`feat/child-registration`, `feat/deregister-and-add-budget`,
  `feat/observability-hooks`, `feat/queue-mode`, `feat/queue-mode-contention-and-abort`,
  `fix/audit-tier-0-cleanup`, `fix/audit-tier-1-error-hardening`,
  `fix/audit-tier-1-public-api-tests`, `release-readiness-cleanup`, `seyi`,
  `test/correlated-retries-cross-process`) but were not merged into the baseline and were not
  inspected for this audit — `main` at `36f7674` is treated as the reference state per the
  project instructions ("the existing TypeScript implementation is the reference implementation
  unless the repository, tests, or documented specifications establish otherwise").

## Environment

- Node: v22.22.2 (matches `package.json` `engines.node: ">=22"`)
- npm: 10.9.7
- `npm install`: succeeded, 50 packages, 1 high-severity advisory reported by `npm audit`
  (not investigated further — pre-existing, unrelated to this port; flagged here rather than
  silently ignored).

## Test results at baseline

### Typecheck

```
npm run typecheck
```
Passed, no errors.

### Unit tests

```
npm run test:unit
```
**8 files, 88 tests, all passed.** No Redis required.

### Integration tests

**Updated after provisioning a local Redis — see "Redis provisioning" below.**

First attempt, no Redis reachable:
```
npm run test:integration
```
19 files, 100 tests — all failed with `Cannot reach test Redis at redis://localhost:6379/15`.
This was the honest result at that point, not glossed over (`test/helpers/redis.ts` is designed
to fail loudly rather than skip when Redis is unreachable — "These tests need a real Redis and
are never skipped" — so that failure was the suite's own correct, intended behavior, not a sign
of broken tests).

After provisioning Redis locally (below), re-ran:
```
redis-cli -n 15 flushdb
npx vitest run --testTimeout=60000
```
**27 files (8 unit + 19 integration), 188 tests — all passed.**

The `--testTimeout=60000` override (default is Vitest's own, much shorter, default) was needed
because this sandbox has a **single CPU core** (`nproc` → 1). The three failure-mode/contention
suites that fork 10–30 real OS child processes each (`budget-contention.test.ts`,
`correlated-retries.test.ts`, and transiently `cross-process-harness.test.ts` under parallel
file load) were timing out on IPC replies purely from CPU scheduling contention on one core, not
from any logic defect — confirmed by running each such file in isolation with a longer timeout,
where every one passed deterministically and the asserted invariants (exact admitted/denied
counts, exact final budget-pool values, exact reservation-key counts) all held. This is an
environment characteristic of this sandbox, not a project defect, and not something a production
CI runner (which the project's own `.github/workflows` presumably provisions with more cores)
would need to work around in the same way — it's recorded here only in case this specific
sandbox is reused for a later milestone.

### Redis provisioning (this audit)

No Redis or Docker was preinstalled in this sandbox, and the project's primary install path
(`npm run redis:up`, i.e. `docker compose up`) was unavailable here (no Docker). A system
package install was used instead:

```
apt-get install -y redis-server=5:7.0.15-1build2 redis-tools=5:7.0.15-1build2
redis-server --daemonize yes --port 6379 --save "" --appendonly no
```

Note: the plain `noble` pocket version (`5:7.0.15-1build2`) had to be pinned explicitly — the
default candidate from `noble-updates`/`noble-security` (`5:7.0.15-1ubuntu0.24.04.4`) 404'd when
fetched, which looks like a stale/broken mirror state for the security pocket at the time of this
audit, unrelated to this project. No `systemd` is available in this container, so `redis-server`
was started directly in the background rather than via `systemctl`/`invoke-rc.d`. This
provisioning is specific to this sandbox and is not part of the Agent Broker project; it is
recorded here only so the result is reproducible and so a future session in a fresh sandbox knows
what was done.

**Consequence for this port:** with Redis now reachable in this sandbox, every milestone's
"integration tests pass against real Redis" acceptance criterion can actually be exercised here
going forward, for both the existing TypeScript suite and the new Python suite once it exists.

## Pre-existing failures unrelated to Redis availability

None observed. Typecheck and unit tests are clean. No skipped or `.todo`/`.skip` tests were found
in `test/unit/`.
