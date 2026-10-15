"""Root agent registration. Ports ``src/agents/register.ts`` (``registerRoot`` only — child
registration via ``REGISTER_CHILD`` lands with the rest of Milestone 3's agent-delegation work).

Needed in Milestone 2 because every ``request_permission``/``resolve_reservation`` integration
test requires a registered agent to call against — without this, Milestone 2's own coordination
code would be untestable against real Redis.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from . import keys
from .config import ResolvedConfig
from .errors import BrokerArgumentError


@dataclass(frozen=True)
class RegisterRootInput:
    budget_key: str | None = None
    initial_budget: int | None = None


@dataclass(frozen=True)
class RootAgent:
    agent_id: str
    depth: int  # always 0 for a root agent
    root_id: str
    budget_key: str


@dataclass(frozen=True)
class RegisterRootResult:
    agent: RootAgent
    pool_created: bool


def _validate(input: RegisterRootInput) -> None:
    if input.budget_key is not None and (not isinstance(input.budget_key, str) or len(input.budget_key) == 0):
        raise BrokerArgumentError("budget_key must be a non-empty string")
    if input.initial_budget is not None:
        b = input.initial_budget
        if isinstance(b, bool) or not isinstance(b, int) or b < 0:
            raise BrokerArgumentError(f"initial_budget must be a non-negative integer, got {b!r}")
    if input.budget_key is None and input.initial_budget is None:
        raise BrokerArgumentError(
            "initial_budget is required when budget_key is omitted: a private pool with no "
            "budget could never admit a call"
        )


async def register_root(config: ResolvedConfig, input: RegisterRootInput) -> RegisterRootResult:
    """Registers a root agent.

    Redis: one MULTI/EXEC pipeline holds HSET (agent record), PEXPIRE (its TTL), and — if
    ``initial_budget`` was given — SET budget NX (first creation wins, matching the TS
    implementation's own "first creation wins" semantics; a repeated ``budget_key`` with a new
    ``initial_budget`` does *not* reset an existing pool). MULTI is not rollback: if a command
    errors the others still ran, matching the TS doc comment's own reasoning for why a
    connection-drop-before-reply here is tolerated as harmless (an orphan agent record expiring
    by its own TTL, and/or a created pool).
    """
    _validate(input)

    agent_id = str(uuid.uuid4())
    budget_key = input.budget_key if input.budget_key is not None else agent_id
    now = int(time.time() * 1000)

    pipe = config.redis.pipeline(transaction=True)
    pipe.hset(
        keys.agent(agent_id),
        mapping={"depth": 0, "rootId": agent_id, "budgetKey": budget_key, "createdAt": now, "lastHeartbeat": now},
    )
    pipe.pexpire(keys.agent(agent_id), config.agent_ttl)
    if input.initial_budget is not None:
        pipe.set(keys.budget(budget_key), input.initial_budget, nx=True)

    results = await pipe.execute()

    pool_created = input.initial_budget is not None and len(results) >= 3 and results[2] is not None
    return RegisterRootResult(
        agent=RootAgent(agent_id=agent_id, depth=0, root_id=agent_id, budget_key=budget_key),
        pool_created=bool(pool_created),
    )
