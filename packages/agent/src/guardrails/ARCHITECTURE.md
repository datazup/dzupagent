# `src/guardrails` Architecture

## Scope
This document covers `packages/agent/src/guardrails` inside `@dzupagent/agent`.

Included files:
- `guardrail-types.ts`
- `iteration-budget.ts`
- `stuck-detector.ts`
- `cascading-timeout.ts`

Primary consumers are in `src/agent` (`run-engine.ts`, `tool-loop.ts`, `streaming-run.ts`, `dzip-agent.ts`) plus package exports from `src/index.ts`.

## Responsibilities
The guardrails module provides runtime primitives used to constrain and observe agent execution.

- Budget accounting and limits through `IterationBudget` (tokens, cost, iterations).
- Tool deny-list checks through `blockedTools` and runtime blocking via `blockTool`.
- Stuck-loop detection through `StuckDetector` (repeated calls, error bursts, idle heuristics).
- Hierarchical timeout utility through `CascadingTimeout`.
- Shared guardrail contracts through `GuardrailConfig`, `BudgetState`, and `BudgetWarning`.

It does not run the full agent loop by itself; execution control stays in `src/agent`.

## Structure
| File | What it implements |
| --- | --- |
| `guardrail-types.ts` | `GuardrailConfig`, `BudgetState`, `BudgetWarning` |
| `iteration-budget.ts` | `IterationBudget` class (accounting, warnings, hard limits, blocked tools, shared-state fork) |
| `stuck-detector.ts` | `StuckDetector`, `StuckStatus`, and `StuckDetectorConfig` re-export |
| `cascading-timeout.ts` | `CascadingTimeout` and `CascadingTimeoutConfig` |

Export surface:
- Re-exported from `src/index.ts` as public package APIs.
- `StuckDetectorConfig` is imported from `@dzupagent/agent-types` and re-exported by `stuck-detector.ts`.

## Runtime and Control Flow
1. Run-state setup in `src/agent/run-engine.ts`:
- `prepareRunState()` creates `IterationBudget` only when `config.guardrails` exists.
- `prepareRunState()` creates `StuckDetector` by default, even when `guardrails` is absent.
- `StuckDetector` is disabled only when `guardrails.stuckDetector === false`.

2. Non-stream loop in `src/agent/tool-loop.ts` (`runToolLoop()`):
- Checks `budget.isExceeded()` before each model call.
- Records `budget.recordIteration()` and `budget.recordUsage()` and emits warnings.
- Checks `budget.isToolBlocked(toolName)` before invoking tools.
- Calls `stuckDetector.recordToolCall(...)` and `stuckDetector.recordError(...)` during tool execution.
- Uses staged stuck escalation:
- Stage 1 behavior: block repeated tool when budget exists.
- Stage 2 behavior: inject stuck nudge system message.
- Stage 3 behavior: terminate with `stopReason = 'stuck'` and return `StuckError`.
- Calls idle check with `stuckDetector.recordIteration(toolCalls.length)` after tool-call handling.

3. Stream path in `src/agent/streaming-run.ts` and `executeStreamingToolCall()`:
- Reuses the same run-state `IterationBudget` and `StuckDetector`.
- Emits stream events for guardrail signals (`budget_warning`, `stuck`, `done` stop reasons).
- Applies blocked-tool checks and stuck/error handling during tool execution.

4. Output filtering behavior:
- `guardrails.outputFilter` is applied in non-stream `executeGenerateRun()`.
- Native `stream()` completion path does not apply `outputFilter`.

5. Child budget behavior:
- `DzupAgent.createChildBudget()` creates `new IterationBudget(config.guardrails).fork()`.
- `IterationBudget.fork()` shares budget state and emitted-threshold tracking by reference.

## Key APIs and Types
`GuardrailConfig` (`guardrail-types.ts`):
- `maxTokens?: number`
- `maxCostCents?: number`
- `maxIterations?: number`
- `blockedTools?: string[]`
- `budgetWarnings?: number[]` (default threshold behavior in `IterationBudget` is `[0.7, 0.9]`)
- `outputFilter?: (output: string) => Promise<string | null>`
- `stuckDetector?: Partial<StuckDetectorConfig> | false`

