# `packages/codegen/src/pipeline` Architecture

## Scope
This folder contains the codegen pipeline primitives and runtime compatibility executor:

- `gen-pipeline-builder.ts` — fluent configuration builder for codegen phases.
- `phase-types.ts` — shared type contracts for codegen generation/fix/review state.
- `pipeline-executor.ts` — runtime-backed phase executor with DAG validation, retries, timeouts, conditions, checkpoint/progress callbacks.
- `guardrail-gate.ts` — pass/fail gate around `GuardrailEngine` reports.
- `budget-gate.ts` — cost budget pre-flight gate per phase.
- `skill-resolver.ts` — resolves skill names and injects content into phase state.
- `phase-conditions.ts` — composable condition predicates for phase execution.
- `fix-escalation.ts` — escalating fix strategy selection for repeated failures.

All of these are publicly exported from `packages/codegen/src/index.ts`.

## What This Module Solves
This folder provides a layered pipeline system for code generation workflows:

1. A configuration layer (`GenPipelineBuilder`) that captures phase intent.
2. A runtime execution layer (`PipelineExecutor`) that executes phase functions on mutable shared state.
3. Optional policy gates (guardrails, budget).
4. Optional prompt context enrichment (skills).
5. Reusable orchestration helpers (conditions, escalation).

The key architectural choice is that `PipelineExecutor` now delegates execution to `@dzupagent/agent` `PipelineRuntime` while preserving a simple `PhaseConfig[]` API for codegen callers.

## Public API

### Builder and phase contracts

- `GenPipelineBuilder`
- `PipelinePhase`
- `BaseGenState`
- `GenPhaseConfig` (from `phase-types.ts`)
- `SubAgentPhaseConfig`
- `ValidationPhaseConfig`
- `FixPhaseConfig`
- `ReviewPhaseConfig`

### Executor and runtime outputs

- `PipelineExecutor`
- `ExecutorConfig`
- `ExecutorPhaseConfig`
- `PhaseResult`
- `PipelineExecutionResult`

### Gates and orchestration helpers

- `runGuardrailGate`
- `summarizeGateResult`
- `runBudgetGate`
- `hasKey`, `previousSucceeded`, `stateEquals`, `hasFilesMatching`, `allOf`, `anyOf`
- `DEFAULT_ESCALATION`, `getEscalationStrategy`

## Architectural Model

### 1. Two phase models intentionally coexist

- `PipelinePhase` in `gen-pipeline-builder.ts` is configuration-first and codegen-domain-specific (`generation|subagent|validation|fix|review|guardrail`).
- `PhaseConfig` in `pipeline-executor.ts` is execution-first (`id`, `execute`, `dependsOn`, `condition`, retries/timeouts).

This separation keeps the builder ergonomic while allowing runtime mechanics to evolve independently.

### 2. Compatibility runtime strategy

`PipelineExecutor` translates `PhaseConfig[]` into a minimal `PipelineDefinition`:

- creates transform nodes from sorted phases,
- wires sequential edges,
- runs via `PipelineRuntime`.

This keeps codegen on the canonical runtime while preserving legacy caller shape.

### 3. State-based coordination

Phases communicate through one mutable state object. Executor writes control markers:

- `__phase_<id>_completed`
- `__phase_<id>_skipped`
- `__phase_<id>_guardrail`
- `__phase_<id>_budget`
- `__skills_<phase>`
- `__skills_prompt_<phase>`
- `__skill_context`

This allows later conditions/gates/prompts to use prior phase outcomes.

## Feature Breakdown

### `gen-pipeline-builder.ts`

- Fluent phase appending: generation, subagent, validation, fix, review.
- Guardrail phase registration via `withGuardrails()` and retrievable config via `getGuardrailConfig()`.
- Query helpers: `getPhases()`, `getPhase()`, `getPhaseNames()`, `getGenerationPhases()`.
- Defaults:
  - validation name: `validate`
  - fix name: `fix`, attempts: `3`, escalation: `DEFAULT_ESCALATION`
  - review name: `review`, `autoApprove=false`

Design note:

- It does not compile to executable graph topology by itself.

### `phase-types.ts`

- Declares reusable codegen workflow shapes:
  - generation/subagent configs,
  - validation/fix/review configs,
  - `BaseGenState` shared state envelope.
- Strongly typed domain fields for fix/testing/validation context.

Design note:

- This is a type contract layer, not runtime behavior.

### `pipeline-executor.ts`

Core runtime behaviors:

- Topological sort with cycle and unknown-dependency detection.
- Conditional execution (`condition(state)`), skip markers.
- Retry loop with optional exponential backoff (`1s`, `2s`, `4s`... capped at `30s`).
- Per-phase timeout support with fallback to executor defaults.
- Optional `onProgress` and `onCheckpoint` callbacks.
- Optional skill resolution/injection before phase execution.
- Optional budget gate before phase execution.
- Optional guardrail gate after successful phase execution.
- Output/state merging via `Object.assign(state, phaseOutput)`.

Important behavior notes:

