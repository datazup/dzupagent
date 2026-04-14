# `src/guardrails` Architecture

This document describes the current implementation in `packages/agent/src/guardrails` as of **April 4, 2026**.

## 1. Scope

This folder provides runtime safety primitives for `@dzupagent/agent`:

1. `IterationBudget` for token/cost/iteration limits and warnings.
2. `StuckDetector` for no-progress loop detection.
3. `CascadingTimeout` for parent/child timeout trees.
4. Guardrail contracts (`GuardrailConfig`, `BudgetState`, `BudgetWarning`).

These primitives are consumed by the agent runtime (`src/agent/*`) and re-used as design patterns by `@dzupagent/agent-adapters`.

## 2. File Map

| File | Responsibility |
|---|---|
| `guardrail-types.ts` | Type contracts for guardrail configuration and budget state |
| `iteration-budget.ts` | Tracks cumulative usage, emits warning thresholds, enforces hard limits, blocks tools |
| `stuck-detector.ts` | Detects repeated tool calls, error bursts, and idle iterations |
| `cascading-timeout.ts` | Builds hierarchical abortable deadlines with reserve time |

## 3. Feature Breakdown

### 3.1 `GuardrailConfig` (`guardrail-types.ts`)

Primary guardrail knobs:

1. `maxTokens`, `maxCostCents`, `maxIterations` for hard limits.
2. `blockedTools` for explicit tool deny-list.
3. `budgetWarnings` threshold array (`[0.7, 0.9]` default in `IterationBudget`).
4. `outputFilter(output) => Promise<string | null>` for final-output post-processing.
5. `stuckDetector` as either:
   - `Partial<StuckDetectorConfig>` to override defaults, or
   - `false` to disable stuck detection.

### 3.2 `IterationBudget` (`iteration-budget.ts`)

Core behaviors:

1. Tracks cumulative state:
   - `totalInputTokens`, `totalOutputTokens`, `totalCostCents`, `llmCalls`, `iterations`.
2. Records usage via `recordUsage(TokenUsage)` using `calculateCostCents` from `@dzupagent/core`.
3. Records loop progress via `recordIteration()`.
4. Emits threshold warnings only once per `(metric, threshold)` using `emittedThresholds`.
5. Enforces hard-stop semantics with `isExceeded()` using `>=` comparisons.
6. Supports runtime dynamic tool blocking:
   - `isToolBlocked(toolName)`
   - `blockTool(toolName)`
7. Supports shared accounting via `fork()`:
   - child and parent share the same `BudgetState` reference and threshold memory.

### 3.3 `StuckDetector` (`stuck-detector.ts`)

Detection heuristics:

1. **Repeated identical tool call**:
   - compares last `maxRepeatCalls` entries using `toolName + sha256(input)` prefix hash.
2. **Error burst in sliding window**:
   - `maxErrorsInWindow` inside `errorWindowMs`.
3. **Idle loop detection**:
   - consecutive `recordIteration(0)` up to `maxIdleIterations`.

Default config:

1. `maxRepeatCalls: 3`
2. `maxErrorsInWindow: 5`
3. `errorWindowMs: 60_000`
4. `maxIdleIterations: 3`

Operational details:

1. `recordToolCall()` resets idle counter.
2. `recordIteration(toolCallsThisIteration)` updates `lastToolCalls`.
3. `reset()` clears all tracked state.

### 3.4 `CascadingTimeout` (`cascading-timeout.ts`)

Design:

1. Each timeout node owns an `AbortController` and absolute deadline.
2. Parent abort cascades to children; child abort does not propagate upward.
3. Child deadline is constrained by `remaining(parent) - reserveMs`.
4. Default `reserveMs` is `1000ms`.

Important runtime guarantees:

1. `fork(childMs)` never exceeds parent available time.
2. `remainingMs` clamps to `>= 0`.
3. `dispose()` clears timers/listeners recursively (leak prevention).
4. Timers call `.unref()` when available to avoid keeping Node alive.

## 4. Runtime Flow

### 4.1 Non-stream `generate()` flow

1. `prepareRunState()` creates:
   - `IterationBudget` when `config.guardrails` exists.
   - `StuckDetector` unless `guardrails.stuckDetector === false`.
2. `runToolLoop()` enforces loop-level guardrails:
   - pre-iteration hard-limit check via `budget.isExceeded()`
   - iteration accounting and warnings via `budget.recordIteration()`
   - usage accounting and warnings via `budget.recordUsage()`
3. Tool execution path checks:
   - blocked tools before invocation (`budget.isToolBlocked()`).
   - stuck signals after invocation/error.
4. Stuck escalation inside loop:
   - stage 1: block repeated tool (`budget.blockTool(tool)`), emit nudge.
   - stage 2: inject system nudge message.
   - stage 3: stop with `stopReason = 'stuck'` and `StuckError`.
5. `executeGenerateRun()` applies `guardrails.outputFilter` to final content.

### 4.2 Stream flow

1. Stream path uses the same prepared guardrail objects (`IterationBudget`, `StuckDetector`).
2. Emits `budget_warning` events when threshold warnings trigger.
3. Emits `stuck` events and eventually `done { stopReason: 'stuck' }` when detector trips.
4. Streaming tool calls also enforce dynamic blocked-tool behavior.
5. Current behavior difference: output filtering is applied in `generate()` path, not in native `stream()` done-content assembly.

