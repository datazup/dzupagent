# Flow and Orchestration Authoring Surfaces

Date: 2026-05-02

## Purpose

DzupAgent currently has several real workflow and orchestration authoring surfaces. They are related, but they are not interchangeable. This matrix keeps the canonical flow stack, adapter workflow builder, planning DAG, and team runtime contracts separate so future implementation plans do not collapse distinct semantics into one "DSL" bucket.

This document is framework-scoped. Product concepts such as tenants, workspaces, projects, tasks/subtasks, personas, prompt-template catalogs, and operator UX belong in consuming applications such as Codev.

## Surface Matrix

| Surface | Owner | Primary input | Compile/lower target | Runtime executor | Supported semantics | Explicitly not promised | Migration/status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FlowDocumentV1` | `@dzupagent/flow-ast` and `@dzupagent/flow-compiler` | Canonical object document with typed nodes and edges | Compiler AST, validation result, semantic resolution, lowered artifacts such as skill-chain or pipeline-compatible shapes | Host-selected runtime; compiler does not make all lowered targets executable by itself | Stable canonical IDs, node kinds, graph validation, route/classify/approval/clarification/persona node shape, semantic validation | Adapter provider fallback, provider-specific retry policy, adapter workflow events, app tenant/workspace/task state | Canonical framework contract. Preserve and extend this instead of inventing incompatible flow languages. |
| `dzupflow/v1` textual DSL | `@dzupagent/flow-dsl` | Text/YAML-like authoring form with top-level `steps` | `normalizeDslDocument()` / `parseDslToDocument()` discriminated results, `FlowDocumentV1`, graph projection, canonicalized root input | Same as `FlowDocumentV1` after successful canonicalization and compilation | Human-editable syntax, document normalization, formatting, validation, graph projection | Raw `nodes`/`edges` graph authoring, adapter-only provider behavior, product UI semantics | Authoring sugar over `FlowDocumentV1`. `document` is populated only when `ok: true`; diagnostic failures expose `partialDocument` only for explicit inspection. |
| `AdapterWorkflowBuilder` | `@dzupagent/agent-adapters` | Fluent TypeScript builder via `defineWorkflow()` / `AdapterWorkflowBuilder` | `PipelineDefinition` plus node handlers | `PipelineRuntime` from `@dzupagent/agent` with adapter registry execution | Provider execution steps, parallel/branch/transform/loop nodes, prompt templating, registry fallback, adapter workflow lifecycle events, checkpoints/session behavior | Canonical `FlowDocumentV1` equivalence, compiler-owned semantic validation, app product orchestration state | Compatibility/provider workflow surface. It can share pipeline contracts with compiled flows, but adapter-owned semantics remain separate. |
| `PlanningAgent.ExecutionPlan` | `@dzupagent/agent` orchestration | Programmatic DAG or LLM decomposition output: nodes with `id`, `task`, `specialistId`, `input`, `dependsOn` | Execution levels built by `buildExecutionLevels()` and validated by `validatePlanStructure()` | `PlanningAgent.executePlan()` via `DelegatingSupervisor.delegateAndCollect()` | DAG dependency validation, level-by-level execution, bounded parallelism, predecessor result injection, node-ID result correlation | Flow syntax parsing, provider adapter workflow semantics, product task ledger/review UX | Orchestration execution contract, not a flow authoring language. It may be a future lowering target when a formal flow-to-planning contract exists. |
| `TeamDefinition` | `@dzupagent/agent` orchestration team runtime | Declarative team participants, coordinator pattern, policies, phases/checkpoints | Team runtime phase/checkpoint model | `TeamRuntime.execute()` / `TeamRuntime.resume()` | Team coordination skeletons, participant/team events, supervision policy, checkpoint/resume contracts, tracer hooks | End-user workflow DSL syntax, product-owned tenant/workspace/project/task routing, complete model/tool wiring policy | Framework team execution contract. Use when the runtime shape is a team, not as a replacement for canonical flow documents. |

## Boundary Rules

1. `FlowDocumentV1` and `dzupflow/v1` are the canonical DzupFlow surfaces. Textual DSL is an authoring form that must normalize and validate before it is treated as canonical.
2. `AdapterWorkflowBuilder` is adapter-owned compatibility DSL. It compiles to `PipelineDefinition`; it does not imply full equivalence with compiler-owned flow semantics.
3. `PlanningAgent.ExecutionPlan` is an execution DAG for delegation. It is not a syntax surface and should keep stable node IDs when used as a lowering target.
4. `TeamDefinition` is a team runtime declaration. It should stay separate from flow syntax unless a compiler target explicitly lowers a flow into a team runtime plan.
5. Product state and UX live outside this matrix. Apps may map framework surfaces onto tenants, projects, tasks, personas, review gates, and operator screens, but those fields should not leak into framework contracts.

## Valid Migration Paths

Supported now:

- `dzupflow/v1` -> `@dzupagent/flow-dsl` normalization/canonicalization -> `FlowDocumentV1`
- `FlowDocumentV1` -> `@dzupagent/flow-compiler` validation/semantic resolution -> lowered artifact
- `AdapterWorkflowBuilder` -> `PipelineDefinition` -> `PipelineRuntime`
- `PlanningAgent.ExecutionPlan` -> `PlanningAgent.executePlan()` -> delegation results keyed by node ID
- `TeamDefinition` -> `TeamRuntime.execute()` / `resume()`

Allowed future work:

- `FlowDocumentV1` -> explicit planning-DAG target, preserving `sourceKind`, source hash, compile ID, canonical node IDs, and lowered target metadata.
- `FlowDocumentV1` -> explicit team-runtime target for flows that truly describe team phases/checkpoints.
- Adapter workflow import/export helpers, only if they declare lost or adapter-owned semantics instead of claiming total equivalence.

Not allowed by implication:

- Treating `AdapterWorkflowBuilder` and `dzupflow/v1` as two syntaxes for identical semantics.
- Hiding failed `normalizeDslDocument()` diagnostics and continuing with a partial document instead of requiring `ok: true`.
- Adding Codev tenant/workspace/project/task fields to DzupAgent framework flow contracts.

## Current Guardrails

Tests and checks that should stay aligned with this matrix:

- `packages/flow-dsl/test/canonicalize-dsl.test.ts`
- `packages/flow-dsl/test/normalize.test.ts`
- `packages/flow-compiler/test/compile.test.ts`
- `packages/flow-compiler/test/lower-skill-chain.test.ts`
- `packages/agent/src/__tests__/planning-agent.test.ts`
- `packages/agent/src/__tests__/delegating-supervisor.test.ts`
- `packages/agent/src/__tests__/team-runtime.test.ts`
- `packages/agent-adapters/src/__tests__/adapter-workflow.test.ts`
- `packages/agent-adapters/src/__tests__/workflow-validator.test.ts`
- `packages/agent-adapters/src/__tests__/architecture-doc.test.ts`

## Next Contract Work

Implemented foundation: `@dzupagent/flow-compiler` success results now include `FlowCompileEvidence` with:

- `sourceKind`
- `sourceHash`
- `compileId`
- canonical node IDs and node paths
- lowered target: `pipeline`, `skill-chain`, or `workflow-builder`
- event/run correlation IDs

Remaining contract work should extend this evidence only when a new lowering target actually exists. Do not add another authoring abstraction. Future fields can include:

- `planId` when a planning-DAG target is implemented.
- `adapter-workflow`, `team-runtime`, or `planning-dag` lowered target labels when those explicit lowerers exist.
- provider/persona/tool routing decisions where the framework owns them
- approval/checkpoint policy references

Keep the contract framework-only. App-owned tenancy and task ownership can reference these IDs from the outside.
