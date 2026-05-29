# orchestration/fleet

Multi-repo fleet orchestration primitives for dzupagent.

## What this is

A `FleetSupervisor` coordinates N `RepoAgent`s (one per repository) running in parallel, sharing a `KnowledgeStore`. Each `RepoAgent` wraps an `Executor` — either `InProcessExecutor` (tests, cheap runs) or `CodexSubprocessExecutor` (real Codex CLI per repo).

Four `FleetPolicy` implementations match the four scenarios in the spec:

- `FanOutPolicy` — same task to every repo (audit-fanout).
- `DependencyTrackerPolicy` — DAG over `FleetTask.dependsOn` (independent-tasks).
- `SupervisorPolicy` — round-robin + contract reconciliation (coordinated-feature).
- `ContractNetPolicy` — bid-based assignment (continuous-fleet).

## When to use what

| You want…                                                | Use                                                    |
| -------------------------------------------------------- | ------------------------------------------------------ |
| To audit N repos in parallel and merge findings          | `FanOutPolicy` + `audit-fanout` preset                 |
| To run multiple independent tasks across repos with deps | `DependencyTrackerPolicy` + `independent-tasks` preset |
| To make a cross-repo feature change with contract sync   | `SupervisorPolicy` + `coordinated-feature` preset      |
| A long-running queue-fed worker pool                     | `ContractNetPolicy` + `continuous-fleet` preset        |

## Quick start (CLI)

    yarn fleet:run --preset audit-fanout --repos shared-kit,apps/codev-app --task audit

See `scripts/fleet/README.md` for full CLI documentation.

## Spec

`docs/superpowers/specs/2026-05-28-multi-repo-fleet-orchestration-design.md`
