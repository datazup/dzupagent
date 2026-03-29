## Canonical Runtime & Migration Map

Date: 2026-03-29
Owner: Platform Runtime

### Canonical Direction

Canonical data model:
- `@dzipagent/core` `PipelineDefinition`

Canonical execution engine:
- `@dzipagent/agent` `PipelineRuntime`

Canonical rule:
- All workflow DSLs and package-specific orchestration entry points should compile/translate to `PipelineDefinition` and execute via `PipelineRuntime` unless there is a documented hard exception.

### Current Runtime Surfaces

1. `packages/agent/src/pipeline/PipelineRuntime`
- Status: Canonical target runtime.
- Keep: Yes.

2. `packages/agent/src/workflow/WorkflowBuilder`
- Status: DSL for general multi-step flows.
- Current state: Compiles to `PipelineDefinition` and executes through `PipelineRuntime`.
- Keep: Yes (as ergonomic builder), but not as separate execution engine.

3. `packages/codegen/src/pipeline/PipelineExecutor`
- Status: Legacy phase executor.
- Keep: Transitional compatibility API.
- Migration status: In progress. Execution now routes through `PipelineRuntime` with a compatibility adapter preserving phase-level result semantics.

4. `packages/agent-adapters/src/workflow/AdapterWorkflowBuilder`
- Status: Adapter-oriented workflow DSL + runtime.
- Keep: DSL surface yes; runtime duplication no.
- Migration status: In progress. Execution now routes through `PipelineRuntime` using compatibility compilation while preserving existing `AdapterWorkflow.run()` result and event semantics.

### Migration Phases

#### Phase 1: Converge execution (in progress)
- WorkflowBuilder path uses `PipelineRuntime`.
- Add visibility helpers (`toPipelineDefinition`) for debugging and migration verification.

#### Phase 2: Introduce compatibility adapters
- Add conversion utilities:
  - `codegen phases -> PipelineDefinition`
  - `adapter workflow graph -> PipelineDefinition`
- Preserve existing external APIs while switching execution backend.

Progress update:
- `PipelineExecutor` now compiles internal phase DAG order into canonical `PipelineDefinition` and executes via `PipelineRuntime`.
- `AdapterWorkflowBuilder` now compiles workflow nodes (`step`, `parallel`, `branch`, `transform`) into canonical `PipelineDefinition` and executes through `PipelineRuntime` in compatibility mode.

#### Phase 3: Deprecate duplicate executors
- Mark `PipelineExecutor` runtime path deprecated.
- Mark adapter runtime internals deprecated once canonical path reaches parity.
- Keep DSLs stable; remove duplicate execution engines.

#### Phase 4: Remove transitional code
- Remove deprecated execution paths after two release cycles with migration guides.
- Keep only canonical runtime path for new features and maintenance.

### Feature Parity Checklist (required before removing duplicate runtimes)

- Sequential execution
- Parallel fan-out + deterministic merge behavior
- Branch routing
- Suspend/resume semantics
- Retry/backoff behavior
- Error edge handling
- Checkpoint compatibility
- Event parity for existing observability consumers

### Risk Controls

- Keep migration behind package-local adapters, not user-facing breaking API changes.
- Add contract tests that compare old-vs-new behavior for representative workflows.
- Use release notes to mark deprecation timeline and replacement APIs.
