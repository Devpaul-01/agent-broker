# Agent Broker — Release Readiness Findings Report

**Status:** Reconnaissance complete. No modifications made yet. This report is for review before any cleanup work begins.
**Branch:** `release-readiness-cleanup` (created off `main`; nothing committed yet)
**Repo:** https://github.com/Devpaul-01/agent-broker — cloned, HEAD `284b400`

---

## A. Current state — what's already correct and should be retained

- **Core atomicity is real and well-documented.** The admission path (`src/admission/request-permission.ts`), reservation resolution (`src/admission/resolve-reservation.ts`), `register-child.ts`, and `add-budget.ts` all use single Lua scripts for their check-then-write logic. This matches ADR-0023, ADR-0012, and ADR-0025 exactly.
- **All 26 ADRs currently match the implementation.** No stale or superseded decisions were found beyond ADR-0026, which explicitly self-marks as superseded by ADR-0004.
- **`docs/agent-broker-architecture.md` is accurate and self-aware** — it documents its own past design divergences (e.g. circuit-breaker state count) rather than silently drifting from the code.
- **Build, typecheck, and unit tests are clean as-is.** `npm run build`, `npm run typecheck`, and `npm run test:unit` (88 tests, no Redis required) all pass.
- **The packed-consumer CI test is genuinely good.** It builds, runs `npm pack`, installs the real tarball into an independent consumer project, and runs a live smoke test against Redis, across an `ioredis@^5` / `ioredis@^6` matrix. This already satisfies Phase 2's "real consumer verification" requirement — it does not need to be rebuilt.
- **`npm pack --dry-run` output is correct.** 39 files, 25.7KB packed / 81KB unpacked, matches the `files` allowlist (`dist`, `README.md`, `LICENSE`) exactly. No source leaks, `.d.ts` present for every module, no stray files sneak into the tarball.
- **The cross-process test harness (`test/helpers/harness.ts`) is strong, legitimate evidence of distributed-systems testing** — it forks real OS processes via `child_process.fork`, talks to them over IPC, and proves correctness across genuinely separate processes (not just separate async contexts): a worker's Redis write becomes visible via the parent's own connection, 5 concurrent worker processes succeed independently, and thrown errors propagate correctly over IPC.
- **`register-root`'s use of `MULTI`/`EXEC` instead of Lua is a deliberate, documented trade-off**, not a defect — the code comment explicitly owns the non-atomicity and explains why the failure window is harmless (orphan agent and/or orphan pool, both inert).
- **No TODO/FIXME/XXX markers and no dead code found anywhere in `src/`.**
- **Internal types stay internal.** `resolve-reservation.ts`'s types and function are correctly not exported from `src/index.ts` — only consumed internally by `report-outcome.ts` and `cleanup.ts`. Good encapsulation; no accidental public API surface.

---

## B. Release blockers — must fix before publishing

