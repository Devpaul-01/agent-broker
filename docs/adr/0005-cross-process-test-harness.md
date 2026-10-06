# ADR-0005: Cross-process test harness built on child_process.fork()

**Status:** Accepted

## Context

Section 14 of the architecture requires proof, under genuine multi-process concurrency, for
three invariants: budget contention cannot overdraw a shared pool, delegation depth cannot be
bypassed by self-reported state, and correlated retries are prevented by shared circuit-breaker
state. Fake concurrency within a single process (`Promise.all` against duplicated connections
sharing one Node event loop, which is what the single-process integration tests use throughout
this project) is explicitly not an acceptable substitute — it can prove a Redis script's own
atomicity, but not that independent OS processes actually converge on correct shared state.

## Decision

A small test harness (`test/helpers/worker.ts` + `test/helpers/harness.ts`) built on
`child_process.fork()`:

- `worker.ts` is forked as a real, separate Node process. It imports the library fresh in its
  own process memory, listens for one task per IPC message (`{ task, params }`), executes it
  against its own independently-created Redis connection, and replies
  `{ ok: true, result }` / `{ ok: false, error }`.
- `harness.ts` is the parent-side driver: `spawnWorkers(count)` forks `count` independent
  processes and waits for all to report ready; `WorkerHandle.run(task)` sends one task and
  awaits exactly one reply.
- Workers run as TypeScript directly (`execArgv: ["--import", "tsx"]`), not a separate
  compiled-JS fixture, so they import `src/` the same way every other integration test does.

## Alternatives considered

- **`worker_threads`**: rejected. Worker threads share runtime state with the parent process in
  a way genuinely separate OS processes do not — using them would not actually prove the thing
  Section 14 requires; it would still be closer to "same process, different concurrency
  primitive" than a real process boundary.
- **`child_process.spawn()` with manual stdout/stdin message framing**: rejected. `spawn()`
  does give a real separate process, but requires hand-rolling a message protocol over stdio
  (delimiting messages, handling partial reads, serialization) — real engineering effort spent
  reinventing something Node's built-in IPC channel already solves for a forked child.

## Consequences

- One of the harness's own smoke tests specifically asserts that a write made inside a worker
  process is visible to the **parent's own, separately-connected** Redis client. This is the
  concrete check that rules out "same process, different promise" disguised as cross-process
  testing — if the harness ever regressed to running the worker function inline instead of
  truly forking, this is the test most likely to catch it structurally rather than by accident.
- The protocol is deliberately one-task-per-call, not pipelined, since the actual usage pattern
  across all three failure-mode tests is "many independent processes each doing one thing
  concurrently," not a sequence of operations from one process. Keeping it this simple avoided
  building request/response correlation (IDs, matching replies to in-flight calls) that nothing
  in this project currently needs — if a future test needs a worker to perform a sequence of
  dependent operations, that correlation logic would need to be added then, not preemptively now.