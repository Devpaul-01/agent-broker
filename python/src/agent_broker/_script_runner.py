"""Lua script loading and execution — ports ``src/redis/script.ts``.

Runs a script with EVALSHA, falling back to EVAL if the server has not cached it yet. Cache
misses happen on Redis restart, ``SCRIPT FLUSH``, or failover to a replica. NOSCRIPT means the
script did not run, so retrying with EVAL cannot double-apply anything. EVAL also caches the
script server-side, so later calls take the cheap EVALSHA path again.

Supports both the sync ``redis.Redis`` and async ``redis.asyncio.Redis`` clients the caller may
have passed into the broker via separate sync and
async entry points (the broker itself only uses the async one; see ``docs/ARCHITECTURE.md`` §23), rather than one function that tries to paper over both — that kind of thin
compatibility shim is exactly what the project brief warns against ("do not introduce
async-only design... or add a thin, unreliable compatibility layer").
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Sequence

from redis.exceptions import NoScriptError


@dataclass(frozen=True)
class LuaScript:
    source: str
    number_of_keys: int
    sha: str


def define_script(source: str, number_of_keys: int) -> LuaScript:
    sha = hashlib.sha1(source.encode("utf-8")).hexdigest()  # noqa: S324 - matches Redis's own SHA1 script cache, not a security use
    return LuaScript(source=source, number_of_keys=number_of_keys, sha=sha)


def _is_noscript_error(error: Exception) -> bool:
    # redis-py raises its own dedicated NoScriptError for a NOSCRIPT server reply — more
    # reliable than message substring matching (which is what the TS implementation uses,
    # since ioredis has no equivalent dedicated exception class; see src/redis/script.ts).
    # The substring check is kept as a defensive fallback in case a future redis-py version or
    # an unusual transport path surfaces NOSCRIPT without that specific exception type.
    return isinstance(error, NoScriptError) or "NOSCRIPT" in str(error)


def run_script_sync(
    redis: Any,
    script: LuaScript,
    keys: Sequence[str],
    args: Sequence[str | int | float],
) -> Any:
    """Synchronous EVALSHA-with-EVAL-fallback, for callers using ``redis.Redis``."""
    if len(keys) != script.number_of_keys:
        raise ValueError(f"script expects {script.number_of_keys} keys, got {len(keys)}")
    try:
        return redis.evalsha(script.sha, script.number_of_keys, *keys, *args)
    except Exception as error:  # noqa: BLE001 - re-raised below unless it's specifically NOSCRIPT
        if not _is_noscript_error(error):
            raise
        return redis.eval(script.source, script.number_of_keys, *keys, *args)


async def run_script_async(
    redis: Any,
    script: LuaScript,
    keys: Sequence[str],
    args: Sequence[str | int | float],
) -> Any:
    """Async EVALSHA-with-EVAL-fallback, for callers using ``redis.asyncio.Redis``."""
    if len(keys) != script.number_of_keys:
        raise ValueError(f"script expects {script.number_of_keys} keys, got {len(keys)}")
    try:
        return await redis.evalsha(script.sha, script.number_of_keys, *keys, *args)
    except Exception as error:  # noqa: BLE001 - re-raised below unless it's specifically NOSCRIPT
        if not _is_noscript_error(error):
            raise
        return await redis.eval(script.source, script.number_of_keys, *keys, *args)
