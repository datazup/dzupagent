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

## Budgets

`FleetRunSpec.budgets` bounds how much **new** work a run starts. Checks happen at
dispatch boundaries only — an in-flight worker is never interrupted — and every
field is inert when unset.

| Field          | Enforced | Semantics                                                                                                        |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `wallclockMs`  | yes      | Deadline from the first line of `run()`. Once passed, no further task is dispatched. The first task always runs. |
| `maxToolCalls` | yes      | Cumulative `WorkerEvent{kind:"tool_call"}` count over completed tasks. Checked after each task.                  |
| `maxTokens`    | **no**   | Deliberately unenforceable — nothing in the fleet path reports tokens. See its doc comment in `fleet-types.ts`.  |

Tripping an enforced budget stops dispatch and routes `"budget-exhausted"` through
the escalation path below.

For deterministic tests, inject `FleetSupervisorDeps.now` (a monotonic clock) rather
than sleeping.

## Escalation

Terminal conditions are routed through `FleetPolicy.onEscalation(reason, supervisor)`
and the answer is honoured:

- `{kind:"human-handoff"}` → the run terminates with status `"escalated"`.
- `{kind:"retry", delayMs}` → the triggering task is re-dispatched **once** after
  `delayMs`. Retries are bounded at one attempt and never re-escalate, so a policy
  that always answers `retry` cannot spin. Inject `FleetSupervisorDeps.sleep` in tests
  so a policy's multi-second delay costs nothing.

Every escalation writes a `decision` envelope (`decisionKind: "escalation"`, or
`"budget-exhausted"` when a budget was the trigger) recording the reason and the
policy's answer.

Triggers:

| Reason             | Raised when                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `budget-exhausted` | `wallclockMs` or `maxToolCalls` tripped (either branch).                                 |
| `repeated-failure` | A **sequential-branch** task returned non-completed, or the dependency queue deadlocked. |

Fan-out deliberately does **not** escalate on task failure: every repo runs the same
task there, so one repo failing is a normal partial result and the run reports
`"failed"` as before.

## Dependency deferral

`DependencyTrackerPolicy.assignTask` throws when a task's `dependsOn` set is unmet.
That throw is a "not assignable yet" signal, not a run failure: the sequential branch
re-queues the task and retries it on the next pass, so tasks declared out of
topological order still run in dependency order. A full pass with zero progress means
no deferred task can ever become assignable (missing or cyclic dependency) — that is
a deadlock, escalated as `repeated-failure`.

An assignment naming a worker that does not exist is a different thing — a
programming error in the policy — and still throws out of `run()`.

## Quick start (CLI)

    yarn fleet:run --preset audit-fanout --repos shared-kit,apps/codev-app --task audit

See `scripts/fleet/README.md` for full CLI documentation.

## Spec

`docs/superpowers/specs/2026-05-28-multi-repo-fleet-orchestration-design.md`
