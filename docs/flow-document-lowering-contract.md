# FlowDocument Lowering Contract (FlowDocumentV1 -> Planning DAG -> Team Runtime)

Date: 2026-05-16

## Status Labels

- `Implemented`: backed by current source code and tests.
- `Contract-Candidate`: intended shared contract shape; not yet implemented as a compiler/runtime lowering.
- `Future-Only`: explicitly not implemented now; reserved for future work.

This document is framework-scoped and follows the boundary in
`docs/flow-orchestration-authoring-surfaces.md`.

## Scope

- Define source-backed representation contracts for `FlowDocumentV1`, planning DAG surfaces, and team runtime surfaces.
- Define lowering mappings, validation rules, preservation guarantees, failure behavior, and edge cases.
- Separate what exists now from future lowering behavior.

Out of scope:

- Any runtime/compiler/orchestration code changes.
- Product-specific tenancy/workspace/task semantics.

## Source Baseline (Current Code)

- `FlowDocumentV1` and node kinds: `packages/flow-ast/src/types.ts`
- `FlowDocumentV1` validation and canonical node-id checks: `packages/flow-ast/src/validate/document.ts`
- Flow compiler supported lowered targets and evidence envelope: `packages/flow-compiler/src/types.ts`, `packages/flow-compiler/src/index.ts`, `packages/flow-compiler/src/route-target.ts`
- Planning DAG execution contracts: `packages/agent/src/orchestration/planning-types.ts`, `packages/agent/src/orchestration/planning-graph.ts`, `packages/agent/src/orchestration/planning-executor.ts`
- Team runtime declaration/runtime/checkpoint contracts: `packages/agent/src/orchestration/team/team-definition.ts`, `packages/agent/src/orchestration/team/team-runtime.ts`, `packages/agent/src/orchestration/team/team-checkpoint.ts`, `packages/agent/src/orchestration/team/team-phase.ts`

## Representation Schemas

### 1) FlowDocumentV1 Source Schema (`Implemented`)

```json
{
  "$id": "dzupagent.flow_document_v1",
  "type": "object",
  "required": ["dsl", "id", "version", "root"],
  "properties": {
    "dsl": { "const": "dzupflow/v1" },
    "id": { "type": "string", "minLength": 1 },
    "version": { "type": "integer", "minimum": 1 },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "inputs": { "type": "object" },
    "defaults": { "type": "object" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "meta": { "type": "object" },
    "root": {
      "type": "object",
      "required": ["type", "nodes"],
      "properties": {
        "type": { "const": "sequence" },
        "id": { "type": "string" },
        "nodes": { "type": "array", "items": { "$ref": "#/$defs/flowNode" } }
      }
    }
  },
  "$defs": {
    "flowNode": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "enum": [
            "sequence", "action", "for_each", "branch", "approval",
            "clarification", "persona", "route", "parallel", "complete",
            "spawn", "classify", "emit", "memory", "checkpoint", "restore",
            "try_catch", "loop", "http", "wait", "subflow"
          ]
        },
        "id": { "type": "string" }
      }
    }
  }
}
```

### 2) Planning DAG Representation

#### 2a) ExecutionPlan Runtime Contract (`Implemented`)

```json
{
  "$id": "dzupagent.execution_plan.v1",
  "type": "object",
  "required": ["goal", "nodes", "executionLevels"],
  "properties": {
    "goal": { "type": "string", "minLength": 1 },
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "task", "specialistId", "input", "dependsOn"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "task": { "type": "string", "minLength": 1 },
          "specialistId": { "type": "string", "minLength": 1 },
          "input": { "type": "object" },
          "dependsOn": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "executionLevels": {
      "type": "array",
      "items": { "type": "array", "items": { "type": "string" } }
    },
    "decompositionDiagnostics": { "type": "object" }
  }
}
```

#### 2b) Flow-to-Planning Envelope (`Contract-Candidate`)

```json
{
  "$id": "dzupagent.flow_to_planning_dag_contract.v1",
  "type": "object",
  "required": ["plan", "provenance"],
  "properties": {
    "plan": { "$ref": "dzupagent.execution_plan.v1" },
    "provenance": {
      "type": "object",
      "required": ["sourceKind", "sourceDocumentId", "sourceHash", "compileId", "loweredTarget"],
      "properties": {
        "sourceKind": { "const": "flow-document" },
        "sourceDocumentId": { "type": "string" },
        "sourceHash": { "type": "string" },
        "compileId": { "type": "string" },
        "loweredTarget": { "const": "planning-dag" }
      }
    }
  }
}
```

### 3) Team Runtime Execution Representation

#### 3a) Current Team Runtime Surfaces (`Implemented`)

