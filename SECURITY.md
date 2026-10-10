# Security policy

## Reporting a vulnerability

Please report suspected security issues privately using
[GitHub Security Advisories](https://github.com/Devpaul-01/agent-broker/security/advisories/new)
for this repository, rather than opening a public issue. This lets the issue be assessed and
fixed before it's publicly disclosed.

Include, as applicable: the affected version, a description of the issue, and reproduction steps
or a minimal example. There is currently no fixed response-time SLA for this project — it's
maintained on a best-effort basis — but reports will be acknowledged and triaged.

## Scope

`agent-broker` is an in-process coordination library. Its [trust model](README.md#trust-model) is
explicit about what it does and doesn't protect against: it protects against *accidental* and
*architectural* misuse within a cooperating system, not against a malicious, non-cooperating
caller inside the same process (see the README's "Trust model" section and
[docs/agent-broker-architecture.md §17](docs/agent-broker-architecture.md#17-security-and-trust-boundaries)
for the full boundary discussion). Reports about behavior that falls inside that already-documented
boundary (e.g. "a caller can misreport `actualCost` to `reportOutcome`") are known, by-design
limitations, not vulnerabilities — but a report that identifies a way to violate a guarantee the
library *does* claim to provide (for example, a way to make the atomic admission script behave
non-atomically) is exactly the kind of thing this process exists for.

## Supported versions

Pre-1.0, only the latest published minor version receives fixes. This will be revisited once the
package reaches `1.0.0`.
