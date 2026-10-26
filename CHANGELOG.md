# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/) (see [RELEASE.md](RELEASE.md) for how it's applied
pre-1.0).

## Release status

| Package | Registry | Status |
|---|---|---|
| TypeScript (`typescript/`) | [npm: `agent-broker`](https://www.npmjs.com/package/agent-broker) | **Published.** First version released on 2026-10-21. |
| Python (`python/`) | PyPI | **Not yet published.** Feature-complete against the TypeScript API, but there is no PyPI release yet. |

## [Unreleased]

### Added
- GitHub Actions CI is now split into three path-filtered workflows —
  `.github/workflows/typescript.yml`, `python.yml` and `cross-language.yml` — so the Python
  suite (mypy strict, unit, integration, wheel build) and the cross-language suite finally run in
  CI alongside the TypeScript one. Previously only the TypeScript tests ran.
- Python: `Broker.register()`, a single registration method that takes either a
  `RegisterRootInput` or a `RegisterChildInput`, matching the TypeScript `broker.register()`.
  `register_root()` / `register_child()` remain as aliases.
- Python: `tests/unit/test_public_api.py`, which fails if the top-level `agent_broker` exports
  drift from `typescript/src/index.ts`.
- README: noted that a LangGraph-native integration is currently in development (not yet
  released).

### Changed
- Python: the top-level `agent_broker` public API now mirrors `typescript/src/index.ts`. It
  exports `create_broker`, `Broker`, the option/input/result types, the denial-reason types
  and the error classes. Lower-level functions (`request_permission`, `register_root`,
  `parse_config`, `resolve_reservation`, `sweep_expired_reservations`, …) and the `keys` module
  are no longer re-exported from the package root; import them from their submodules
  (e.g. `agent_broker.admission`, `agent_broker.keys`). The Python package has not been
  published, so no released version is affected.
- Renamed `docs/agent-broker-architecture.md` to `docs/ARCHITECTURE.md` and updated every link
  to it.

### Fixed
- Cross-language tests: `ts_worker.ts` could not resolve `ioredis` after the TypeScript package
  moved into `typescript/`, so every TypeScript-worker test failed. The harness now sets
  `NODE_PATH` to `typescript/node_modules`.

## [0.1.1] - 2026-10-21

First version of the TypeScript package published to npm.

### Fixed
- README.md and `docs/ARCHITECTURE.md` both incorrectly listed `'depth_exceeded'`
  as a possible `requestPermission()` denial reason. It is a `register()`-only reason;
  `requestPermission()`'s real `DenialReason` type never includes it. Both docs corrected.

### Added
- `repository`, `homepage`, `bugs`, and `keywords` fields in `package.json`.
- `RELEASE.md` — documented local release workflow, semver policy, and recovery procedure.
- `CONTRIBUTING.md` — local setup, check list, and PR expectations.
- `SECURITY.md` — vulnerability reporting via GitHub Security Advisories.
- Documentation for the `agentTtl` config option and the `'aborted'` denial
  reason / `AbortSignal`-based queue cancellation (both already implemented, previously
  undocumented in README.md and the architecture doc).
- Node.js version prerequisite stated explicitly in the README install section.

### Changed
- `engines.node` narrowed from `>=20` to `>=22` in `package.json`, to match what CI actually
  verifies (CI has only ever tested Node 22).

### Removed
- Stray committed build artifacts (`agent-broker-0.1.0.tgz`, `diff.txt`) that had no reason to be
  in version control; added `*.tgz` to `.gitignore` to prevent recurrence.
- Stale "pick a license before publishing" TODO comment in the README (the license itself — MIT —
  was already decided and the `LICENSE` file already filled in; only the leftover comment was
  stale).