- A failed phase causes overall `PipelineRuntime` completion state to be non-completed, so result status is `failed`.
- Budget gate failure is recorded as phase `failed` (not `skipped`).
- Guardrail failure is treated as phase failure and blocks checkpoint callback.
- Although dependencies are validated and sorted, emitted runtime edges are sequential between sorted nodes.

### `guardrail-gate.ts`

- Wraps `GuardrailEngine.evaluate(context)` to produce a gate-level pass/fail.
- Modes:
  - normal: errors block, warnings do not.
  - strict: errors and warnings both block.
- Optional reporter formatting passthrough.
- `summarizeGateResult()` formats concise failure reasons with top violation list.

### `budget-gate.ts`

- Thin adapter around caller-provided `checkBudget(workflowRunId, budgetLimitCents)`.
- Converts external `withinBudget` to local `passed` shape.
- Intended to run before every phase in executor.

### `skill-resolver.ts`

- Resolution precedence:
  1. registry (`SkillRegistry.get`) first,
  2. loader (`SkillLoader.loadSkillContent`) fallback.
- Missing/failed lookups are skipped and warned.
- Prompt section formatter produces:
  - `## Active Skills`
  - `### <skill-name>` sections with raw content.
- Injection sanitizes phase name for state keys.

### `phase-conditions.ts`

Provides small composable predicates:

- existence/completion/value checks (`hasKey`, `previousSucceeded`, `stateEquals`),
- pattern scan over `files` (`hasFilesMatching`),
- combinators (`allOf`, `anyOf`).

### `fix-escalation.ts`

- Encodes multi-attempt corrective strategy escalation:
  - `targeted` (default),
  - `expanded` (full VFS + plan context),
  - `escalated` (reasoning tier + broader rewrite guidance).
- `getEscalationStrategy()` clamps attempts to last strategy.

## Execution Flow

`PipelineExecutor.execute(phases, initialState)`:

1. Topologically sort phases.
2. Build compatibility `PipelineDefinition` nodes from sorted phases.
3. Start `PipelineRuntime.execute()` with shared state copy.
4. For each node:
   - resolve phase from `nodeMap`,
   - verify dependencies completed,
   - evaluate `condition`,
   - run budget gate (if configured),
   - resolve/inject skills (if configured),
   - execute with timeout + retries,
   - merge output into state,
   - run guardrail gate (if configured),
   - mark completion and call checkpoint callback.
5. Aggregate per-phase results and return final status/state/duration.

## Usage Examples

### 1. Build codegen phase configuration

```ts
import { GenPipelineBuilder, DEFAULT_ESCALATION } from '@dzupagent/codegen'

const pipelineConfig = new GenPipelineBuilder()
  .addPhase({
    name: 'generate-backend',
    promptType: 'backend',
    skills: ['typescript', 'security-best-practices'],
  })
  .addValidationPhase({
    dimensions: ['correctness', 'type-safety'],
    threshold: 85,
  })
  .addFixPhase({
    maxAttempts: DEFAULT_ESCALATION.maxAttempts,
    escalation: DEFAULT_ESCALATION,
  })
  .addReviewPhase({ autoApprove: false })

const phases = pipelineConfig.getPhases()
```

### 2. Execute runtime phases with dependencies/retries

```ts
import { PipelineExecutor, type ExecutorPhaseConfig } from '@dzupagent/codegen'

const executor = new PipelineExecutor({
  defaultTimeoutMs: 120_000,
  defaultMaxRetries: 1,
  onProgress: (phaseId, progress) => {
    console.log(`[${phaseId}] progress=${progress}`)
  },
})

const phases: ExecutorPhaseConfig[] = [
  {
    id: 'plan',
    name: 'Plan',
    execute: async (state) => ({ ...state, plan: 'v1' }),
  },
  {
    id: 'generate',
    name: 'Generate',
    dependsOn: ['plan'],
    retryStrategy: 'backoff',
    maxRetries: 2,
    condition: (state) => state['plan'] !== undefined,
    execute: async (state) => ({ generated: true, plan: state['plan'] }),
  },
]

const result = await executor.execute(phases, { runId: 'r-1' })
```

### 3. Add budget + guardrail + skills in one executor

```ts
import {
  PipelineExecutor,
  type GuardrailGateConfig,
  type SkillResolverConfig,
  type BudgetGateConfig,
} from '@dzupagent/codegen'

const guardrailGate: GuardrailGateConfig = {
  engine: guardrailEngine,
  strictMode: false,
  reporter: guardrailReporter,
}

const skillResolver: SkillResolverConfig = {
  registry: skillRegistry,
  loader: skillLoader,
}

const budgetGate: BudgetGateConfig = {
  workflowRunId: 'wf-123',
  budgetLimitCents: 500,
  checkBudget: async (runId, limit) => executionLedger.checkBudget(runId, limit),
}

const executor = new PipelineExecutor({
  guardrailGate,
  buildGuardrailContext: (_phaseId, state) => buildContextFromState(state),
  skillResolver,
  skillResolutionContext: {
    agentId: 'codegen-agent',
    projectRoot: '/workspace/repo',
    skills: [],
  },
  budgetGate,
})

const result = await executor.execute(
  [
    {
      id: 'gen',
      name: 'Generate',
      skills: ['repo-conventions'],
      execute: async () => ({ filesGenerated: 4 }),
    },
  ],
  {},
)
```

