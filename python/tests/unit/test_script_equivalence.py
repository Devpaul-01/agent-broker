"""Verifies the Lua script sources in ``agent_broker._scripts`` are byte-identical to the
literal string in their corresponding TypeScript source file.

This is the automated version of the manual check promised in
``docs/ARCHITECTURE.md`` §23: rather than trusting that a copy-paste stayed correct,
this test re-extracts the literal template-string argument to each ``defineScript(...)`` call
directly from the TS source file (a deliberately dumb, regex-based extraction — not a full TS
parser, which would be its own maintenance burden for four call sites) and diffs it against the
Python constant.

If this test ever fails, the Lua text has drifted between languages and the shared protocol is
broken — this is treated as a hard failure, not a warning, in every milestone from here on.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agent_broker import _scripts

# Repository root is five levels up from this file: python/tests/unit/test_x.py -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
# The TypeScript package lives in its own subfolder, mirroring python/'s own subfolder.
_TYPESCRIPT_DIR = _REPO_ROOT / "typescript"


def _extract_template_literal(ts_source: str, script_const_name: str) -> str:
    r"""Extract the backtick-delimited string literal passed as the first argument of
    `const <script_const_name> = defineScript(\`...\`, N);` from a TS source file.

    Matches across the specific syntax every one of the four call sites actually uses (verified
    by inspection, see REPOSITORY_AUDIT.md): `defineScript(` followed by a backtick, the raw
    Lua text (no escaped backticks or ${...} interpolation appear in any of these four scripts,
    confirmed by inspection), a closing backtick, a comma, and the key count.
    """
    pattern = re.compile(
        rf"const\s+{re.escape(script_const_name)}\s*=\s*defineScript\(\s*`(.*?)`\s*,",
        re.DOTALL,
    )
    match = pattern.search(ts_source)
    if match is None:
        raise AssertionError(
            f"could not find `const {script_const_name} = defineScript(`...`, N)` in TS source "
            "— the extraction regex may need updating if the TS source's call-site syntax changed"
        )
    return match.group(1)


@pytest.mark.parametrize(
    "ts_file,ts_const,py_source",
    [
        ("src/admission/request-permission.ts", "REQUEST_PERMISSION", _scripts.REQUEST_PERMISSION_SOURCE),
        ("src/admission/resolve-reservation.ts", "RESOLVE_RESERVATION", _scripts.RESOLVE_RESERVATION_SOURCE),
        ("src/agents/register-child.ts", "REGISTER_CHILD", _scripts.REGISTER_CHILD_SOURCE),
        ("src/budget/add-budget.ts", "ADD_BUDGET", _scripts.ADD_BUDGET_SOURCE),
    ],
)
def test_lua_source_matches_typescript_verbatim(ts_file: str, ts_const: str, py_source: str) -> None:
    ts_path = _TYPESCRIPT_DIR / ts_file
    assert ts_path.is_file(), f"expected TS source at {ts_path}, repository layout may have changed"
    ts_source = ts_path.read_text(encoding="utf-8")
    ts_lua = _extract_template_literal(ts_source, ts_const)
    assert ts_lua == py_source, (
        f"Lua script drift detected between {ts_file} ({ts_const}) and the Python copy in "
        "_scripts.py — see docs/ARCHITECTURE.md §23. Update whichever side is stale."
    )


@pytest.mark.parametrize(
    "py_source,expected_num_keys",
    [
        (_scripts.REQUEST_PERMISSION_SOURCE, _scripts.REQUEST_PERMISSION_NUM_KEYS),
        (_scripts.RESOLVE_RESERVATION_SOURCE, _scripts.RESOLVE_RESERVATION_NUM_KEYS),
        (_scripts.REGISTER_CHILD_SOURCE, _scripts.REGISTER_CHILD_NUM_KEYS),
        (_scripts.ADD_BUDGET_SOURCE, _scripts.ADD_BUDGET_NUM_KEYS),
    ],
)
def test_declared_num_keys_matches_highest_keys_index_referenced(py_source: str, expected_num_keys: int) -> None:
    """Sanity check: the declared KEYS count should match the highest KEYS[n] actually used."""
    indices = {int(m) for m in re.findall(r"KEYS\[(\d+)\]", py_source)}
    assert indices, "script references no KEYS[n] at all — suspicious for every script in this library"
    assert max(indices) == expected_num_keys
    assert indices == set(range(1, expected_num_keys + 1)), "KEYS indices should be contiguous from 1"
