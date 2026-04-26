# Dependency Advisory Audit (QF-SEC-07)

This document defines the repeatable dependency-risk evidence step for the
DzupAgent monorepo. It exists to satisfy the audit finding that no
repo-local advisory scan gate was previously documented, leaving dependency
exposure unproven for releases.

The gate is intentionally **observational**, not blocking. The goal is to
produce a captured artifact for each release that proves the advisory
state of the dependency graph at release time. Findings should only
trigger a dependency upgrade when a CVE is narrow, immediately
actionable, and tied to a package we actually use at runtime.

## Scripts

The following scripts are wired in the root `package.json`:

| Script | Command | Purpose |
| --- | --- | --- |
| `yarn audit:deps` | `yarn audit` | Full advisory listing across the workspace, one entry per advisory path. |
| `yarn audit:deps:summary` | `yarn audit --summary` | One-line totals (Low / Moderate / High / Critical). |

The repo uses **Yarn 1.22.x (Yarn Classic)**, so the Yarn Berry
`yarn npm audit --recursive` form is **not** available. Yarn Classic's
`yarn audit` already audits across all workspaces by default — there is
no extra `--recursive` flag.

## How to run from the repo root

```bash
# From /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent
yarn audit:deps:summary   # quick totals
yarn audit:deps           # full per-advisory table
```

To capture release evidence:

```bash
mkdir -p audit/release-evidence
yarn audit:deps > audit/release-evidence/$(date +%Y-%m-%d)-audit.txt 2>&1 || true
yarn audit:deps:summary >> audit/release-evidence/$(date +%Y-%m-%d)-audit.txt 2>&1 || true
```

The trailing `|| true` is required — see "Exit codes" below. Without it,
the shell will halt the release script even though the audit ran
successfully.

## Expected output format

`yarn audit:deps:summary` produces a compact line:

```
yarn audit v1.22.22
N vulnerabilities found - Packages audited: M
Severity: <low> Low | <moderate> Moderate | <high> High | <critical> Critical
Done in <duration>s.
```

Sample at the time this gate was introduced (2026-04-26):

```
54 vulnerabilities found - Packages audited: 942
Severity: 1 Low | 41 Moderate | 12 High
```

`yarn audit:deps` (full mode) prints one box-drawn table per advisory
path. Each table contains: severity, advisory title, Package, Patched
in, Dependency of (top-level workspace), Path (full dependency chain),
and a More info URL pointing at npmjs.com/advisories.

When the same advisory is reachable through multiple workspaces or
multiple chains, it appears once per chain — this is expected and is
why the per-chain count can exceed the unique advisory count.

## Release evidence procedure

For each release:

1. From the repo root, run:
   ```bash
   yarn audit:deps > audit-results.txt 2>&1 || true
   ```
2. Attach `audit-results.txt` to the release artifact bundle (changeset
   PR, GitHub Release notes, or `audit/release-evidence/`).
3. In the release notes, paste the final summary line so it is visible
   without opening the attachment.
4. If any **High** or **Critical** entries are present, file a
   follow-up ticket per affected top-level workspace. Do **not** block
   the release on Moderate/Low entries unless the chain is reachable
   from a runtime path under direct control (i.e. not a transitive
   dependency of a third-party SDK).

## Exit codes

`yarn audit` returns a non-zero exit code as a bitmask when any
advisory is found:

| Bit | Value | Severity |
| --- | --- | --- |
| 0 | 1 | Info |
| 1 | 2 | Low |
| 2 | 4 | Moderate |
| 3 | 8 | High |
| 4 | 16 | Critical |

A current run reports exit code `14` = `2 + 4 + 8` (Low + Moderate +
High). This non-zero exit must **not** fail CI for this gate, because
the gate is observational. Always wrap the call in `|| true` when
embedding it in a release script, or invoke it as a standalone job that
captures the artifact before reporting status.

## Known issues with the advisory command in this workspace

- **Yarn Berry syntax does not work.** `yarn npm audit --recursive` is
  Yarn 2+/Berry syntax. This repo is on Yarn 1 (`packageManager:
  yarn@1.22.22`), so that command fails with `Command "npm" not found.`
  Use `yarn audit` instead.
- **No `--json` aggregation by default.** `yarn audit --json` emits
  newline-delimited JSON, one record per advisory chain plus a final
  summary record. Downstream tooling that wants a single JSON document
  must concatenate these lines and parse them.
- **Transitive churn.** Many of the current findings are reached
  exclusively through third-party SDKs (for example `mssql`,
  `snowflake-sdk`, `@langchain/core`) where we do not control the
  transitive `uuid` / `tar` / `request` versions. These should be
  tracked as upstream issues, not local upgrades.
- **Network dependent.** `yarn audit` calls the npm registry advisory
  API. In offline or restricted-egress environments, the gate will
  fail to fetch and produce no findings — this must be treated as
  "evidence not captured" and re-run from a network-enabled host
  before the release is finalised.

## Scope and non-goals

- This gate does **not** automatically open PRs to upgrade flagged
  dependencies.
- This gate does **not** replace SCA tooling (Snyk, GitHub Dependabot,
  Socket). It complements them by producing a deterministic local
  artifact at release time.
- Broad bumps triggered by this gate are out of scope. Only narrow,
  immediately actionable CVEs should drive an in-line upgrade in the
  same release.