```json
{
  "$id": "dzupagent.team_runtime_surfaces.v1",
  "type": "object",
  "properties": {
    "teamDefinition": {
      "type": "object",
      "required": ["id", "name", "coordinatorPattern", "participants"]
    },
    "teamPhase": {
      "type": "string",
      "enum": ["initializing", "planning", "executing", "evaluating", "completing", "failed"]
    },
    "teamCheckpoint": {
      "type": "object",
      "required": [
        "teamId",
        "runId",
        "phase",
        "completedParticipantIds",
        "pendingParticipantIds",
        "sharedContext",
        "checkpointedAt"
      ]
    }
  }
}
```

#### 3b) Flow-to-Team Execution Envelope (`Future-Only`)

```json
{
  "$id": "dzupagent.flow_to_team_runtime_contract.v1",
  "type": "object",
  "required": ["teamDefinition", "entryTask", "provenance"],
  "properties": {
    "teamDefinition": { "$ref": "dzupagent.team_runtime_surfaces.v1#/properties/teamDefinition" },
    "entryTask": { "type": "string" },
    "provenance": {
      "type": "object",
      "required": ["sourceKind", "sourceDocumentId", "sourceHash", "compileId", "loweredTarget"],
      "properties": {
        "sourceKind": { "const": "flow-document" },
        "sourceDocumentId": { "type": "string" },
        "sourceHash": { "type": "string" },
        "compileId": { "type": "string" },
        "loweredTarget": { "const": "team-runtime" }
      }
    }
  }
}
```

## Lowering Algorithm (Pseudocode)

### A) `FlowDocumentV1 -> compiler lowered target` (`Implemented`)

```text
input document
  -> validate FlowDocument shape (flow-ast)
  -> extract document.root
  -> parse/shape-validate/semantic-resolve (flow-compiler stages 1-3)
  -> route target via feature bitmask:
       for_each/loop => pipeline
       branch/parallel/suspend => workflow-builder
       else => skill-chain
  -> lower to selected target (stage 4)
  -> emit compile evidence (sourceHash, compileId, canonicalNodeIds, loweredTarget)
```

### B) `FlowDocumentV1 -> Planning DAG` (`Contract-Candidate`)

```text
input validated FlowDocumentV1
  -> flatten/normalize executable steps
  -> assign specialistId per node using explicit lowering policy
  -> convert control-flow dependencies to dependsOn
  -> compute executionLevels using topological sort
  -> attach provenance {sourceDocumentId, sourceHash, compileId, loweredTarget=planning-dag}
  -> validate with validatePlanStructure-equivalent checks
```

### C) `Planning DAG -> Team Runtime Execution` (`Future-Only`)

```text
input planning DAG + team selection policy
  -> construct TeamDefinition (participants + coordinatorPattern)
  -> derive entry task / phase intent
  -> preserve node identity as runtime correlation metadata
  -> execute with TeamRuntime.execute or checkpoint/resume path
```

## Field Mappings

| Source field | Planning DAG mapping | Team runtime mapping | Status |
| --- | --- | --- | --- |
| `FlowDocumentV1.id` | `provenance.sourceDocumentId` | `provenance.sourceDocumentId` | `Contract-Candidate` / `Future-Only` |
| Compiler `sourceHash` | `provenance.sourceHash` | `provenance.sourceHash` | `Contract-Candidate` / `Future-Only` |
| Compiler `compileId` | `provenance.compileId` | `provenance.compileId` | `Contract-Candidate` / `Future-Only` |
| Node `id` | `PlanNode.id` | runtime correlation metadata for participant output | `Contract-Candidate` / `Future-Only` |
| Node data (task intent + refs) | `PlanNode.task`, `PlanNode.input` | entry task + team policy input | `Contract-Candidate` / `Future-Only` |
| Graph dependencies | `PlanNode.dependsOn` + `executionLevels` | phase/ordering policy input | `Contract-Candidate` / `Future-Only` |

## Preservation Guarantees

- `Implemented`: `FlowDocumentV1` validation enforces canonical node-id uniqueness; compiler evidence exports canonical node IDs and node paths.
- `Implemented`: Planning execution uses node IDs as assignment IDs when available, preserving per-node correlation.
- `Contract-Candidate`: Any Flow-to-Planning lowering must preserve flow node IDs as stable `PlanNode.id` values.
- `Future-Only`: Any Flow-to-Team lowering must preserve source-to-runtime provenance and correlation IDs across checkpoint/resume.

## Validation Rules

### Implemented Rules

- `FlowDocumentV1` must satisfy: `dsl === "dzupflow/v1"`, non-empty `id`, positive integer `version`, `root.type === "sequence"`.
- Canonical node IDs must be unique within the flow document.
- Planning plan validation checks duplicate node IDs, unknown dependencies, self-dependencies, unknown specialists, and cycles.
- Team runtime validates coordinator pattern and policy compatibility before execution.

### Contract Rules for New Lowerers

- `Contract-Candidate`: Flow-to-Planning lowerer must fail if specialist assignment cannot be resolved for a required node.
- `Contract-Candidate`: Flow-to-Planning lowerer must reject cyclic DAG output and dangling dependencies.
- `Future-Only`: Flow-to-Team lowerer must fail explicitly when required team participants/policies cannot be derived.

