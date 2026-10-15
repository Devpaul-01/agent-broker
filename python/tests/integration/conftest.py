"""Integration test fixtures. Mirrors ``test/helpers/redis.ts``'s philosophy exactly: these
tests need a real Redis and are never silently skipped. If Redis is unreachable, the fixture
raises loudly with instructions, the same as the TypeScript test suite does.

Database 15, same as the TypeScript suite's own ``TEST_REDIS_URL`` default
(``redis://localhost:6379/15``) — both language suites can point at the same database, which is
exactly what Milestone 5's cross-language tests will rely on.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
import redis.asyncio as redis_asyncio
from redis.exceptions import RedisError

TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")


@pytest_asyncio.fixture
async def redis_client() -> redis_asyncio.Redis:  # type: ignore[misc]
    client = redis_asyncio.Redis.from_url(TEST_REDIS_URL, decode_responses=True, socket_connect_timeout=2)
    try:
        await client.ping()
    except RedisError as cause:
        await client.aclose()
        pytest.fail(
            f"Cannot reach test Redis at {TEST_REDIS_URL}. Start one first (see "
            f"docs/python-port/BASELINE.md for provisioning this sandbox used). "
            f"These tests need a real Redis and are never skipped. Cause: {cause}"
        )
    await client.flushdb()
    try:
        yield client
    finally:
        await client.aclose()
