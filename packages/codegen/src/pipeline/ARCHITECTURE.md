# `packages/codegen/src/pipeline` Architecture

## Scope
This document describes the current pipeline subsystem in `@dzupagent/codegen` under `packages/codegen/src/pipeline`:

- `gen-pipeline-builder.ts`
- `pipeline-executor.ts`
- `phase-types.ts`
- `phase-conditions.ts`
- `guardrail-gate.ts`
- `budget-gate.ts`
- `fix-escalation.ts`
- `skill-resolver.ts`

It also reflects how these APIs are surfaced through:

- package root exports in `packages/codegen/src/index.ts`
- runtime facade exports in `packages/codegen/src/runtime.ts`
- package metadata and constraints in `packages/codegen/package.json`

## Responsibilities
The pipeline subsystem has two distinct responsibilities:

1. Describe a codegen pipeline as ordered phase metadata.
2. Execute runtime phase functions with failure controls and state propagation.

Current implementation responsibilities by module:

- `gen-pipeline-builder.ts`
  - Fluent configuration of pipeline phases (`generation`, `subagent`, `validation`, `fix`, `review`, `guardrail`).
  - Stores optional guardrail gate configuration for downstream execution wiring.
- `pipeline-executor.ts`
  - Runtime execution of `PhaseConfig[]` with:
  - dependency ordering (`dependsOn`),
  - conditional execution (`condition`),
  - retry policies (`immediate` and `backoff`),
  - timeout handling,
  - optional budget pre-checks,
  - optional skill resolution/injection,
  - optional guardrail gating,
  - progress and checkpoint callbacks.
- `phase-types.ts`
  - Type contracts for codegen-oriented state and phase descriptors (`BaseGenState`, fix/validation/review configs, sub-agent config).
- `phase-conditions.ts`
  - Reusable condition combinators used by runtime phase conditions.
- `guardrail-gate.ts`
  - Adapter from `GuardrailEngine` reports to pipeline pass/fail decisions and summary output.
- `budget-gate.ts`
  - Adapter from external budget-check function to normalized gate result.
- `fix-escalation.ts`
  - Default escalation strategy tiers for retry-based fix workflows.
- `skill-resolver.ts`
  - Resolves skill content from registry/loader and injects resolved sections into execution state.

## Structure
The subsystem is intentionally split into configuration-time and runtime-time layers.

### Configuration layer
- `PipelinePhase` and `GenPipelineBuilder` in `gen-pipeline-builder.ts`.
- Builder methods:
  - `withGuardrails`
  - `addPhase`
  - `addSubAgentPhase`
  - `addValidationPhase`
  - `addFixPhase`
  - `addReviewPhase`
  - read APIs (`getPhases`, `getPhase`, `getPhaseNames`, `getGenerationPhases`, `getGuardrailConfig`)

### Runtime layer
- `PipelineExecutor` and execution types in `pipeline-executor.ts`:
  - `ExecutorConfig`
  - `PhaseConfig`
  - `PhaseResult`
  - `PipelineExecutionResult`

### Policy/helper layer
- `guardrail-gate.ts` for guardrail pass/fail logic and summaries.
- `budget-gate.ts` for budget checks.
- `phase-conditions.ts` for predicate composition.
- `fix-escalation.ts` for retry escalation profiles.
- `skill-resolver.ts` for pre-phase skill hydration into state.

### Export surface
Exported from package root (`src/index.ts`):

- `GenPipelineBuilder`, `PipelinePhase`
- `PipelineExecutor` and executor result/config types
- `runGuardrailGate`, `summarizeGateResult`, gate types
- `runBudgetGate`, budget types
- condition helpers from `phase-conditions.ts`
- `DEFAULT_ESCALATION`, `getEscalationStrategy`, escalation types
- codegen phase/state types from `phase-types.ts` (with `PhaseConfig` aliased as `GenPhaseConfig`)

Also exported through runtime subpath facade (`src/runtime.ts`):

- `gen-pipeline-builder`
- `fix-escalation`
- `pipeline-executor`
- `guardrail-gate`
- `budget-gate`
- `phase-conditions`

Not exported from package root:

- `skill-resolver.ts` APIs are internal to deep imports and internal wiring.

