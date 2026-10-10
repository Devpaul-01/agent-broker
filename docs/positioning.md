# Positioning: what this is today, and where I'm taking it

`agent-broker` is a cross-process coordination layer for multi-agent and multi-process LLM-calling systems. It solves three specific problems — shared-budget overspend, correlated retry storms, and unbounded recursive delegation depth — and it solves them under real cross-process concurrency, not just in theory. That part is done and tested.

It's deliberately not a routing, caching, or proxy layer — that's what Portkey, LiteLLM, or Cloudflare AI Gateway are for. Most of those tools don't attempt the narrower problem this library solves, which is why teams running real multi-agent systems end up hand-rolling exactly this kind of coordination as custom middleware on top of a gateway. `agent-broker` is meant to be that piece, so nobody has to build it themselves.

The core primitives — `agentId`, `rootId`, `parentId`, a shared budget pool, a cross-process circuit breaker — already map onto how real multi-agent delegation actually looks: an agent spawning sub-agents, multiple sessions sharing one spend ceiling, many processes hitting the same flaky downstream target at once. I built it against the shape of a real problem, not a hypothetical one, and the foundation — the atomic Lua scripts, the invariants, the cross-process test suite — is the hard part, and it's already solid.

## Where I'm taking this next

The core library is intentionally narrow: a permission gate, nothing more. What it doesn't have yet is the layer that makes it feel native to how agent systems are actually built day to day. That's the direction I'm expanding in:

- **Call metadata and tracing.** Right now an admission check only sees `{ agentId, target, estimatedCost }` — there's no session, no role, no sense of which step in a larger plan a call belongs to. The `agentId`/`rootId`/`parentId` skeleton is already there, so this is about surfacing it, not rebuilding it: I want "the planner agent burned 80% of this session's budget" to be a readable trace, not just "target X burned 80% of budget" with no link back to who caused it.
- **A real integration path.** Today, using this means wrapping every call site with `requestPermission`/`reportOutcome` by hand. That's fine for proving the design, but it's not how I want people to actually adopt it. I'm planning a thin adapter for at least one popular agent framework — something MCP-shaped, or a wrapper for something like LangGraph — so integrating this stops being hand-written plumbing around every call.
- **Visibility beyond four hooks.** `onDecision`, `onOutcome`, `onCircuitStateChange`, and `onCleanup` are real signal, but nobody adopts infrastructure that touches money without being able to see it working. I want a budget burn-down, a circuit-state timeline, a depth-tree view — most likely shipped as a separate, optional package rather than folded into the core, so the core library keeps the deliberately small observability surface it has today (see [`agent-broker-architecture.md`](agent-broker-architecture.md), Section 15, Observability).
- **Docs aimed at the right audience.** Once the above exists, the README and examples get a rewrite aimed squarely at agent-infrastructure teams. Today's docs are accurate, but they read like general distributed-systems documentation, not like something written for someone evaluating agent-platform adoption.

None of this requires touching the core. Every item above is additive — a layer built on top of a foundation I'm not planning to rearchitect.

## How I'm structuring the repo as this grows

One repository, not a split. The core `agent-broker` package stays exactly as scoped — pure gate, no provider abstraction, no prompt-awareness (see [ADR-0004](adr/0004-no-provider-abstraction.md)) — and everything above is planned as an additional, optional package or module in the same repo, not a rewrite or a fork. Almost everything that makes this trustworthy — the atomic scripts, the tested cross-process invariants — is already done, and it's the hard part. Splitting it into a second repo "reusing the necessary parts" would either duplicate the core (now there are two copies of the thing that must never have a correctness bug) or just depend on this package anyway, which collapses back into exactly the single-repo structure I'm already planning.

## Where things stand right now

The core coordination library — budget, depth, and retry-storm coordination, tested under real multi-process concurrency — is finished. Everything above is the roadmap I'm building toward, not something that exists yet. If you're looking at this today for an agent-framework integration: the safety-critical foundation is solid, and the agent-aware layer on top of it is what I'm building next.
