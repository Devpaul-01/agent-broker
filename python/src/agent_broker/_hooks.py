"""Fires a hook without letting it affect the broker's own operation.

Ports ``src/hooks/fire.ts``. A hook that raises, or (for an async hook) returns a failed
awaitable, must never change ``request_permission``'s or ``report_outcome``'s own result or
latency — there is nowhere safe to surface a hook's own failure without recursing into the same
problem, so it is deliberately swallowed.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable


def fire_hook(hook: Callable[[dict[str, Any]], Any] | None, event: dict[str, Any]) -> None:
    """Fire a hook (sync or async) and swallow any failure.

    For an async hook (a coroutine function), the returned coroutine is scheduled on the
    running event loop and not awaited by the caller — matching the TS version's "not awaited
    from the caller's perspective" behavior, where any async work the hook does happens in the
    background. If there is no running event loop (e.g. a sync caller using a sync Redis
    client), an async hook's coroutine is closed immediately rather than silently leaked as an
    unexecuted coroutine object, since there is no loop to schedule it on.
    """
    if hook is None:
        return
    try:
        result = hook(event)
    except Exception:  # noqa: BLE001 - swallowed deliberately, see module docstring
        return

    if inspect.isawaitable(result):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop to schedule this on. Close it if it's a coroutine (avoids a
            # "coroutine was never awaited" warning); otherwise there's nothing more to do.
            close = getattr(result, "close", None)
            if callable(close):
                close()
            return

        task = loop.create_task(_swallow(result))
        # Prevent "Task was destroyed but it is pending" warnings if the loop shuts down before
        # the hook's background work finishes — the task's own exceptions are already swallowed
        # inside _swallow, so there is nothing further to surface here.
        task.add_done_callback(lambda _: None)


async def _swallow(awaitable: Any) -> None:
    try:
        await awaitable
    except Exception:  # noqa: BLE001 - swallowed deliberately, see module docstring
        pass
