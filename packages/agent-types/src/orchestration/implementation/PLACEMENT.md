# Implementation Orchestration Placement

Decision: `@dzupagent/agent-types`

## Package Options

| Package | Decision | Rationale |
| --- | --- | --- |
| `@dzupagent/agent-types` | Accept | First slice is a shared contract surface with no runtime behavior or downstream package dependency. |
| `@dzupagent/agent` | Reject | Agent runtime behavior is a consumer of these contracts, not the first placement for them. |
| `@dzupagent/runtime-contracts` | Reject | Existing scope is runtime contract exchange; this slice starts as orchestration type placement. |
| `@dzupagent/subagents` | Reject | Subagent execution can consume the contracts later but should not own the base schema. |
| `@dzupagent/agent-adapters` | Reject | Provider adapter code is downstream from the shared implementation orchestration contract. |
| `@dzupagent/implementation-orchestrator` | Reject | A dedicated orchestrator package is premature for the first slice. |

## Dependency Rule

Implementation orchestration files must not import Codev, scripts, Prisma, BullMQ, Qdrant, filesystem APIs, provider subprocess adapters, or any other `@dzupagent/*` package.

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