`IterationBudget` (`iteration-budget.ts`):
- `recordUsage(usage: TokenUsage): BudgetWarning[]`
- `recordIteration(): BudgetWarning[]`
- `isExceeded(): { exceeded: boolean; reason?: string }`
- `isToolBlocked(toolName: string): boolean`
- `blockTool(toolName: string): void`
- `getState(): Readonly<BudgetState>`
- `fork(): IterationBudget`

`StuckDetector` (`stuck-detector.ts`):
- `recordToolCall(name: string, input: unknown): StuckStatus`
- `recordError(error: Error): StuckStatus`
- `recordIteration(toolCallsThisIteration: number): StuckStatus`
- `reset(): void`
- `lastToolCalls` getter
- Defaults: `maxRepeatCalls=3`, `maxErrorsInWindow=5`, `errorWindowMs=60_000`, `maxIdleIterations=3`

`CascadingTimeout` (`cascading-timeout.ts`):
- `static create(totalMs: number, reserveMs?: number): CascadingTimeout`
- `fork(childMs?: number): CascadingTimeout`
- `signal`, `remainingMs`, `expired`
- `abort(reason?: string): void`
- `dispose(): void`

## Dependencies
Direct module-level dependencies:
- `iteration-budget.ts` uses `calculateCostCents` and `TokenUsage` from `@dzupagent/core`.
- `iteration-budget.ts` uses local `GuardrailConfig`, `BudgetState`, and `BudgetWarning`.
- `stuck-detector.ts` uses Node `crypto` (`createHash`).
- `stuck-detector.ts` uses `StuckDetectorConfig` from `@dzupagent/agent-types`.
- `cascading-timeout.ts` uses built-in `AbortController`, `AbortSignal`, and timers.

Package-level context (`packages/agent/package.json`):
- Runtime dependencies include `@dzupagent/core` and `@dzupagent/agent-types`, which are part of this module chain.

## Integration Points
Internal integration points:
- `src/agent/agent-types.ts`: `DzupAgentConfig.guardrails?: GuardrailConfig`.
- `src/agent/run-engine.ts`: creates budget/detector, applies `outputFilter`, threads guardrails into execution.
- `src/agent/tool-loop.ts`: enforces limits, warnings, blocked tools, and stuck escalation.
- `src/agent/streaming-run.ts`: enforces corresponding guardrail behavior in stream mode.
- `src/agent/dzip-agent.ts`: exposes `createChildBudget()` for shared parent/child budgeting.
- `src/recovery/recovery-copilot.ts`: consumes `StuckStatus` for recovery triggering.
- `src/index.ts`: publishes guardrail classes/types in package public API.

External usage:
- Callers configure guardrails through `DzupAgentConfig.guardrails`.
- Callers can import `IterationBudget`, `StuckDetector`, and `CascadingTimeout` directly from `@dzupagent/agent`.

## Testing and Observability
Guardrail-focused tests in `src/__tests__` include:
- `cascading-timeout.test.ts`
- `stuck-detector.test.ts`
- `stuck-detector-deep.test.ts`
- `stuck-detector-integration.test.ts`
- `stuck-recovery.test.ts`
- `tool-loop-core.test.ts`
- `tool-loop-deep.test.ts`
- `run-engine.test.ts`
- `stream-tool-guardrail-parity.test.ts`

Observability signals tied to guardrails:
- Stream emits `budget_warning`, `stuck`, and `done` stop-reason events.
- Event bus emits `agent:stuck_detected` from non-stream and stream execution paths.
- Budget threshold crossings are surfaced through warning callbacks/events.

## Risks and TODOs
- Idle stuck detection is difficult to trigger in the default tool-loop path because `recordIteration()` is called only after non-empty tool-call turns; tests explicitly document this and use mocks for that branch.
- `outputFilter` is applied in `generate()` result assembly but not in native `stream()` completion.
- `IterationBudget.blockTool()` mutates `GuardrailConfig.blockedTools` in place; shared-config callers need to treat this as mutable runtime state.
- `CascadingTimeout` is an exported utility with tests, but it is not wired into agent run-engine timeout orchestration by default.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.