## Common Use Cases

- Multi-phase feature generation with deterministic step ordering.
- Validation/fix loops with escalating strategy strength.
- Cost-aware generation with hard stop when budget is exceeded.
- Guardrail-enforced generation for architecture/security constraints.
- Skill-augmented prompt assembly per phase.
- CI agent workflows that require checkpoints and partial progress events.

## References and Usage Across Packages

### Direct symbol usage (code scan)
Current monorepo scan shows:

- direct imports of `pipeline/*` symbols are currently inside `@dzupagent/codegen` tests and internal wiring,
- no direct runtime imports of `GenPipelineBuilder` or `PipelineExecutor` from other packages.

### Package-level `@dzupagent/codegen` consumers
Other packages do import `@dzupagent/codegen`, but for non-pipeline capabilities:

- `packages/server/src/runtime/tool-resolver.ts` dynamically imports codegen for git tools (`createGitTools`, `GitExecutor`).
- `packages/evals/src/__tests__/sandbox-contracts.test.ts` conditionally imports sandbox implementations.
- `packages/create-dzupagent/src/templates/codegen.ts` declares `@dzupagent/codegen` as template dependency.

Implication:

- `src/pipeline` is a public API surface intended for external/domain consumption, but currently has limited in-repo cross-package runtime adoption.

## Test Coverage

### Targeted suites executed
Executed focused pipeline suites:

- `src/__tests__/pipeline-components.test.ts`
- `src/__tests__/pipeline-executor.test.ts`
- `src/__tests__/pipeline-executor-extended.test.ts`
- `src/__tests__/budget-gate.test.ts`

Result:

- 4 files passed
- 94 tests passed

### Per-file coverage (`packages/codegen/coverage/coverage-summary.json`)

- `pipeline/budget-gate.ts`: lines 100%, statements 100%, functions 100%, branches 100%
- `pipeline/fix-escalation.ts`: lines 100%, statements 100%, functions 100%, branches 50%
- `pipeline/gen-pipeline-builder.ts`: lines 100%, statements 100%, functions 100%, branches 100%
- `pipeline/guardrail-gate.ts`: lines 100%, statements 100%, functions 100%, branches 92.3%
- `pipeline/phase-conditions.ts`: lines 100%, statements 100%, functions 100%, branches 100%
- `pipeline/pipeline-executor.ts`: lines 93.2%, statements 93.2%, functions 100%, branches 86.25%
- `pipeline/skill-resolver.ts`: lines 100%, statements 100%, functions 100%, branches 100%

Coverage caveat:

- `phase-types.ts` is a type-only contract module and is not represented in runtime coverage metrics.
- The focused coverage command fails package-global thresholds (expected), but pipeline module metrics are still valid and high-signal.

### What is well-tested

- Builder defaults and fluent behavior.
- Escalation strategy selection and clamping.
- Predicate truth tables (`allOf`/`anyOf` empty edge cases included).
- Skill resolution precedence, formatting, state injection, and loader-failure fallback.
- Guardrail gate strict/normal semantics and summary rendering.
- Executor ordering, dependency validation, cycle detection, timeout/retry paths, callbacks, state propagation, and failure short-circuiting.
- Budget gate behavior and executor integration.

### Remaining gaps (highest value)

- `pipeline-executor.ts`: low-covered branches around:
  - unmet dependency skip path in runtime node execution,
  - skills branch when configured phases include `skills` (executor-level integration path).
- `fix-escalation.ts`: fallback branch for pathological configs (for example empty strategy arrays) is not directly exercised.
- `guardrail-gate.ts`: some blocking-filter branches remain partially uncovered.

## Design Strengths

- Clear separation between config DSL and runtime execution.
- Pragmatic compatibility bridge onto canonical `PipelineRuntime`.
- Strong extension hooks for budget, guardrails, skills, retries, checkpoints.
- High focused test depth for operational behavior.

## Limitations and Risks

- Builder output is not directly executable without domain mapping to executor/runtime phase functions.
- Builder `skipCondition` and executor `condition` are separate concepts; no automatic bridge is provided.
- Timeout currently races execution; it does not cancel in-flight phase work.
- Runtime graph is serialized sequentially after topo sort, so no native parallel branch execution in this layer.
- Missing skill resolution config silently results in no skill injection even if phase declares skills.

## Recommended Next Steps

1. Add one executor integration test that exercises `skills` inside `PipelineExecutor` (not only resolver unit tests).
2. Add one explicit unmet-dependency runtime test that forces the skip branch deterministically.
3. Add abort-signal propagation to `PhaseConfig.execute` for real timeout cancellation semantics.
4. If needed, add adapter utility to transform `GenPipelineBuilder` output directly into executable `ExecutorPhaseConfig[]`.
5. Update `packages/codegen/README.md` pipeline snippet to match current `GenPipelineBuilder` API shape.
