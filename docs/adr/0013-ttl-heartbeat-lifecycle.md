# ADR-0013: Agent lifecycle is TTL + heartbeat-on-call; explicit deregistration is a courtesy, not the safety net

**Status:** Accepted

## Context

Agents need a way to clean up when a process stops using them — whether that process shuts down cleanly or crashes outright. Any design that depends on code running *after* the process is gone cannot be the actual safety net, since a hard kill (`SIGKILL`, power loss, OOM-kill, segfault) guarantees no further code executes.

## Decision

Every agent registration carries a TTL, automatically refreshed as a side effect of every `requestPermission`/`reportOutcome` call from that agent (heartbeat-on-call). An idle or crashed agent simply stops heartbeating and expires on its own. `deregister()` is offered for well-behaved callers that want prompt, explicit cleanup rather than waiting out the TTL, and `SIGTERM`/`SIGINT` handlers in the consuming application can call it proactively during orderly shutdown — but this is a latency optimization on top of the real mechanism, not a substitute for it.

## Reasoning

- **TTL expiry is the only mechanism that is physically guaranteed to work**, because it doesn't depend on any code in the dying process running at all. A design that treated `deregister()` as the primary cleanup path would silently fail its actual purpose the moment a process dies hard rather than gracefully.
- **Heartbeat-on-call means active agents never spuriously expire** without requiring a separate heartbeat thread or timer — the TTL refresh rides along with calls the application was already making.
- A restarted process registers as a brand-new agent rather than attempting to "resume" a previous identity — resuming safely would require its own credential/proof system, which is out of scope and unnecessary: a fresh registration is simple, safe, and correct.

## Alternatives considered

- **Deregistration as the primary cleanup mechanism, TTL as a backstop.** Rejected: this inverts which mechanism is actually load-bearing. If `deregister()` were treated as primary, the TTL backstop would likely be configured too loosely (since "it's just a backstop"), leaving crashed agents live for longer than necessary in the common case.
- **A dedicated external heartbeat timer, independent of actual broker calls.** Rejected as unnecessary operational complexity — an agent that is genuinely idle (making no calls) has nothing for the broker to coordinate on its behalf in that window anyway, so there's no cost to letting its TTL lapse naturally.
- **Process-resume-after-crash via a stored credential.** Rejected: out of scope, and the complexity (proving "I am the same process that died") isn't justified when a fresh registration is already simple and correct.

## Consequences

- An idle agent's resources (its `agent:{agentId}` hash) are reclaimed automatically; nothing accumulates unboundedly from crashed or abandoned processes.
- Applications that want fast, visible cleanup on graceful shutdown should call `deregister()` in a `SIGTERM` handler, but must not rely on it as their only cleanup path.
- A caller that requests a very long TTL and then crashes immediately leaves that agent (and any in-flight reservations) live for the full TTL window — this is an accepted, bounded cost, not a bug.