## Error Handling

- `Implemented`: shape/semantic/lowering diagnostics return typed compiler errors; stage 3 semantic failures halt lowering.
- `Implemented`: planning validation returns deterministic error strings and plan execution throws on invalid plans.
- `Implemented`: runtime delegation aggregation preserves assignment keys and emits explicit failure entries.
- `Contract-Candidate`: Flow-to-Planning lowerer should return deterministic diagnostics keyed by source node ID.
- `Future-Only`: Flow-to-Team lowerer should return explicit "unsupported lowering" diagnostics until a concrete implementation exists.

## Edge Cases

1. Duplicate-specialist parallel assignments (`Implemented`): aggregation uses assignment ID first, specialist ID fallback only for legacy callers; Flow-to-Planning contract must preserve unique assignment keys.
2. Branch/parallel feature routing (`Implemented`): route target selection escalates to `workflow-builder` (or `pipeline` with loop/for_each); no planning/team target exists today.
3. Memory/checkpoint nodes (`Implemented` in flow schema, `Future-Only` for planning/team semantics): node types exist and compile to existing lowered targets, but no source-backed mapping to planning/team phases is implemented.
4. Unsupported lowering target (`Future-Only`): compiler target union currently excludes `planning-dag` and `team-runtime`; any claim of direct lowering to those targets is non-implemented.

## Worked Examples

### Example 1: Simple Sequence

Status: compiler path `Implemented`; planning/team mappings `Contract-Candidate`/`Future-Only`.

```json
{
  "dsl": "dzupflow/v1",
  "id": "doc-seq-1",
  "version": 1,
  "root": {
    "type": "sequence",
    "id": "root",
    "nodes": [
      { "type": "action", "id": "n1", "toolRef": "skill.fetch", "input": {} },
      { "type": "complete", "id": "n2", "result": "done" }
    ]
  }
}
```

- `Implemented`: routes to `skill-chain` when no branch/parallel/suspend/loop features are present.
- `Contract-Candidate`: potential plan nodes `n1 -> n2` with `dependsOn: ["n1"]`.
- `Future-Only`: potential team execution could map to a single coordinator pattern, but no lowering exists.

### Example 2: Branch + Parallel

Status: compiler routing `Implemented`; planning projection example is `Contract-Candidate`.

```json
{
  "dsl": "dzupflow/v1",
  "id": "doc-branch-1",
  "version": 1,
  "root": {
    "type": "sequence",
    "id": "root",
    "nodes": [
      {
        "type": "branch",
        "id": "b1",
        "condition": "${state.ok}",
        "then": [{ "type": "action", "id": "t1", "toolRef": "skill.a", "input": {} }],
        "else": [{ "type": "action", "id": "e1", "toolRef": "skill.b", "input": {} }]
      },
      {
        "type": "parallel",
        "id": "p1",
        "branches": [
          [{ "type": "action", "id": "p1a", "toolRef": "skill.c", "input": {} }],
          [{ "type": "action", "id": "p1b", "toolRef": "skill.d", "input": {} }]
        ]
      }
    ]
  }
}
```

- `Implemented`: routes to `workflow-builder` because `branch`/`parallel` bits are present.
- `Contract-Candidate`: planning DAG can preserve branch/parallel dependencies as multiple nodes and topological levels.
- `Future-Only`: phase-level team lowering rules are not implemented.

### Example 3: Memory + Delegation Boundary

Status: flow node support `Implemented`; direct planning/team lowering `Future-Only`.

```json
{
  "dsl": "dzupflow/v1",
  "id": "doc-memory-1",
  "version": 1,
  "root": {
    "type": "sequence",
    "id": "root",
    "nodes": [
      { "type": "memory", "id": "m1", "operation": "read", "tier": "session", "key": "brief", "outputVar": "brief" },
      { "type": "action", "id": "a1", "toolRef": "skill.plan", "input": { "brief": "${state.brief}" } },
      { "type": "checkpoint", "id": "c1", "captureOutputOf": "a1", "label": "after-plan" }
    ]
  }
}
```

- `Implemented`: compiler handles these node kinds in existing target lowerers; planning runtime can execute node-indexed assignments when given an `ExecutionPlan`.
- `Contract-Candidate`: a future Flow-to-Planning lowerer should preserve `m1/a1/c1` IDs and dependency order.
- `Future-Only`: mapping flow `checkpoint` semantics directly to `TeamCheckpoint`/`ResumeContract` is not implemented.

## Unsupported / Not Implemented Today

- No `flow-compiler` target emits `planning-dag` or `team-runtime`; current targets are `skill-chain`, `workflow-builder`, and `pipeline`.
- No source-backed module currently transforms `FlowDocumentV1` directly into `ExecutionPlan` or `TeamDefinition`.
- Any consumer needing planning/team execution must currently author those surfaces directly.
