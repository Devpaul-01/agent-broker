# Agent Broker (Python)

Python implementation of Agent Broker — a Redis-coordinated admission controller (shared
budgets, concurrency limits, circuit breaking) for independent agent processes. This is a
genuine Python port of the TypeScript library in the repository root, not a wrapper that shells
out to Node.js: no Node.js installation is required to use this package.

**Status:** under active development. See
[`docs/python-port/FEATURE_PARITY_MATRIX.md`](../docs/python-port/FEATURE_PARITY_MATRIX.md) at
the repository root for exactly which features are implemented so far, and
[`docs/python-port/IMPLEMENTATION_PLAN.md`](../docs/python-port/IMPLEMENTATION_PLAN.md) for the
milestone roadmap. As of Milestone 1, only configuration parsing, error classes, and Redis key
construction are implemented — the core coordination operations (`request_permission`,
`report_outcome`, etc.) land in later milestones. This README will be filled out with
install/quick-start/usage documentation in Milestone 6.

## Development setup

```bash
cd python
pip install -e ".[dev]"
pytest tests/unit          # no Redis required
pytest tests/integration   # requires a reachable Redis — see tests/integration/conftest.py
```

## Relationship to the TypeScript package

Both implementations live in this one repository and can coordinate through the same Redis
instance using compatible keys, scripts, and protocol semantics — see
[`docs/python-port/ARCHITECTURE.md`](../docs/python-port/ARCHITECTURE.md) for the design. The
TypeScript package at the repository root is unaffected by this package's existence.
