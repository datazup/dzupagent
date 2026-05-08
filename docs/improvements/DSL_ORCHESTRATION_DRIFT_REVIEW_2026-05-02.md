# DzupAgent DSL and Orchestration Drift Review

Date: 2026-05-02
Scope: `packages/flow-*`, `packages/agent/src/orchestration`, `packages/agent-adapters/src/workflow`, server compile route, and current improvement/architecture docs.

## Executive Summary

DzupAgent now has a real flow stack: `@dzupagent/flow-ast`, `@dzupagent/flow-dsl`, and `@dzupagent/flow-compiler`. The current implementation is materially ahead of older "DSL is only planned" assumptions. Textual `dzupflow/v1` can be normalized, validated, canonicalized, compiled, and accepted through server compile routes.

The main drift is not "missing DSL package"; it is boundary and productization drift:

- There are two workflow authoring surfaces: canonical `dzupflow/v1` / `FlowDocument` and adapter-owned fluent `AdapterWorkflowBuilder`.
- The boundary is documented in source comments, but the migration path between the two surfaces is not productized.
- Orchestration has many primitives, but no single plan-native orchestration contract tying DSL nodes, provider routing, team/runtime execution, approvals, checkpoints, and event evidence together.
- Some architecture docs are stale against current source, so planning from docs alone will misprioritize work.

## Current Implementation Evidence

### Flow DSL Stack

- `@dzupagent/flow-dsl` is a published workspace package with parser, formatter, validator, canonicalizer, and graph projection exports.
  - Evidence: `packages/flow-dsl/package.json`, `packages/flow-dsl/src/index.ts`.
- `canonicalizeDsl()` returns a validated `FlowDocumentV1`, canonical root flow input, and a derived graph.
  - Evidence: `packages/flow-dsl/src/canonicalize-dsl.ts`.
- `normalizeDslDocument()` accepts the authoring form with top-level `steps`, rejects graph-style `nodes` / `edges`, and emits suggestions for that drift.
  - Evidence: `packages/flow-dsl/src/normalize.ts`.
- `@dzupagent/flow-compiler` is the canonical owner of FlowDocument/FlowNode parsing, validation, semantic resolution, routing, and lowering.
  - Evidence: `packages/flow-compiler/src/index.ts`.
- Server compile routes accept `flow`, `document`, or textual `dsl` and normalize them through `normalizeCompileInput()`.
  - Evidence: `packages/server/src/routes/compile.ts`, `packages/server/src/routes/compile-input.ts`.

### Adapter Workflow Surface

- `AdapterWorkflowBuilder` is still a separate provider-oriented compatibility DSL.
- It compiles to `PipelineDefinition` and runs through `PipelineRuntime`.
- Its source explicitly says compiler equivalence is guaranteed only at the pipeline contract boundary, while adapter routing, prompt templating, retry policy, loop execution, parallel merge, and workflow events remain adapter-owned semantics.
  - Evidence: `packages/agent-adapters/src/workflow/adapter-workflow.ts`.

### Orchestration Surface

- `@dzupagent/agent` orchestration includes sequential, parallel, supervisor, debate, contract-net, map-reduce, planning DAG, routing policies, merge strategies, topology executor, provider execution port, and team runtime.
  - Evidence: `packages/agent/src/orchestration/ARCHITECTURE.md`.
- `PlanningAgent` executes DAG levels with bounded parallelism and now passes task assignment IDs into `delegateAndCollect()`.
  - Evidence: `packages/agent/src/orchestration/planning-agent.ts`.
- `DelegatingSupervisor.delegateAndCollect()` keys results by explicit assignment ID when provided, falling back to specialist ID only for older callers.
  - Evidence: `packages/agent/src/orchestration/delegating-supervisor.ts`.

## Drift Findings

### 1. Stale Orchestration Risk: Result Collision Is Already Mostly Fixed

Severity: medium

The current architecture doc still lists a live planning result collision risk: results keyed by `specialistId` can overwrite each other when multiple same-specialist nodes run in one chunk. Current implementation has moved to assignment IDs:

- `TaskAssignment.id` is documented as a stable key.
- `PlanningAgent.executePlan()` sets `id: nodeId`.
- `delegateAndCollect()` uses `assignment.id ?? assignment.specialistId`.

Residual risk remains only for legacy callers that omit `TaskAssignment.id`.

Recommended improvement:

- Update `packages/agent/src/orchestration/ARCHITECTURE.md` to mark this as resolved for `PlanningAgent` and residual for direct `delegateAndCollect()` callers.
- Add or verify a regression test for two same-specialist plan nodes in one execution level.
- Consider making duplicate-specialist assignments without IDs warn or fail in strict mode.

### 2. Stale Agent-Adapters Export Drift

Severity: medium

`packages/agent-adapters/docs/ARCHITECTURE.md` says package exports expose only `"."`, but `packages/agent-adapters/package.json` currently exports subpaths for providers, orchestration, workflow, http, persistence, learning, and recovery.

Recommended improvement:

- Refresh `packages/agent-adapters/docs/ARCHITECTURE.md`.
- Add a small architecture-doc smoke assertion for the docs copy that checks package export claims against `package.json`.

### 3. DSL Boundary Is Correct but Not Yet Productized

Severity: high

The canonical boundary is clear in source: `flow-compiler` owns FlowDocument semantics; `AdapterWorkflowBuilder` owns provider-specific compatibility semantics. The drift is that consumer-facing planning can still treat both as equivalent workflow DSLs.

This matters because canonical flow lowering does not define adapter-only semantics such as provider preference, retry policy, prompt templating, per-step timeout, workflow events, and parallel merge strategy. A user may author a `dzupflow/v1` expecting adapter workflow behavior that the compiler does not promise.

