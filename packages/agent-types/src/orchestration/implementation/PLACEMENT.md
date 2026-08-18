# Implementation Orchestration Placement

Status: superseded placement decision; NC-03A disposition complete and NC-03B
source/declaration deprecation implemented as a compatibility candidate.
NC-03B2 classifies the root source and explicit subpath as
deprecated-transitional while preserving runtime/package compatibility.
NC-03B3 records the retained Runtime Contracts recursive-scope subpath as a
stable versioned contract surface after its owner removed the accidental root
re-export. NC-03B4 regenerated and qualified the public API and capability
documents after the independent Agent routing source owner released custody.

Historical decision: `@dzupagent/agent-types`.

The 2026-08-18 bounded source census found this surface exported from
`@dzupagent/agent-types` and exercised by DzupAgent tests, but found no external
source import of `@dzupagent/agent-types/implementation`. NC-03A then scanned
all 36 canonical repository roots, including tracked and untracked non-ignored
files, and still found zero external active consumer. Package-root dependencies
are recorded separately and do not prove use of this subpath. Do not add new
repository-shaped fields or new consumers.

Repository paths, scoped files, validation commands, scheduling, provider
preferences, and repository risk policy belong to Scripts delivery contracts.
Only genuinely generic agent-task or task-graph contracts may remain in
DzupAgent under an agent-runtime name. Reusable deterministic semantics belong
to the Datazup orchestration library.

## Current NC-03A disposition

The machine decision is
`workspace-docs/repos/workspace-root/docs/architecture/orchestration-consolidation-2026-08-12/artifacts/dzupagent-implementation-contract-disposition.v1.json`.
It classifies all 18 public exports and every interface field:

- 14 exports are repository-delivery contracts or helpers whose canonical owner
  is Scripts Repository Delivery;
- 4 declaration-only exports are unused duplicates to deprecate; and
- 0 exports qualify as generic agent-runtime contracts or host-neutral reusable
  orchestration semantics.

The existing `AgentTask` boundary under `agent-types/fleet` remains the generic
DzupAgent task contract. Every export in this implementation subpath now carries
the same `@deprecated` migration diagnostic. A semantic compiler test verifies
all 18 exports, including the root schema-constant alias, and the package
post-build verifier checks the bundled declarations without changing the four
runtime exports.

NC-03B2 records the implementation root source and `./implementation` subpath
as deprecated-transitional. The independently added Adapter Types Provider
Session Explorer root re-export is also transitional because its accepted
canonical boundary is the stable
`@dzupagent/adapter-types/provider-session-explorer` subpath. Package export
keys and runtime exports remain unchanged.

The governed API document is generated from
`config/public-api-allowlists.json`; do not edit it manually. Runtime Contracts
exposes recursive-scope only through the stable explicit subpath, and that
contract lifecycle does not admit recursive execution. Scripts must continue
to own and evolve its independent delivery contracts rather than importing
this compatibility plan.

## Historical Package Options

| Package | Decision | Rationale |
| --- | --- | --- |
| `@dzupagent/agent-types` | Accept | First slice is a shared contract surface with no runtime behavior or downstream package dependency. |
| `@dzupagent/agent` | Reject | Agent runtime behavior is a consumer of these contracts, not the first placement for them. |
| `@dzupagent/runtime-contracts` | Reject | Existing scope is runtime contract exchange; this slice starts as orchestration type placement. |
| `@dzupagent/subagents` | Reject | Subagent execution can consume the contracts later but should not own the base schema. |
| `@dzupagent/agent-adapters` | Reject | Provider adapter code is downstream from the shared implementation orchestration contract. |
| `@dzupagent/implementation-orchestrator` | Reject | A dedicated orchestrator package is premature for the first slice. |

## Dependency Rule

While compatibility remains, these files must not import Codev, Scripts,
Prisma, BullMQ, Qdrant, filesystem APIs, provider subprocess adapters, or any
other `@dzupagent/*` package. That dependency rule does not make repository
delivery a DzupAgent responsibility.

## AgentTask Mapping

| AgentTask field | Implementation orchestration meaning |
| --- | --- |
| `id` | Stable implementation task identifier used for orchestration, dependency references, and result correlation. |
| `title` | Human-readable task label for planning, review, and progress displays. |
| `prompt` | Implementation instructions passed to the worker/provider. |
| `repoId` plus repo path | Repository identity and checkout path used to bind a task to the implementation target. |
| `scopeFiles` | Allowed or expected file paths for the implementation change. |
| `acceptanceCriteria` | Required behavior and quality gates that define task completion. |
| `validationCommands` | Commands the orchestrator can run or require to verify the task result. |
| `dependsOn` | Upstream task identifiers that must complete before this task runs. |
| `risk` | Risk level used for routing, approval, or review strictness. |
| `provider` | Preferred implementation provider or adapter identity. |
| `runtimePolicy` | Execution constraints such as sandbox, network access, tool access, budget, or turn limits. |
| `maxAttempts` | Maximum implementation and repair attempts before the task is treated as blocked or failed. |
