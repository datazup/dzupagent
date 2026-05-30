# Flow and Orchestration Authoring Surfaces

This document maps the public authoring surfaces for flow and orchestration across the DzupAgent framework.

## Package Ownership

| Package | Authoring Surface | Schema / Version |
|---------|------------------|-----------------|
| `@dzupagent/flow-ast` | Flow AST parse + validate primitives | `FlowDocumentV1` |
| `@dzupagent/flow-dsl` | Flow DSL builder — TypeScript-first flow construction | `dzupflow/v1` |
| `@dzupagent/flow-compiler` | Flow compiler — lowers flow AST to pipeline graph | (compile-time) |
| `@dzupagent/agent` | Agent runtime, guardrails, tool loops, workflow execution | (runtime) |
| `@dzupagent/agent-adapters` | Adapter orchestration, multi-agent patterns, workflow DSL | `AdapterWorkflowBuilder` |

## Key Types

- **`FlowDocumentV1`** — the root document type produced by `@dzupagent/flow-ast` parse. Schema version string: `dzupflow/v1`.
- **`AdapterWorkflowBuilder`** — fluent workflow DSL from `@dzupagent/agent-adapters`; compiles to a `AdapterWorkflow` that the orchestration engine executes.
- **`PlanningAgent.ExecutionPlan`** — structured plan output from planning-agent runs; used to drive multi-step flow execution.
- **`TeamDefinition`** — declarative multi-agent team spec; resolved by the orchestration layer to spawn and coordinate agents.

## Authoring Entry Points

1. **Flow DSL** (`@dzupagent/flow-dsl`): author flows in TypeScript with full type safety, then compile via `@dzupagent/flow-compiler`.
2. **Workflow builder** (`@dzupagent/agent-adapters`): use `AdapterWorkflowBuilder` for adapter-level orchestration without a full flow document.
3. **Planning agent**: emit `PlanningAgent.ExecutionPlan` from a planning run and drive execution via the flow runtime.
4. **Team definition**: declare a `TeamDefinition` and hand it to the orchestration facade for multi-agent coordination.

## Schema Versioning

All flow documents carry a `$schema: 'dzupflow/v1'` field. Breaking schema changes require a new major version and a migration shim in `@dzupagent/flow-ast`.
