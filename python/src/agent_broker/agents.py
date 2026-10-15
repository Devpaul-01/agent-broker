"""Agent registration and deregistration. Ports ``src/agents/register.ts`` (root registration,
added in Milestone 2 because every ``request_permission``/``resolve_reservation`` integration
test requires a registered agent to call against), ``src/agents/register-child.ts`` (delegated
child registration, atomic via the shared ``REGISTER_CHILD`` Lua script), and
``src/agents/deregister.ts`` (immediate identity removal).
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Literal

from . import keys
from ._script_runner import define_script, run_script_async
from ._scripts import REGISTER_CHILD_NUM_KEYS, REGISTER_CHILD_SOURCE
from .config import ResolvedConfig
from .errors import BrokerArgumentError

_REGISTER_CHILD_SCRIPT = define_script(REGISTER_CHILD_SOURCE, REGISTER_CHILD_NUM_KEYS)


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


# --- Child agent registration (delegation) --------------------------------------------------


@dataclass(frozen=True)
class RegisterChildInput:
    parent_id: str


@dataclass(frozen=True)
class ChildAgent:
    agent_id: str
    depth: int
    root_id: str
    budget_key: str


RegisterDenialReason = Literal["depth_exceeded", "unknown_agent"]


@dataclass(frozen=True)
class RegisterDenial:
    allowed: Literal[False]
    reason: RegisterDenialReason


def _validate_child(input: RegisterChildInput) -> None:
    if not isinstance(input.parent_id, str) or len(input.parent_id) == 0:
        raise BrokerArgumentError("parent_id must be a non-empty string")


async def register_child(
    config: ResolvedConfig,
    input: RegisterChildInput,
) -> ChildAgent | RegisterDenial:
    """Registers a delegated child agent under ``input.parent_id``.

    Existence check, depth check, and child creation are one atomic step (the
    ``REGISTER_CHILD`` script, shared byte-for-byte with the TS implementation — see
    ``_scripts.py``): a parent that expires between a separate read and write would otherwise be
    able to delegate after death. Identity, depth, rootId and budgetKey are always derived from
    the parent by the broker — never caller input (mirrors Invariants 1 and 2 in the TS source).
    """
    _validate_child(input)
    child_id = str(uuid.uuid4())

    reply = await run_script_async(
        config.redis,
        _REGISTER_CHILD_SCRIPT,
        [keys.agent(input.parent_id), keys.agent(child_id)],
        [input.parent_id, config.max_depth, config.agent_ttl, int(time.time() * 1000)],
    )

    if isinstance(reply, (list, tuple)):
        status = reply[0]
        if status == 0:
            reason = _decode(reply[1]) if len(reply) > 1 else None
            if reason in ("unknown_agent", "depth_exceeded"):
                return RegisterDenial(allowed=False, reason=reason)  # type: ignore[arg-type]
        if status == 1 and len(reply) >= 4:
            depth = int(reply[1])
            root_id = _decode(reply[2])
            budget_key = _decode(reply[3])
            if root_id is not None and budget_key is not None:
                return ChildAgent(agent_id=child_id, depth=depth, root_id=root_id, budget_key=budget_key)

    raise RuntimeError(f"unexpected reply from register-child script: {reply!r}")


# --- Deregistration ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DeregisterResult:
    # False when the agent was already gone (expired, never existed, or already deregistered) —
    # a successful no-op, not an error, matching the project's general treatment of "the thing
    # you're removing is already gone" as expected rather than exceptional.
    deregistered: bool


async def deregister(config: ResolvedConfig, agent_id: str) -> DeregisterResult:
    """Removes an agent's identity record immediately, rather than waiting out its TTL.

    Pure identity-removal with no special-casing of outstanding reservations: every reservation
    stores its own ``budget_key`` and ``target`` directly on its hash (ADR-0003), specifically
    so reconciliation never depends on the owning agent still existing. An outstanding
    reservation against a deregistered agent resolves exactly as it would against an agent that
    simply expired by TTL — via ``resolve_reservation`` or lazy cleanup, with no awareness that
    deregistration happened at all.
    """
    if not isinstance(agent_id, str) or len(agent_id) == 0:
        raise BrokerArgumentError("agent_id must be a non-empty string")
    deleted = await config.redis.delete(keys.agent(agent_id))
    return DeregisterResult(deregistered=deleted == 1)


def _decode(value: object) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if value is None:
        return None
    return str(value)
