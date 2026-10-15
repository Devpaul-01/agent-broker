"""Narrow detection of "Redis is genuinely unreachable" versus any other raised exception.

Ports the *intent* of ``src/redis/unavailable.ts``, not its literal mechanism — the two
languages' Redis clients raise structurally different exception types, so this can't be a
byte-for-byte port the way the Lua scripts and key-construction are. Only connection-level
failures qualify here: a script bug, a malformed reply, or a validation error must never be
caught by this, or ``on_redis_unavailable``'s fallback path would silently hide real bugs
behind the same handling meant for infrastructure failure. This is the same design goal as the
TS version, verified against ``redis-py``'s actual published exception hierarchy rather than
assumed.

redis-py's connection-level exceptions (as of redis-py 5.x/6.x/8.x, in
``redis.exceptions``) are ``ConnectionError``, ``TimeoutError``, and the more specific
``redis.asyncio.ConnectionError`` / ``redis.asyncio.TimeoutError`` for the async client — these
are redis-py's own dedicated classes for "could not reach / lost the connection to Redis", the
direct equivalent of ioredis's ``MaxRetriesPerRequestError``. ``BusyLoadingError`` (Redis still
loading from disk after a restart) is included because it is also a "the call could not be
served right now" infrastructure condition, not a logic error — there is no equivalent case in
the TS list because ioredis retries through that state internally before raising.
"""

from __future__ import annotations

try:
    from redis.exceptions import (
        BusyLoadingError,
        ConnectionError as RedisConnectionError,
        TimeoutError as RedisTimeoutError,
    )

    _REDIS_UNAVAILABLE_TYPES: tuple[type[BaseException], ...] = (
        RedisConnectionError,
        RedisTimeoutError,
        BusyLoadingError,
    )
except ImportError:  # pragma: no cover - redis-py is a required dependency; defensive only
    _REDIS_UNAVAILABLE_TYPES = ()

# Fallback substring matching for errors that don't surface as one of the above types (e.g. a
# raw OSError from the underlying socket layer that redis-py hasn't wrapped, mirroring the TS
# version's own message-substring fallback for the same reason).
_CONNECTION_ERROR_MESSAGE_PATTERNS = (
    "Connection refused",
    "Connection closed",
    "Connection reset",
    "Error while reading from socket",
    "Timeout reading from",
    "Error 111 connecting",  # errno 111 == ECONNREFUSED, as raised by the stdlib socket module
)


def is_redis_unavailable_error(error: BaseException) -> bool:
    if isinstance(error, _REDIS_UNAVAILABLE_TYPES):
        return True
    message = str(error)
    return any(pattern in message for pattern in _CONNECTION_ERROR_MESSAGE_PATTERNS)