## 5. Usage Examples

### 5.1 Basic guardrails with `DzupAgent`

```ts
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent({
  id: 'safe-coder',
  instructions: 'Write safe, concise changes.',
  model: myModel,
  guardrails: {
    maxIterations: 12,
    maxTokens: 120_000,
    maxCostCents: 75,
    blockedTools: ['rm_rf', 'prod_write'],
    budgetWarnings: [0.6, 0.8, 0.95],
  },
})
```

### 5.2 Output filtering

```ts
const agent = new DzupAgent({
  id: 'sanitized-agent',
  instructions: 'Never expose secrets.',
  model: myModel,
  guardrails: {
    outputFilter: async (output) => {
      const redacted = output.replace(/api[_-]?key\s*:\s*\S+/gi, 'api_key: [REDACTED]')
      return redacted
    },
  },
})
```

### 5.3 Disable stuck detection

```ts
const agent = new DzupAgent({
  id: 'no-stuck-heuristics',
  instructions: 'Long-running exploration mode.',
  model: myModel,
  guardrails: {
    maxIterations: 50,
    stuckDetector: false,
  },
})
```

### 5.4 Direct budget sharing across parent/child logic

```ts
import { IterationBudget } from '@dzupagent/agent'

const parentBudget = new IterationBudget({ maxTokens: 200_000, maxIterations: 30 })
const childBudget = parentBudget.fork()

parentBudget.recordIteration()
childBudget.recordIteration()

// Shared state: total iterations now reflect both calls.
console.log(parentBudget.getState().iterations) // 2
```

### 5.5 Cascading timeout tree

```ts
import { CascadingTimeout } from '@dzupagent/agent'

const root = CascadingTimeout.create(30_000, 1_000)
const child = root.fork(10_000)

await runChildTask({ signal: child.signal })

// If root aborts, child.signal aborts automatically.
```

## 6. References in Other Packages

### 6.1 Internal `@dzupagent/agent` usage

Guardrails are integrated primarily in:

1. `src/agent/run-engine.ts`
   - constructs budget/detector from `DzupAgentConfig.guardrails`
   - applies `outputFilter` in `generate()` flow.
2. `src/agent/tool-loop.ts`
   - hard limits, warnings, blocked tools, and stuck escalation.
3. `src/agent/dzip-agent.ts`
   - stream-loop budget/stuck events and stop-reason telemetry.
4. `src/recovery/recovery-copilot.ts`
   - consumes `StuckStatus` to trigger recovery plan creation.
5. `src/templates/template-composer.ts` and `src/presets/*`
   - propagate policy-like guardrail defaults (`max*` fields).

### 6.2 `@dzupagent/agent-adapters` (pattern adaptation)

`packages/agent-adapters/src/guardrails/adapter-guardrails.ts` explicitly adapts these patterns to adapter event streams:

1. `AdapterStuckDetector` mirrors the same repeated-call/error/idle heuristics.
2. `AdapterGuardrails` enforces iteration/token/cost/duration/tool-block checks on `AgentEvent` streams.
3. `OrchestratorFacade` maps compiled policy `guardrails.maxIterations` into adapter input `maxTurns`.

### 6.3 Server and UI surfaces

1. `packages/server` stores and renders `guardrails` as generic metadata (`Record<string, unknown>`) for agent definitions and docs.
2. `packages/playground` displays configured guardrails in the inspector panel and typed API models.

These packages mostly transport/display guardrail settings rather than executing `src/guardrails` classes directly.

## 7. Test Coverage

### 7.1 Focused verification run

Executed on **April 4, 2026**:

```bash
yarn workspace @dzupagent/agent test:coverage -- \
  src/__tests__/stuck-detector.test.ts \
  src/__tests__/cascading-timeout.test.ts \
  src/__tests__/stuck-recovery.test.ts \
  src/__tests__/token-usage.test.ts
```

Result highlights:

1. 4 test files, 48 tests passed.
2. Coverage report for `src/guardrails`:
   - Statements: **88.88%**
   - Branches: **87.32%**
   - Functions: **89.28%**
   - Lines: **88.88%**
3. Per-file:
   - `cascading-timeout.ts`: **99.32% lines**
   - `stuck-detector.ts`: **98.33% lines**
   - `iteration-budget.ts`: **70.54% lines**

Note: command exits non-zero because package-level global coverage thresholds apply to the whole package, while this run intentionally scoped tests to guardrail-related files.

### 7.2 What is covered well

1. Repeated-call, error-window, idle-loop stuck detection.
2. Stuck recovery escalation stages in tool loop (block tool, nudge, abort).
3. Timeout tree semantics (reserve budget, cascading abort, disposal, abort reason).
4. Stream budget warning emission using real provider token metadata.

### 7.3 Current coverage gaps

1. `iteration-budget.ts` is partially covered:
   - no dedicated unit test file for all threshold permutations and fork-sharing edge cases.
2. Output filtering parity is only explicit in generate-path behavior; native streaming path does not apply the same final-output filter logic.
3. `GuardrailConfig` is primarily a type contract; runtime validation of malformed config values is not centralized in this module.