Recommended improvement:

- Create a formal "workflow authoring surface matrix" covering `FlowDocumentV1`, `dzupflow/v1`, `AdapterWorkflowBuilder`, `PlanningAgent.ExecutionPlan`, and `TeamDefinition`.
- Define migration paths explicitly:
  - `dzupflow/v1 -> compiler -> pipeline/skill-chain/workflow-builder artifact`
  - `AdapterWorkflowBuilder -> PipelineDefinition only`
  - no implicit equivalence for adapter-owned semantics
- Add runtime metadata to compiled artifacts recording source kind and lowered target so downstream apps can show "canonical flow" versus "adapter workflow".

### 4. Flow DSL Has Parsing and Validation, but Lacks a First-Class Orchestration Plan Contract

Severity: high

The flow DSL can canonicalize and compile, and orchestration can plan/delegate. But there is no single shared contract that maps DSL nodes to orchestration execution evidence:

- flow compile events use `compileId`.
- adapter runs use adapter/run/event-store identifiers.
- `PlanningAgent` results are node-local maps.
- team runtime has its own phase/checkpoint model.

Recommended improvement:

- Introduce a small `flow-execution-plan` or `orchestration-plan` contract package only after local contracts stabilize.
- Minimum fields:
  - `planId`, `sourceKind`, `sourceHash`, `compileId`
  - canonical node IDs and step IDs
  - target runtime: `pipeline`, `skill-chain`, `adapter-workflow`, `team-runtime`, `planning-dag`
  - provider/persona/tool routing decisions
  - approval/checkpoint policy references
  - event/run correlation IDs
- Keep product-owned tenancy/workspace/project/task semantics out of DzupAgent framework packages.

### 5. Normalizer Hides Invalid DSL Version Until Diagnostics Are Checked

Severity: medium

`normalizeDslDocument()` always constructs `doc.dsl` as `dzupflow/v1`, even when raw input had another DSL value, then emits diagnostics. This is safe inside `canonicalizeDsl()` because diagnostics make the result fail, but it is easy for future callers to misuse the normalized document directly if they ignore diagnostics.

Recommended improvement:

- Keep current compatibility if needed, but document the invariant: normalized documents are only trusted when diagnostics are empty.
- Consider returning an explicit `ok` discriminant from `normalizeDslDocument()` or renaming the low-level API to make misuse less likely.
- Add tests for any public caller that consumes `normalizeDslDocument()` directly.

### 6. Docs Still Mix Framework and Product Control-Plane Language

Severity: medium

The repo guidance says product features such as workspaces, tasks/subtasks, personas, prompt templates, workflow DSL UX, memory policies, multi-tenant filtering, and operator UI should live in consuming apps such as Codev. Some docs still discuss server/playground/control-plane surfaces in broad terms that can be read as product direction.

Recommended improvement:

- Keep DzupAgent DSL/orchestration improvements framework-level:
  - AST, compiler, runtime contracts, policy hooks, evidence events, adapters.
- Push product UX/state:
  - workspace/project/task orchestration, tenant memory rules, persona/prompt template catalogs, operator review flows.
  - Codev should own these.

## Suggested Implementation Order

### P0: Documentation Drift Cleanup

1. Refresh `packages/agent/src/orchestration/ARCHITECTURE.md`.
2. Refresh `packages/agent-adapters/docs/ARCHITECTURE.md`.
3. Add doc tests or script checks for claims that can be verified from manifests/source.

Validation:

- `yarn workspace @dzupagent/agent test src/orchestration/__tests__/orchestration-paths.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/workflow-validator.test.ts src/__tests__/adapter-workflow.test.ts`

### P1: Formal Authoring Surface Matrix

Create `docs/flow-orchestration-authoring-surfaces.md` or package-local docs that define:

- supported inputs
- owner package
- compile/lower target
- runtime executor
- supported semantics
- unsupported semantics
- migration status
- test gates

Validation:

- Add architecture-doc tests that assert the matrix names all public packages: `flow-ast`, `flow-dsl`, `flow-compiler`, `agent`, `agent-adapters`.

### P2: Strengthen Planning/Delegation Identity

1. Add regression coverage for duplicate-specialist nodes in one planning level.
2. Add strict-mode behavior for `delegateAndCollect()` assignments without stable IDs when duplicates exist.
3. Include assignment/node IDs in merge-strategy events.

Validation:

- `yarn workspace @dzupagent/agent test src/orchestration/__tests__/orchestration-paths.test.ts`
- Add a targeted `planning-agent` duplicate-specialist test if not already present.

### P3: Compile-to-Orchestration Evidence Contract

Design a minimal framework contract that lets a compiled flow and an orchestration run be correlated without importing app product concepts.

Validation:

- Unit tests in `flow-compiler` for source metadata.
- Unit tests in `agent` or `runtime-contracts` for event/run correlation shape.
- No Codev-specific tenant/workspace/project fields in framework package types.

### P4: Productization in Codev

Once framework contracts are stable, Codev can own:

- workspace/project/task/subtask mapping
- persona and prompt-template catalogs
- tenant memory filtering
- operator UX for approvals/checkpoints/replay
- workflow DSL authoring and review UI

Validation:

- Codev API tests for tenant boundaries and task ownership.
- Codev web/e2e tests for authoring/review/replay flows.

## Next Recommended Slice

Start with P0 and P1. They are low-risk, immediately reduce planning drift, and prevent future implementation packets from targeting already-fixed issues or crossing the framework/product boundary.

Do not start by extracting another runtime abstraction. The live code already has enough primitives; the current blocker is contract clarity, doc freshness, and evidence correlation between DSL compile and orchestration execution.
