"""Verifies the Python package's top-level public surface mirrors ``typescript/src/index.ts``.

Every name the TypeScript package exports must be importable from ``agent_broker`` under the same
name (``createBroker`` becomes ``create_broker``, the one idiomatic rename), and ``__all__`` must
not leak lower-level internals the TypeScript package doesn't expose either.
"""

from __future__ import annotations

import re
from pathlib import Path

import agent_broker

# python/tests/unit/test_x.py -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TS_INDEX = _REPO_ROOT / "typescript" / "src" / "index.ts"

# Python-only additions to the top-level surface, each with a reason.
_PYTHON_ONLY = {
    # BrokerOptions embeds it as a typed dataclass; TS expresses the same shape inline.
    "CircuitBreakerOptions",
}
_RENAMED = {"createBroker": "create_broker"}


def _ts_exported_names() -> set[str]:
    source = _TS_INDEX.read_text(encoding="utf-8")
    names: set[str] = set()
    for match in re.finditer(r"export\s+(?:type\s+)?\{([^}]*)\}", source):
        for raw in match.group(1).split(","):
            name = raw.strip()
            if name:
                names.add(name)
    return names


def test_every_typescript_export_is_exported_from_python() -> None:
    expected = {_RENAMED.get(name, name) for name in _ts_exported_names()}
    assert expected, "failed to parse any exports from typescript/src/index.ts"
    missing = expected - set(agent_broker.__all__)
    assert not missing, f"exported by typescript/src/index.ts but not by agent_broker: {sorted(missing)}"


def test_python_exports_nothing_beyond_the_typescript_surface() -> None:
    expected = {_RENAMED.get(name, name) for name in _ts_exported_names()} | _PYTHON_ONLY
    extra = set(agent_broker.__all__) - expected
    assert not extra, f"exported by agent_broker but not by typescript/src/index.ts: {sorted(extra)}"


def test_every_name_in_all_is_actually_importable() -> None:
    for name in agent_broker.__all__:
        assert hasattr(agent_broker, name), f"__all__ lists {name!r} but it is not defined"
