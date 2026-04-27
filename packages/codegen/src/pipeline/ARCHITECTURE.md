# `packages/codegen/src/pipeline` Architecture

## Scope
This document covers the pipeline subsystem under `packages/codegen/src/pipeline`:

- `gen-pipeline-builder.ts`
- `phase-types.ts`
- `pipeline-executor.ts`
- `guardrail-gate.ts`
- `budget-gate.ts`
- `skill-resolver.ts`
- `phase-conditions.ts`
- `fix-escalation.ts`

It describes the current implementation in `@dzupagent/codegen` and its exported surface from `src/index.ts`.

## Responsibilities
The subsystem has two primary responsibilities:

1. Define pipeline configuration contracts for codegen workflows.
2. Execute runtime phase lists with dependency ordering, retries, timeouts, optional gates, and state handoff.

Concretely:

- `GenPipelineBuilder` provides a fluent way to collect codegen-oriented phase definitions (`generation`, `subagent`, `validation`, `fix`, `review`, `guardrail`).
- `PipelineExecutor` runs executable phases (`PhaseConfig`) with:
  - topological dependency ordering,
  - optional `condition` checks,
  - retry policies (`immediate` or `backoff`),
  - timeout enforcement,
  - optional budget checks,
  - optional skill resolution/injection,
  - optional guardrail blocking,
  - progress/checkpoint callbacks.

Support utilities provide focused policy behavior:

- `runGuardrailGate` and `summarizeGateResult`
- `runBudgetGate`
- `resolveSkills`/`resolveAndInjectSkills`
- condition combinators (`hasKey`, `previousSucceeded`, `stateEquals`, `hasFilesMatching`, `allOf`, `anyOf`)
- fix escalation defaults and strategy lookup (`DEFAULT_ESCALATION`, `getEscalationStrategy`)

## Structure
### Builder and type layer
- `gen-pipeline-builder.ts` defines `PipelinePhase` and `GenPipelineBuilder`.
- `phase-types.ts` defines codegen-centric state/type contracts (`BaseGenState`, generation/subagent/validation/fix/review configs).

### Runtime executor layer
- `pipeline-executor.ts` defines:
  - `ExecutorConfig`
  - runtime `PhaseConfig`
  - `PhaseResult`
  - `PipelineExecutionResult`
  - `PipelineExecutor`

### Gate and helper layer
- `guardrail-gate.ts` wraps `GuardrailEngine` reports into pass/fail gate semantics.
- `budget-gate.ts` adapts external budget checks into a unified gate result.
- `skill-resolver.ts` resolves skill text from `SkillRegistry` / `SkillLoader` and injects it into state.
- `phase-conditions.ts` provides reusable predicates.
- `fix-escalation.ts` provides multi-attempt fix strategy presets.

### Export boundaries
Publicly exported from package root (`src/index.ts`):

- Builder: `GenPipelineBuilder`, `PipelinePhase`
- Fix escalation: `DEFAULT_ESCALATION`, `getEscalationStrategy`, related types
- Codegen phase contracts: `BaseGenState`, `GenPhaseConfig`, `SubAgentPhaseConfig`, `ValidationPhaseConfig`, `FixPhaseConfig`, `ReviewPhaseConfig`
- Runtime executor: `PipelineExecutor`, `ExecutorConfig`, `ExecutorPhaseConfig`, `PhaseResult`, `PipelineExecutionResult`
- Gates/helpers: `runGuardrailGate`, `summarizeGateResult`, `GuardrailGateConfig`, `GuardrailGateResult`, `runBudgetGate`, `BudgetGateConfig`, `BudgetGateResult`, and condition helpers

Not exported from package root:

- `skill-resolver.ts` symbols (`resolveSkills`, `resolveAndInjectSkills`, etc.) remain internal module APIs.

## Runtime and Control Flow
`PipelineExecutor.execute(phases, initialState)` performs:

1. **Sort and validate dependencies**
- Runs internal topological sort over `dependsOn`.
- Throws on cycles or unknown dependency IDs.

2. **Initialize execution state**
- Clones `initialState` to mutable local `state`.
- Tracks completed phase IDs and per-phase `PhaseResult` entries.

3. **Per-phase execution**
- Verifies dependencies were completed.
- Evaluates optional `condition`; if false, marks phase `skipped`, sets `state.__phase_<id>_skipped = true`, and continues.
- Runs optional budget gate before execution.
  - Stores budget snapshot at `state.__phase_<id>_budget`.
  - If over budget, records phase failure and stops pipeline.
- Resolves optional phase skills if `phase.skills` is present and `ExecutorConfig.skillResolver` is configured.
  - Injects `__skills_<phase>`, `__skills_prompt_<phase>`, and optional `__skill_context`.
- Executes phase with timeout and optional retries.
  - `retryStrategy: 'backoff'` uses `calculateBackoff` from `@dzupagent/core`.
- Merges phase output into shared state via `Object.assign`.
- Marks completion with `state.__phase_<id>_completed = true`.
- Optionally evaluates guardrails using `guardrailGate` + `buildGuardrailContext`.
  - Stores summary at `state.__phase_<id>_guardrail`.
  - On blocking violations, records a failed phase and stops.
- Emits progress (`onProgress`) and successful checkpoint (`onCheckpoint`).

4. **Finalize result**
- Returns aggregate status (`completed` or `failed`), ordered phase results, total duration, and final state snapshot.

Behavior details worth calling out:

- Any failed/timeout phase stops subsequent execution.
- A phase can be marked `timeout` when timeout race wins.
- `onCheckpoint` is called only for successful phases.
- Guardrail gating is conditional: both `guardrailGate` and `buildGuardrailContext` must be provided, and the context builder must return a context.

