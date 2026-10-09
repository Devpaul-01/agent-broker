# ADR-0009: Observability hooks are fire-and-forget and never affect the broker's own result

**Status:** Accepted
**Refines:** ADR from architecture.md Section 15 (Observability)

## Context

`agent-broker` exposes four hooks (`onDecision`, `onOutcome`, `onCircuitStateChange`, `onCleanup`) so a consuming application can wire its own logging/metrics/tracing. A hook is arbitrary, integrator-supplied code. It can throw synchronously, return a rejected promise, or simply be slow.

The question this ADR settles: what happens to `requestPermission()`'s or `reportOutcome()`'s own return value and timing when the hook attached to that call misbehaves?

## Decision

Hooks are invoked through a single `fireHook()` wrapper that:
- Calls the hook synchronously, inside a `try/catch`.
- If the hook returns a Promise, attaches a `.catch()` that silently discards any rejection.
- Never awaits the hook's completion before `requestPermission`/`reportOutcome` returns to the caller.
- Never lets a thrown error or rejected promise from a hook propagate anywhere, or alter the value the broker itself returns.

In other words: a hook is told what happened, but has zero ability to affect the outcome, the latency, or the error state of the operation that triggered it.

## Reasoning

A hook exists purely to *observe*. If a buggy or slow integrator-supplied `onDecision` callback could delay or break an actual admission decision, every hook becomes a reliability risk sitting directly in the hot path of a safety-critical system — exactly backwards from what observability hooks are supposed to be. The entire point of `agent-broker` is to be the thing applications can trust to make a correct admission decision quickly; making that correctness or speed conditional on the correctness of a developer's own `console.log`-wrapping callback would undermine the one thing this library is for.

This also means there is deliberately **nowhere safe to surface a hook's own failure** — not a secondary error callback, not a rethrow, nothing. Any such mechanism just relocates the same problem (what if *that* handler also throws?) one level down without actually solving it. Swallowing is the only option that doesn't recurse.

## Alternatives considered

- **Await hooks before returning, let hook errors propagate.** Rejected outright: this makes the correctness of unrelated integrator code a dependency of the broker's own control flow, which is the exact problem this ADR exists to avoid.
- **Await hooks, but swallow their errors (synchronous-but-safe).** Rejected: this still makes a slow hook add latency to every `requestPermission`/`reportOutcome` call, which is a real, measurable cost on the hot path for a library whose own performance model (see architecture.md Section 16) is already built around "one Redis round trip, nothing more."
- **A secondary `onHookError` callback for reporting hook failures.** Rejected as solving nothing: that callback is itself a hook, and can itself throw, reintroducing the identical question one level removed.

## Consequences

- This is directly tested: `hooks.test.ts` includes a case where `onDecision` is configured to unconditionally throw, and asserts the resulting `requestPermission()` call still returns its correct, unaffected result.
- An integrator who wants guaranteed delivery of hook events (e.g., for billing-grade audit logging) cannot rely on these hooks alone — they are best-effort notification, not a durable event log. Anything requiring guaranteed delivery needs its own mechanism (e.g., writing the hook payload to a durable queue from inside the hook body, accepting that the hook *invocation* itself is still best-effort).
- Because hooks are never awaited, a hook that kicks off async work (e.g., an HTTP call to a metrics backend) runs concurrently with whatever the caller does next — there is no ordering guarantee between a hook's own side effects completing and the caller's subsequent code running.
