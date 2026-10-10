# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/) (see [RELEASE.md](RELEASE.md) for how it's applied
pre-1.0).

Nothing has been published to npm yet. Everything below is pre-first-release work.

## [Unreleased]

### Fixed
- README.md and `docs/agent-broker-architecture.md` both incorrectly listed `'depth_exceeded'`
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
