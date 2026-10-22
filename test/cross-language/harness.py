"""Spawns a real worker subprocess (either ``py_worker.py`` or ``ts_worker.ts``, the caller's
choice) and drives it over the shared JSON-Lines stdin/stdout protocol both workers speak.

This is the thing that makes the cross-language tests in this directory genuinely cross-language:
each ``WorkerHandle`` is a real OS process running one specific language's broker implementation,
and a single test can hold one handle of each kind, send a task to one, and verify the result
through the *other* language's handle (or by reading Redis directly) — proving the two languages
actually observe the same coordination state, not just that each independently passes its own
suite.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

_CROSS_LANG_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _CROSS_LANG_DIR.parent.parent
_TYPESCRIPT_DIR = _REPO_ROOT / "typescript"

WorkerKind = Literal["python", "typescript"]


@dataclass
class WorkerResult:
    ok: bool
    result: Any = None
    error: str | None = None


class WorkerHandle:
    """A handle to one real, independent subprocess running either worker script. Tasks are not
    pipelined — one task sent, one result awaited, matching the TS harness's own "many processes
    each doing one thing concurrently" usage pattern rather than "one process doing many things
    in sequence."
    """

    def __init__(self, kind: WorkerKind) -> None:
        self.kind = kind
        if kind == "python":
            cmd = ["python3", str(_CROSS_LANG_DIR / "py_worker.py")]
        elif kind == "typescript":
            tsx = shutil.which("npx")
            if tsx is None:
                raise RuntimeError("npx not found on PATH - required to run the TypeScript worker")
            cmd = ["npx", "tsx", str(_CROSS_LANG_DIR / "ts_worker.ts")]
        else:
            raise ValueError(f"unknown worker kind: {kind}")

        # The TypeScript worker needs to run with `typescript/` as its cwd so that `npx tsx`
        # resolves node_modules and package.json ("type": "module") from the right place now
        # that the TS package lives in its own subfolder, mirroring python/'s own subfolder.
        worker_cwd = _TYPESCRIPT_DIR if kind == "typescript" else _REPO_ROOT

        self._proc = subprocess.Popen(
            cmd,
            cwd=str(worker_cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
            env={**os.environ},
        )
        self._ready_checked = False

    async def wait_until_ready(self, timeout: float = 15.0) -> None:
        if self._ready_checked:
            return
        loop = asyncio.get_running_loop()
        line = await asyncio.wait_for(loop.run_in_executor(None, self._proc.stdout.readline), timeout=timeout)  # type: ignore[union-attr]
        if not line:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""  # type: ignore[union-attr]
            raise RuntimeError(f"{self.kind} worker exited before becoming ready. stderr: {stderr}")
        msg = json.loads(line)
        if not msg.get("ok"):
            raise RuntimeError(f"{self.kind} worker failed to start: {msg.get('error')}")
        self._ready_checked = True

    async def run(self, task: str, params: dict[str, Any], config: dict[str, Any] | None = None) -> WorkerResult:
        await self.wait_until_ready()
        payload = {"task": task, "params": params}
        if config is not None:
            payload["config"] = config

        loop = asyncio.get_running_loop()

        def _send_and_recv() -> str:
            assert self._proc.stdin is not None and self._proc.stdout is not None
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                stderr = self._proc.stderr.read() if self._proc.stderr else ""
                raise RuntimeError(f"{self.kind} worker closed its output unexpectedly. stderr: {stderr}")
            return line

        line = await asyncio.wait_for(loop.run_in_executor(None, _send_and_recv), timeout=10.0)
        msg = json.loads(line)
        return WorkerResult(ok=msg["ok"], result=msg.get("result"), error=msg.get("error"))

    def kill(self) -> None:
        self._proc.kill()
        self._proc.wait(timeout=5)


async def spawn_workers(kinds: list[WorkerKind]) -> list[WorkerHandle]:
    workers = [WorkerHandle(k) for k in kinds]
    await asyncio.gather(*(w.wait_until_ready() for w in workers))
    return workers


def kill_all(workers: list[WorkerHandle]) -> None:
    for w in workers:
        w.kill()