1. **Two accidental build artifacts are committed to the repo:** `agent-broker-0.1.0.tgz` (a 25KB packed tarball) and `diff.txt` (a leftover `git diff` of a CI workflow edit).
   - *Evidence:* both are tracked in git (`git ls-files` confirms), neither is in `.gitignore`.
   - *Why it matters:* they don't leak into the published npm tarball (outside the `files` allowlist), but they're a visible hygiene problem in a repo meant to be a portfolio centerpiece — looks like forgotten scratch work.
   - *Fix:* `git rm agent-broker-0.1.0.tgz diff.txt`; add `*.tgz` to `.gitignore`.
   - *Verification:* `git status` clean; `npm pack --dry-run` output unchanged (already confirmed these files aren't in the tarball).

2. **`package.json` is missing `repository`, `homepage`, and `bugs` fields.**
   - *Evidence:* none of these keys exist in `package.json`; the real repo is `https://github.com/Devpaul-01/agent-broker`.
   - *Why it matters:* npmjs.com won't show a repo link or issue tracker on the published package page; `npm repo` and provenance-linking tooling won't work. Standard, expected metadata for any published package.
   - *Fix:* add
     ```json
     "repository": { "type": "git", "url": "git+https://github.com/Devpaul-01/agent-broker.git" },
     "homepage": "https://github.com/Devpaul-01/agent-broker#readme",
     "bugs": { "url": "https://github.com/Devpaul-01/agent-broker/issues" }
     ```
   - *Verification:* `npm pack --dry-run --json` still produces the same file list; metadata visually inspected.

3. **README.md contains a factual API error.** The documented `DenialReason` comment for `requestPermission` (README.md:62-66) lists `'depth_exceeded'` as a possible value. That reason actually only exists on `register()`'s `RegisterDenialReason` (`src/agents/register-child.ts:16`), never on `requestPermission`'s own `DenialReason` (`src/admission/request-permission.ts:26`, which is `"unknown_agent" | "aborted" | "budget_exceeded" | "concurrency_exceeded" | "circuit_open" | "redis_unavailable" | "queue_timeout"`). The README's own later example (README.md:87-89) correctly shows `depth_exceeded` on `register()`, contradicting its earlier comment.
   - *Why it matters:* this is a real, demonstrable documentation bug a first-time reader would copy directly into error-handling code.
   - *Fix:* correct the comment to the real `requestPermission` reason list, and make sure `'aborted'` and `'queue_timeout'` are included (currently silently omitted too).
   - *Verification:* diff the corrected list against `src/admission/request-permission.ts`'s actual exported type.

4. **Stale license TODO in README.md.** Line 199 still has `<!-- TODO: Seyi — pick a license ... before publishing -->`, but `package.json` already declares `"license": "MIT"` and a filled-in `LICENSE` file already exists at repo root.
   - *Fix:* remove the stale comment. **I will not change the license itself — per your instructions I will ask before touching licensing.** Since MIT is already decided and filled in, this looks like only the TODO comment was forgotten, not an open decision — but I'll confirm with you before removing it, since licensing is explicitly something you said to stop and ask about.

---

## C. Documentation discrepancies (material mismatches between docs and implementation)

| Doc | Claim | Reality | Severity |
|---|---|---|---|
| README.md:62-66 | `requestPermission` can deny with `'depth_exceeded'` | That reason belongs only to `register()` | **Bug** — see B.3 |
| README.md + architecture.md | Neither documents `agentTtl` config option | `agentTtl` is real, independently validated (`agentTtl >= maxReservationTtl`, `src/config/index.ts:69-74`) | Gap, not contradiction |
| README.md + architecture.md | Neither documents `'aborted'` denial reason or `AbortSignal` support in queue mode | Real, implemented feature (`src/admission/queue.ts:12, 80-94`) | Gap, not contradiction |
| README.md | No stated Node.js version prerequisite | `package.json` requires `>=20`; CI only tests Node 22 | Gap — see E below for the CI-vs-engines mismatch itself |
| docs/positioning.md | Describes the core as "finished," "solid," "tested under real multi-process concurrency" | True in the narrow sense tested (the cross-process harness is real), but asserted without any cited evidence (no coverage numbers, no benchmark) | Not false, but unsupported-assurance language worth tightening per your own rule against fabricated guarantees |

No contradictions were found *between* README.md and architecture.md themselves — they share the same two gaps above rather than disagreeing with each other. All 26 ADRs match current `src/` behavior. All internal markdown links across README.md, architecture.md, and positioning.md resolve correctly — no broken links.

---

## D. Documentation gaps (missing, not wrong)

- **Standard community/maintainer docs are entirely absent:** no `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, and no `examples/` directory.
- **No documented release procedure** — nothing in the repo currently describes the version-bump → tag → publish sequence (Phase 3 of your brief asks for this).
- **`agentTtl` config option** is undocumented in both README and architecture doc despite being real and validated.
- **`'aborted'` denial reason / `AbortSignal` queue cancellation** is undocumented despite being implemented.
- **No `keywords` field** in `package.json` — hurts npm discoverability (minor, optional).
- **No troubleshooting/FAQ document** (Phase 4 §15 of your brief).

---

## E. Release automation and npm configuration — remaining work

- **`engines.node` (`>=20`) is wider than what CI actually verifies** (CI pins Node 22 only, in both the `test` and `pack-and-install` jobs). Either narrow `engines.node` to `>=22` to match what's proven, or add a Node 20 leg to the CI matrix to actually back the `>=20` claim. This is a credibility issue more than a functional one — right now the package *claims* Node 20 support with zero verification of it.
- **No automated npm publish workflow exists.** CI currently only validates (test → pack-and-install); there is no `publish.yml` triggered by a tag or GitHub Release. Per your Phase 3.3, I'd want to confirm with you whether you want:
  - a manual `npm publish` workflow you trigger locally following a documented checklist, or
  - a GitHub Actions publish job gated on a GitHub Release / tag push, using npm trusted publishing (OIDC) if your npm account supports it.
  Either is legitimate; trusted publishing requires one-time manual setup on npmjs.com that I can document but can't perform for you (it needs your npm account).
- **No documented local release workflow** (install → lint/typecheck → unit → integration → build → pack → packed-consumer test → pack-dry-run inspect → version bump → tag → publish → verify). This should be written down as a `RELEASE.md` or folded into `CONTRIBUTING.md`.
- **No versioning policy documented** (what's a patch/minor/major for this specific library's public API surface).
- **Package has never been published** — current version `0.1.0` is appropriate for a first release; I will not bump it without your direction.

---

## F. Portfolio presentation — strongest verified evidence and what documentation needs to surface it

Concrete, file-backed highlights worth making prominent (not generic claims):

1. **Single-round-trip atomic admission control** — `src/admission/request-permission.ts`'s `REQUEST_PERMISSION` Lua script performs existence → circuit-state → budget → concurrency checks and the corresponding reservation writes atomically in one `EVALSHA` call (ADR-0023). This is the strongest "why Redis + Lua" evidence in the repo.
2. **Reservation reconciliation with idempotent resolution** — `resolve-reservation.ts`'s shared script handles the refund formula (ADR-0002), guards against Redis's silent-key-recreation hazard on `INCRBY` via an `EXISTS` check (ADR-0003), and is reused identically by both explicit `reportOutcome` calls and lazy orphan cleanup — one correctness-critical code path, not two copies that can drift.
3. **Single-probe circuit recovery** (ADR-0010) implemented in 6 lines of the same script — a deliberately simple alternative to a half-open state machine, with the trade-off explicitly reasoned through in the ADR.
4. **Real cross-process testing**, not simulated: `test/helpers/harness.ts` forks genuine OS processes and verifies state visibility and error propagation across them (`test/integration/cross-process-harness.test.ts`). This is unusually rigorous for a library of this size and is a strong distributed-systems interview talking point.
5. **Broker-derived identity and depth, never caller-supplied** (ADR-0012, ADR-0024) — `register-child.ts`'s atomic script re-derives `rootId`, `budgetKey`, and `depth` from the parent record inside the same transaction that creates the child, closing a TOCTOU spoofing window.
6. **Honest, deliberate non-atomicity where it's safe** — `register-root`'s `MULTI`/`EXEC` (not Lua) is a good "trade-off awareness" story: the code comment itself states the exact failure window and why it's harmless. This is better portfolio material than if everything claimed full atomicity — it shows judgment about *where* atomicity actually matters.

For the README/architecture docs, Phase 6 of your brief wants this evidence surfaced without turning the README into an essay — I'd put the "why this is hard" material in the linked architecture doc (which already exists and is accurate) and keep the README itself focused on install → quickstart → links.

---

## G. Optional improvements (not required for a successful initial release)

- Add `keywords` to `package.json`.
- Document the `retryAfter` backoff formula's derivation (currently only a general "no usage data" caveat exists, no dedicated ADR).
- Lint pass on minor formatting inconsistencies (`resolve-reservation.ts:1` leading space, mixed indentation in `request-permission.ts` around lines 181-189 and 212-234) — cosmetic only.
- Consider an explicit doc note that admission is "two Redis round trips, not one" (the pre-script `HGET` for `budgetKey` plus the atomic script) — technically accurate already per ADR-0024's reasoning, just easy to misread from ADR-0023's "single combined script" framing in isolation.
- `examples/` directory with a couple of small runnable scripts (fake-provider style) — nice for adoption, not blocking.

---

## H. Proposed order of work (pending your approval)

1. **Repo hygiene first (cheap, zero-risk):** remove `agent-broker-0.1.0.tgz` and `diff.txt`, update `.gitignore`.
2. **package.json metadata fix:** add `repository`, `homepage`, `bugs`; decide on `engines.node` vs CI matrix (your call — narrow the claim or widen CI).
3. **README correctness fixes:** fix the `depth_exceeded` bug, remove the stale license TODO (pending your confirmation), document `agentTtl` and `'aborted'`/AbortSignal.
4. **Add missing architecture-doc content only where it's a gap, not a rewrite** (the architecture doc is already accurate — just needs the two gap items added).
5. **Write `RELEASE.md`** documenting the local release procedure and semver policy; discuss with you whether you want an automated publish workflow or a manual documented one.
6. **Add `CONTRIBUTING.md`, `SECURITY.md` (using a real reporting path — GitHub Security Advisories, since no security email exists), `CHANGELOG.md`** (unreleased section only, since nothing has shipped yet).
7. **Portfolio polish pass** on README framing and an architecture-doc section explicitly naming the engineering decisions in §F above, with file citations.
8. **Final verification sweep:** rerun build/typecheck/unit tests/pack-dry-run, confirm packed-consumer CI still passes, inspect the full diff, commit in small reviewed batches, push the branch (never to `main`).

I have **not** made any of these changes yet. Please confirm:
- Should I proceed with steps 1–3 as described?
- For `engines.node`: narrow to `>=22`, or add Node 20 to the CI matrix?
- Confirm you're fine with me removing the stale license TODO comment (the license itself stays MIT, unchanged)?
- Any changes to the proposed order in H?