## Runtime and Control Flow
`PipelineExecutor.execute(phases, initialState)` currently performs this sequence:

1. Topological order calculation
- Sorts phases using `dependsOn`.
- Throws on cycles and unknown dependency IDs.

2. Stateful execution setup
- Clones `initialState` into mutable runtime state.
- Tracks completed phases and phase-level results.

3. Per-phase controls
- Dependency check: if prerequisites are not completed, records a skipped phase with unmet dependency error and marks overall failure.
- Condition check: if `condition(state)` is false, phase is skipped, `__phase_<id>_skipped` is set, progress callback emits completion.
- Budget gate (optional): `runBudgetGate` executes before phase code, stores snapshot at `__phase_<id>_budget`; a failed gate records a failed phase and stops the pipeline.
- Skill resolution (optional): when both `phase.skills` and executor `skillResolver` exist, skills are resolved/injected before phase execution.

4. Phase invocation
- Runs `phase.execute(state)` under `withTimeout`.
- Applies retry policy based on `maxRetries` and optional backoff strategy (`calculateBackoff` from `@dzupagent/core/utils`).
- On success:
  - merges output into state via `Object.assign`
  - sets `__phase_<id>_completed = true`
  - evaluates optional guardrail gate if `guardrailGate` and `buildGuardrailContext` are configured and context is returned
  - guardrail result snapshot is written to `__phase_<id>_guardrail`
  - progress callback updates and optional checkpoint callback executes
- On timeout/failure:
  - writes `timeout` or `failed` result with retry/error metadata
  - stops subsequent phase execution

5. Final result
- Returns:
  - `status: 'completed' | 'failed'`
  - ordered `PhaseResult[]`
  - `totalDurationMs`
  - copied final state

Guardrail gate behavior:

- Non-strict mode blocks only when `errorCount > 0`.
- Strict mode blocks on errors or warnings.
- Failure summaries are generated by `summarizeGateResult`.

Skill resolver behavior:

- Resolution order: registry first, loader second.
- Unresolved skills are skipped with `console.warn`.
- Injected keys are sanitized by phase name:
  - `__skills_<phase>`
  - `__skills_prompt_<phase>`
  - optional `__skill_context`

## Key APIs and Types
Primary runtime API:

- `PipelineExecutor`
  - `execute(phases, initialState): Promise<PipelineExecutionResult>`
- `ExecutorConfig`
  - `defaultTimeoutMs`
  - `defaultMaxRetries`
  - `onCheckpoint`
  - `onProgress`
  - `guardrailGate`
  - `buildGuardrailContext`
  - `skillResolver`
  - `skillResolutionContext`
  - `budgetGate`
- `PhaseConfig`
  - `id`, `name`, `execute`
  - optional `condition`, `dependsOn`, `maxRetries`, `timeoutMs`, `retryStrategy`, `skills`
- `PhaseResult`
  - `status: completed | skipped | failed | timeout`
  - timing/retry/error/output fields

Builder API:

- `GenPipelineBuilder` and `PipelinePhase`
  - phase types: `generation | subagent | validation | fix | review | guardrail`
  - stores optional `GuardrailGateConfig` via `withGuardrails`

Codegen pipeline typing:

- `BaseGenState`
- `GenPhaseConfig` (alias of `phase-types.ts` `PhaseConfig`)
- `SubAgentPhaseConfig`
- `ValidationPhaseConfig`
- `FixPhaseConfig`
- `ReviewPhaseConfig`

Gates and helpers:

- `runGuardrailGate`, `summarizeGateResult`
- `runBudgetGate`
- `hasKey`, `previousSucceeded`, `stateEquals`, `hasFilesMatching`, `allOf`, `anyOf`
- `DEFAULT_ESCALATION`, `getEscalationStrategy`

Internal-only helper APIs:

- `resolveSkills`
- `formatResolvedSkillsPrompt`
- `injectSkillsIntoState`
- `resolveAndInjectSkills`
- `SkillResolverConfig`, `ResolvedSkill`

## Dependencies
Direct dependencies used by pipeline modules:

