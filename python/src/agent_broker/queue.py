"""Queue mode: ``request_permission_queued``. Ports ``src/admission/queue.ts``.

A pure retry wrapper around ``request_permission`` with exponential, jittered, capped backoff —
every attempt goes through the exact same atomic admission script as a non-queued call. Queue
mode changes call cadence, never admission correctness; no change to the Lua script was needed
to build this, in either language.

Cancellation: the TS version takes an optional ``AbortSignal``, checked at the top of every poll
iteration and raced against the current sleep. Python's natural equivalent of "the surrounding
caller wants to stop waiting" is ``asyncio.CancelledError`` propagating into this coroutine from
its own enclosing task — which already works for free here, since every ``await`` point (the
attempt itself, and the sleep) is a valid cancellation point, and a cancelled sleep raises
``asyncio.CancelledError`` the same way an aborted TS sleep rejects. On top of that, this module
also accepts an optional ``asyncio.Event`` as a cooperative, non-exception alternative for
callers who want ``{"allowed": False, "reason": "aborted"}`` returned rather than an exception
propagating — directly matching the TS signal's return-a-value-not-throw behavior, which a bare
reliance on ``CancelledError`` alone would not reproduce (cancelling a task makes the *task*
raise, it does not make this function return a value to a still-running caller).
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from .admission import Admitted, Denied, RequestPermissionInput
from .config import ResolvedConfig
from .errors import BrokerArgumentError

_NON_QUEUEABLE = frozenset({"unknown_agent"})

_INITIAL_BACKOFF_MS = 50
_MAX_BACKOFF_MS = 1_000
_JITTER_RATIO = 0.2


def _next_backoff(previous_ms: float) -> float:
    capped = min(previous_ms * 2, _MAX_BACKOFF_MS)
    jitter = capped * _JITTER_RATIO * (random.random() * 2 - 1)
    return max(10.0, round(capped + jitter))


@dataclass(frozen=True)
class QueueOptions:
    queue_timeout: int
    # Cooperative cancellation, checked at the top of every poll iteration and raced against the
    # current sleep - the Python analog of the TS AbortSignal. Optional: a caller who only wants
    # ordinary asyncio.Task.cancel() semantics (raising CancelledError into this coroutine) needs
    # to pass nothing here at all; that path works without any special support from this module.
    cancel_event: asyncio.Event | None = None


def _validate_queue_options(options: QueueOptions) -> None:
    qt = options.queue_timeout
    if isinstance(qt, bool) or not isinstance(qt, int) or qt <= 0:
        raise BrokerArgumentError(f"queue_timeout must be a positive integer (ms), got {qt!r}")
    if options.cancel_event is not None and not isinstance(options.cancel_event, asyncio.Event):
        raise BrokerArgumentError("cancel_event must be an asyncio.Event, if provided")


async def _sleep(seconds: float, cancel_event: asyncio.Event | None) -> None:
    """Sleeps for ``seconds``, waking early (and raising) if ``cancel_event`` fires first.

    Mirrors the TS ``sleep()`` helper's race-the-signal behavior, implemented with
    ``asyncio.wait`` racing a plain sleep task against ``cancel_event.wait()`` rather than a
    timer+listener pair, since that is the idiomatic asyncio equivalent of racing a timeout
    against an abort signal.
    """
    if cancel_event is None:
        await asyncio.sleep(seconds)
        return
    if cancel_event.is_set():
        raise asyncio.CancelledError("aborted")

    sleep_task = asyncio.ensure_future(asyncio.sleep(seconds))
    cancel_task = asyncio.ensure_future(cancel_event.wait())
    try:
        done, pending = await asyncio.wait({sleep_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()
        if cancel_task in done:
            raise asyncio.CancelledError("aborted")
    finally:
        for t in (sleep_task, cancel_task):
            if not t.done():
                t.cancel()


async def request_permission_queued(
    config: ResolvedConfig,
    input: RequestPermissionInput,
    queue_options: QueueOptions,
    attempt: Callable[[ResolvedConfig, RequestPermissionInput], Awaitable[Admitted | Denied]],
) -> Admitted | Denied:
    """Polls ``attempt`` (normally ``request_permission`` itself) with exponential backoff until
    admitted, ``queue_options.queue_timeout`` elapses, or a non-queueable denial (currently only
    ``unknown_agent``) is hit.

    ``attempt`` is injected rather than this module calling ``request_permission`` directly, the
    same as the TS version's own design — it keeps this module decoupled from ``admission.py``
    and makes it trivially testable with a fake attempt function that doesn't need real Redis.
    """
    _validate_queue_options(queue_options)

    if queue_options.cancel_event is not None and queue_options.cancel_event.is_set():
        return Denied(allowed=False, reason="aborted")

    deadline = time.monotonic() + queue_options.queue_timeout / 1000
    backoff_ms: float = _INITIAL_BACKOFF_MS

    while True:
        result = await attempt(config, input)
        if result.allowed:
            return result
        if result.reason in _NON_QUEUEABLE:
            return result

        if queue_options.cancel_event is not None and queue_options.cancel_event.is_set():
            return Denied(allowed=False, reason="aborted")

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return Denied(allowed=False, reason="queue_timeout")

        backoff_ms = _next_backoff(backoff_ms)
        sleep_seconds = min(backoff_ms / 1000, remaining)
        if queue_options.cancel_event is None:
            # No cooperative cancel_event in play: an external asyncio.Task.cancel() on this
            # coroutine's own task is the only way a CancelledError can reach this await, and it
            # must propagate as itself - converting it to a returned denial here would hide a
            # real cancellation from the caller that issued it.
            await asyncio.sleep(sleep_seconds)
        else:
            try:
                await _sleep(sleep_seconds, queue_options.cancel_event)
            except asyncio.CancelledError:
                # _sleep raises CancelledError in exactly two cases: cancel_event fired (the
                # case this except clause is for - return a denial, matching the TS signal's
                # return-a-value contract), or this coroutine's own task was cancelled
                # externally while awaiting inside _sleep (which must propagate, not be
                # swallowed as a denial). Distinguish them by checking the event directly:
                # genuine task cancellation leaves cancel_event unset.
                if queue_options.cancel_event.is_set():
                    return Denied(allowed=False, reason="aborted")
                raise
