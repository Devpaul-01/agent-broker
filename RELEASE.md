# Release procedure

This document describes how to cut a release of `agent-broker`. It is the single source of
truth for the publish process — follow it top to bottom rather than running steps from memory.

There is currently no automated npm-publish workflow. CI (`.github/workflows/ci.yml`) validates
every push and pull request (build, typecheck, full test suite, and a packed-consumer install
test against both supported `ioredis` majors) but does not publish. Publishing is a deliberate,
manual action you take locally, described in full below.

## Versioning policy (semver)

This package follows [semantic versioning](https://semver.org/). The public API is everything
exported from `src/index.ts` — the `createBroker` factory, the `Broker` interface's methods,
and the exported types (`BrokerOptions`, `RequestPermissionInput`, `Admitted`, `Denied`,
`RegisterRootInput`, `RegisterChildInput`, etc.). Anything not exported from `src/index.ts` is
internal and can change in a patch release without notice.

- **Patch (`0.1.x`)** — bug fixes that don't change any documented behavior or type shape;
  documentation-only changes; internal refactors with no observable effect; dependency bumps
  that don't change `peerDependencies`' supported range.
- **Minor (`0.x.0`)** — new, backward-compatible public API (a new optional config field, a new
  exported function, a new non-breaking field on a result type); widening a `peerDependencies`
  range (e.g. adding support for a new `ioredis` major); raising the supported Node.js version
  floor is **not** minor — see below.
- **Major (`x.0.0`)** — any breaking change to the public API surface (removing or renaming an
  export, changing a function's parameters or return shape, changing default behavior a caller
  could be relying on, narrowing a `peerDependencies` range); raising `engines.node`'s floor
  (narrowing what environments the package runs in is a breaking change for anyone on an older
  Node); any change to a documented *guarantee* (e.g. a change to the admission script's
  atomicity properties, or to what `onRedisUnavailable` does).

Until `1.0.0`, the package is pre-1.0 and minor versions may still include small breaking
changes per the normal semver pre-1.0 convention — but prefer treating `0.x` bumps as
backward-compatible where practical, and call out any exception clearly in `CHANGELOG.md`.

### Prereleases

If you need to publish a prerelease (e.g. to let a consumer test an in-progress change), use an
npm dist-tag other than `latest` so a plain `npm install agent-broker` never picks it up:

```bash
npm version 0.2.0-beta.0 --no-git-tag-version
npm publish --tag next
```

Promote it later with a normal release once validated, and avoid incrementing the base version
again until the prerelease work actually ships as `latest`.

## Local release workflow

Run every step below, in order, before publishing. Do not skip a step to save time — each one
exists because it catches a distinct class of problem (see the "why" column).

| # | Command | What it catches |
|---|---|---|
| 1 | `npm ci` | A clean, lockfile-exact install — not whatever happens to be in `node_modules` already |
| 2 | `npm run typecheck` | Type errors that `vitest` alone wouldn't catch |
| 3 | `npm run redis:up` | Starts the local Redis the integration suite needs (`docker-compose.yml`, `redis:7-alpine` on `6379`) |
| 4 | `npm run test:unit` | Fast, no-Redis-required tests: config validation, key construction, argument validation |
| 5 | `npm run test:integration` | Redis-backed tests, including the cross-process harness (`test/helpers/harness.ts`) that forks real OS processes |
| 6 | `npm run build` | Produces `dist/` from `tsconfig.build.json` — this is what actually ships |
| 7 | `npm pack --dry-run` | Confirms the exact file list and size that will be published; compare against `package.json`'s `files` field if anything looks off |
| 8 | `npm run redis:down` | Cleans up the local Redis container |

If any of 1–7 fails, **stop** — do not proceed to versioning or publishing. Fix the failure and
re-run from step 1.

There is deliberately no single `npm run release` script that chains all of this — the pack-dry-run
output (step 7) is something a human should actually look at before the next step, not something
worth auto-approving in a script.

## Cutting the release

1. Decide the new version per the policy above.
2. Update `CHANGELOG.md`: move the `[Unreleased]` section's contents under a new
   `## [x.y.z] - YYYY-MM-DD` heading, leaving a fresh empty `[Unreleased]` section at the top.
3. Bump the version and create the matching git tag in one step:
   ```bash
   npm version <patch|minor|major>   # or an explicit version, e.g. npm version 0.2.0
   ```
   This updates `package.json`'s `version`, commits that change, and creates a `vX.Y.Z` git tag
   locally (npm's default behavior — no extra config needed here).
4. Push the commit and the tag:
   ```bash
   git push origin <branch>
   git push origin vX.Y.Z
   ```
5. Publish:
   ```bash
   npm publish
   ```
   `prepublishOnly` (defined in `package.json`) runs `npm run build` automatically as the very
   last step before the tarball is assembled, so the published `dist/` is always freshly built
   from the exact source being tagged — but this is a safety net, not a substitute for having
   already run the full workflow above.
6. Verify the publish:
   ```bash
   npm view agent-broker version
   npm view agent-broker dist-tags
   ```
   Confirm the version matches what you just published and that `latest` points to it (unless
   you intentionally published under a different dist-tag).
7. Create a GitHub Release from the `vX.Y.Z` tag, with the matching `CHANGELOG.md` section as
   the release notes.

## npm authentication

Publishing requires you to be logged in as a maintainer of the `agent-broker` package on npm
(`npm whoami` to check, `npm login` if not). This repo does not currently have npm **trusted
publishing** (GitHub Actions OIDC) configured — that's an optional future upgrade, not required
for the manual flow above. If you want it later: it requires a one-time setup on
npmjs.com (package settings → "Trusted Publisher" → link this GitHub repo and the specific
workflow file that would publish), which only an npm account owner can do; it's not something
that can be configured from inside the repository itself. Until then, publishing uses your own
locally authenticated npm credentials, as described above.

## Release safety

A release should be blocked (don't proceed past the step that fails) when:

- Any test fails (`test:unit` or `test:integration`).
- `npm run typecheck` fails.
- `npm run build` fails, or `dist/` is missing expected `.js`/`.d.ts` pairs afterward.
- `npm pack --dry-run` shows a file list that doesn't match what you expect (missing a module,
  including something it shouldn't, or a package size that jumped unexpectedly).
- The version you're about to publish doesn't match the git tag you're about to push, or a tag
  for that version already exists.

## Recovery after a bad release

npm does not allow silently overwriting a published version — once `x.y.z` is on the registry,
you cannot republish different content under the same version number. If you discover a problem
after publishing:

- **Within 72 hours and no one has depended on it yet:** `npm unpublish agent-broker@x.y.z` is
  possible but discouraged — it breaks anyone who already installed it, however briefly, and npm
  restricts unpublishing in ways that can affect the whole package name if used carelessly.
  Prefer the next option.
- **Normal case:** publish a new patch version with the fix (`x.y.z+1`) and, if the broken
  version is actively harmful (not just buggy), deprecate it so npm warns installers:
  ```bash
  npm deprecate agent-broker@x.y.z "contains a known issue, upgrade to x.y.z+1"
  ```
- A git tag that was pushed for a version you're abandoning should stay — it's a historical
  record of what was actually published, not something to delete.