- `@dzupagent/core`
  - `ModelTier` and `SubAgentConfig` type usage
  - `SkillRegistry`, `SkillLoader`, `SkillResolutionContext` for skill resolution
  - `calculateBackoff` utility in executor retry handling
- `@langchain/core`
  - `StructuredToolInterface` types in builder/types
  - `BaseMessage` for `BaseGenState`
- Internal package modules:
  - `../guardrails/guardrail-engine.ts`
  - `../guardrails/guardrail-reporter.ts`
  - `../guardrails/guardrail-types.ts`
  - `../quality/quality-types.ts`

Package-level constraints from `packages/codegen/package.json`:

- Runtime dependencies: `@dzupagent/core`, `@dzupagent/adapter-types`
- Peer dependencies relevant to this area: `@langchain/core`, `@langchain/langgraph`, `zod`

## Integration Points
Current integration seams in this repository:

- Public package integration:
  - pipeline APIs are exported at root (`@dzupagent/codegen`) and runtime subpath (`@dzupagent/codegen/runtime`).
- Guardrails integration:
  - pipeline runtime accepts `GuardrailGateConfig` and caller-provided context builder; policy evaluation stays in `src/guardrails`.
- Budget integration:
  - `BudgetGateConfig.checkBudget` is injected; pipeline does not persist budget state itself.
- Skill integration:
  - skill resolution relies on `@dzupagent/core` registry/loader abstractions and injects skill prompt material into shared state.
- Quality integration:
  - builder validation phases reference `QualityDimension[]`; scoring itself is executed by caller-supplied phase logic.

Cross-package note:

- `packages/adapter-types` defines a separate `PipelineExecutorPort` for `@dzupagent/agent` pipeline runtime DI. It is a different contract than `@dzupagent/codegen` `PipelineExecutor` and should not be treated as the same runtime API.

## Testing and Observability
Pipeline subsystem tests currently exist in `packages/codegen/src/__tests__`, including:

- `pipeline-executor.test.ts`
- `pipeline-executor-extended.test.ts`
- `pipeline-components.test.ts`
- `gen-pipeline-builder.test.ts`
- `phase-conditions.test.ts`
- `fix-escalation.test.ts`
- `budget-gate.test.ts`
- `skill-resolver.test.ts`
- branch/deep suites that also cover pipeline paths:
  - `branch-coverage-vfs-pipeline.test.ts`
  - `codegen-multiedit-repomap-deep.test.ts`

Behavior covered by tests includes:

- dependency ordering and cycle/unknown-dependency failure
- timeout labeling and retry behavior (including backoff mode)
- conditional phase skips and state markers
- guardrail blocking behavior and guardrail state snapshots
- budget gate pass/fail and per-phase budget checks
- checkpoint/progress callback behavior
- skill resolution precedence, fallback, key sanitization, and injection

Built-in observability hooks:

- `PhaseResult[]` with per-phase status/error/retries/duration/output
- pipeline-level status and `totalDurationMs`
- state telemetry keys:
  - `__phase_<id>_completed`
  - `__phase_<id>_skipped`
  - `__phase_<id>_budget`
  - `__phase_<id>_guardrail`
  - `__skills_*` and `__skill_context`
- callback hooks:
  - `onProgress(phaseId, progress)`
  - `onCheckpoint(phaseId, state)`

## Risks and TODOs
- Builder/executor split is manual.
  - `GenPipelineBuilder` phase descriptors are not directly executable by `PipelineExecutor`; caller code must map builder output to runtime `PhaseConfig`.
- Timeout is non-cooperative cancellation.
  - `withTimeout` races promise completion but does not cancel underlying phase work.
- Shared mutable state is untyped at runtime.
  - executor state is `Record<string, unknown>`, so key collisions and overwrite behavior are caller-managed.
- Budget and guardrail gates are hard-stop by default.
  - there is no built-in branch/continue policy once a gate fails.
- Skill resolver is not root-exported.
  - consumers using only package root exports cannot directly access `skill-resolver` helpers.
- README quick-start drift risk.
  - `packages/codegen/README.md` pipeline example still shows old builder usage shape (`addPhase('name', node)` and `.build()`), while current `GenPipelineBuilder` API is config-object based and does not expose `.build()`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