## Key APIs and Types
### `gen-pipeline-builder.ts`
- `PipelinePhase`
- `GenPipelineBuilder.withGuardrails(config)`
- `GenPipelineBuilder.addPhase(...)`
- `GenPipelineBuilder.addSubAgentPhase(...)`
- `GenPipelineBuilder.addValidationPhase(...)`
- `GenPipelineBuilder.addFixPhase(...)`
- `GenPipelineBuilder.addReviewPhase(...)`
- `GenPipelineBuilder.getPhases()/getPhase()/getPhaseNames()/getGenerationPhases()`

### `phase-types.ts`
- `PhaseConfig` (exported at package root as `GenPhaseConfig`)
- `SubAgentPhaseConfig`
- `ValidationPhaseConfig`
- `FixPhaseConfig`
- `ReviewPhaseConfig`
- `BaseGenState`

### `pipeline-executor.ts`
- `ExecutorConfig`
- `PhaseConfig` (exported as `ExecutorPhaseConfig`)
- `PhaseResult`
- `PipelineExecutionResult`
- `PipelineExecutor`

### `guardrail-gate.ts`
- `GuardrailGateConfig`
- `GuardrailGateResult`
- `runGuardrailGate(config, context)`
- `summarizeGateResult(result)`

### `budget-gate.ts`
- `BudgetGateConfig`
- `BudgetGateResult`
- `runBudgetGate(config)`

### `phase-conditions.ts`
- `hasKey(key)`
- `previousSucceeded(phaseId)`
- `stateEquals(key, value)`
- `hasFilesMatching(pattern)`
- `allOf(...conditions)`
- `anyOf(...conditions)`

### `fix-escalation.ts`
- `EscalationStrategy`
- `EscalationConfig`
- `DEFAULT_ESCALATION`
- `getEscalationStrategy(attempt, config?)`

### Internal-only helper APIs (`skill-resolver.ts`)
- `SkillResolverConfig`
- `ResolvedSkill`
- `resolveSkills(...)`
- `formatResolvedSkillsPrompt(...)`
- `injectSkillsIntoState(...)`
- `resolveAndInjectSkills(...)`

## Dependencies
### Internal package dependencies
- `../guardrails/*` for guardrail engine/report/context types.
- `../quality/quality-types.js` in builder/type contracts.

### Cross-package dependencies
- `@dzupagent/core`
  - `ModelTier`, `SubAgentConfig`, `SkillRegistry`, `SkillLoader`, `SkillResolutionContext`
  - `calculateBackoff` used by executor backoff retries
- `@langchain/core`
  - `StructuredToolInterface` and `BaseMessage` for pipeline and state typing

### Package metadata constraints
From `packages/codegen/package.json`:

- runtime deps: `@dzupagent/core`, `@dzupagent/adapter-types`
- peer deps relevant to pipeline types/usage: `@langchain/core`, `@langchain/langgraph`, `zod`

## Integration Points
### Package root integration
`src/index.ts` re-exports pipeline APIs as part of `@dzupagent/codegen` public surface. Consumers can build phase configs and execute custom runtime phases without importing from deep paths.

### Guardrails integration
`PipelineExecutor` accepts a `GuardrailGateConfig` and caller-provided `buildGuardrailContext` function. This keeps guardrail policy definitions in `src/guardrails/*` while pipeline owns execution-time gating decisions.

### Budget integration
Budget policy is externalized via injected `checkBudget(workflowRunId, budgetLimitCents)` function. The pipeline module does not implement ledger persistence.

### Skills integration
Skill resolution is pluggable via optional `SkillRegistry` and `SkillLoader` from `@dzupagent/core`. Phase skill strings are resolved at execution-time and written into state for downstream phase logic.

### State contract integration
The executor uses a generic `Record<string, unknown>` state. The codegen-specific `BaseGenState` contract in `phase-types.ts` provides a stronger typed model for callers that implement codegen workflows.

## Testing and Observability
### Test coverage in this package
Pipeline behavior is covered by focused suites in `src/__tests__`, including:

- `pipeline-executor.test.ts`
- `pipeline-executor-extended.test.ts`
- `pipeline-components.test.ts`
- `gen-pipeline-builder.test.ts`
- `phase-conditions.test.ts`
- `fix-escalation.test.ts`
- `budget-gate.test.ts`
- `skill-resolver.test.ts`

These tests exercise ordering, retries, timeout outcomes, conditional skipping, callback behavior, gate failures, skill resolution/injection behavior, and builder defaults.

### Built-in observability signals
The subsystem exposes runtime signals through:

- `PhaseResult[]` with status/duration/retry/error metadata
- `totalDurationMs` and final `status` in `PipelineExecutionResult`
- state markers and gate snapshots (`__phase_*`, `__skills_*`, `__skill_context`)
- callback hooks:
  - `onProgress(phaseId, progress)`
  - `onCheckpoint(phaseId, state)`

Operational note: unresolved skills produce `console.warn` messages in `resolveSkills`.

## Risks and TODOs
- Builder and executor are intentionally separate models. `PipelinePhase.skipCondition` does not automatically map to executor `PhaseConfig.condition`; callers must bridge this explicitly.
- Timeout handling uses a race and does not cancel user phase code cooperatively; long-running work may continue outside the timeout winner path.
- Budget and guardrail checks are all-or-stop gates in executor flow; there is no native partial continuation strategy after a failed gate.
- `skill-resolver.ts` is internal-only (not package-root exported). External consumers relying on root exports cannot directly call those helpers.
- The executor state bag is flexible but untyped at runtime (`Record<string, unknown>`), so key collisions (`__phase_*`, custom outputs) remain caller-managed.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

