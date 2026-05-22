# Flow and Orchestration Authoring Surfaces

This document maps the public authoring surfaces for DzupAgent flow documents,
text DSL input, compiler expansion, and runtime orchestration. It is the
cross-package ownership reference for keeping flow authoring and agent
orchestration contracts aligned.

## Package Ownership

| Package | Owner Surface | Public Contract |
| --- | --- | --- |
| `@dzupagent/flow-ast` | Flow AST types, parsers, and validators | `FlowDocumentV1` |
| `@dzupagent/flow-dsl` | Textual YAML-like DSL normalization, formatting, validation, and graph projection | `dzupflow/v1`, `dzupflow/v1alpha-agent` |
| `@dzupagent/flow-compiler` | Semantic resolution and target artifact expansion from validated flow documents | compiler artifacts and diagnostics |
| `@dzupagent/agent` | Runtime tool loops, guardrails, workflow execution, planning, and team coordination | `PlanningAgent.ExecutionPlan`, `TeamDefinition` |
| `@dzupagent/agent-adapters` | Provider adapter orchestration, adapter workflow authoring, routing, and execution bridges | `AdapterWorkflowBuilder` |

## Public Authoring Contracts

- `FlowDocumentV1` is the canonical typed flow document owned by
  `@dzupagent/flow-ast`. Authoring surfaces should normalize into this shape
  before compiler expansion or runtime execution.
- `dzupflow/v1` is the stable textual DSL discriminator accepted by
  `@dzupagent/flow-dsl`; `dzupflow/v1alpha-agent` extends it for agent and
  validation nodes while that surface is still staged.
- `@dzupagent/flow-compiler` consumes validated flow documents and expands
  semantic profiles, policies, tools, and target-specific artifacts. It should
  not become the source of authored AST validation rules.
- `PlanningAgent.ExecutionPlan` is the structured planning output used by
  orchestration flows in `@dzupagent/agent`.
- `TeamDefinition` is the declarative multi-agent team spec resolved by the
  `@dzupagent/agent` team runtime.
- `AdapterWorkflowBuilder` is the adapter-level workflow authoring surface in
  `@dzupagent/agent-adapters` for provider orchestration that does not require
  a full flow document.

## Boundary Rules

- Keep authored flow shape validation in `@dzupagent/flow-ast`.
- Keep text DSL parsing and normalization in `@dzupagent/flow-dsl`.
- Keep profile, policy, and target expansion in `@dzupagent/flow-compiler`.
- Keep runtime execution and team orchestration in `@dzupagent/agent`.
- Keep provider-specific orchestration, routing, and adapter workflow helpers
  in `@dzupagent/agent-adapters`.
