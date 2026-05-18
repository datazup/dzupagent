# `src/guardrails` Architecture

## Scope
This document describes `packages/agent/src/guardrails` in `@dzupagent/agent`.

In scope:
- `guardrail-types.ts`
- `iteration-budget.ts`
- `stuck-detector.ts`
- `cascading-timeout.ts`
- `distributed-rate-limiter.ts`
- `distributed-budget.ts`

Primary consumers are in `src/agent/**` (`run-engine`, `tool-loop`, `streaming-run`, `dzip-agent`, `rate-limit-coordinator`, `event-bus-installer`) plus top-level package exports.

Out of scope:
- Tool-governance policy (`src/agent/tool-loop/**`) except where it calls guardrail primitives.
- Pipeline-specific stuck/budget systems under `src/pipeline/**` and `src/self-correction/**`.

## Responsibilities
`src/guardrails` provides reusable safety primitives and contracts for agent execution:
- In-process budget accounting for tokens, cost, and iterations via `IterationBudget`.
- Runtime tool blocklist checks (`blockedTools`) plus dynamic per-run blocking (`blockTool`).
- Stuck-detection import compatibility via `StuckDetector` re-export.
- Hierarchical timeout utility via `CascadingTimeout`.
- Optional distributed guardrails (multi-instance rate and spend controls) via `DistributedRateLimiter` and `DistributedCostLedger`.
- Shared configuration/types via `GuardrailConfig`, `DistributedGuardrailConfig`, `BudgetState`, and `BudgetWarning`.

This folder does not orchestrate runs directly; `src/agent/**` owns loop execution and event ordering.

## Structure
| File | Purpose |
| --- | --- |
| `guardrail-types.ts` | Guardrail contracts (`GuardrailConfig`, `DistributedGuardrailConfig`, `BudgetState`, `BudgetWarning`) |
| `iteration-budget.ts` | `IterationBudget` implementation for cumulative usage, warning thresholds, hard-limit checks, dynamic tool blocking, and shared-state `fork()` |
| `stuck-detector.ts` | Compatibility re-export of `StuckDetector`, `StuckStatus`, `StuckDetectorConfig` from `@dzupagent/core/utils` |
| `cascading-timeout.ts` | `CascadingTimeout` tree-based timeout utility (`create`, `fork`, abort cascade, `dispose`) |
| `distributed-rate-limiter.ts` | `DistributedRateLimiter` plus structural Redis client and local fallback interfaces |
| `distributed-budget.ts` | `DistributedCostLedger` plus structural Redis client and record/read/reset semantics |

Export surface:
- Root barrel `src/index.ts` exports all six guardrail modules (including distributed guardrails).
- `src/agent.ts` and `src/tools.ts` export core guardrails (`IterationBudget`, `StuckDetector`, `CascadingTimeout`) and guardrail types.
- Distributed guardrail classes/types are currently exposed from the root barrel (`src/index.ts`), not `src/tools.ts`.

## Runtime and Control Flow
1. Configuration and construction:
- `DzupAgentConfig.guardrails?: GuardrailConfig` is defined in `src/agent/agent-types-config.ts`.
- `installEventBus()` (`src/agent/event-bus-installer.ts`) reads `config.guardrails?.distributed` and conditionally constructs:
- `DistributedRateLimiter` (with optional local `TokenBucket` fallback).
- `DistributedCostLedger`.

2. Run-state guardrail setup (`prepareRunState` in `src/agent/run-engine.ts`):
- Always constructs an `IterationBudget`.
- If `config.guardrails` is defined, budget uses that config directly.
- If `config.guardrails` is `undefined`, a default budget is installed (`DEFAULT_UNGUARDED_BUDGET`: `maxTokens=50_000`, `maxIterations=5`) and a one-shot warning is logged per agent id.
- `StuckDetector` is created unless `guardrails.stuckDetector === false`.
- If `guardrails.stuckDetector` is an object, it is passed through to detector construction.

3. Non-streaming execution (`runToolLoop` and staged helpers):
- Per iteration, budget hard limits are checked (`isExceeded`) and warnings are emitted from `recordIteration` / `recordUsage`.
- Tool execution checks `budget.isToolBlocked(toolName)` before invocation.
- Stuck handling uses detector outcomes from tool results/errors and idle checks:
- Repeated-tool signals can trigger `budget.blockTool(toolName)` and nudge insertion.
- Escalation can terminate with `stopReason: 'stuck'` and produce `StuckError`.
- Terminal stop-reason telemetry is emitted by post-processing (`agent:stop_reason`).

4. Streaming execution (`streamRun` and helpers):
- Reuses the same `IterationBudget` and `StuckDetector` from prepared run state.
- Emits `budget_warning` events from both iteration and usage recording.
- Emits `stuck` stream events and `agent:stuck_detected` on stuck conditions.
- Applies `guardrails.outputFilter` on final completion content before `done` and memory write-back (parity with generate path for this legacy filter).

5. Distributed guardrail enforcement in model invocation:
- In generate-mode (and the stream fallback path that delegates to generate), `invokeModelWithMiddleware` calls `awaitRateLimit()` before model invocation and `recordDistributedCost()` after success.
- `awaitRateLimit()` uses distributed limiter when configured, otherwise local limiter path.
- `recordDistributedCost()` writes to distributed ledger and emits `agent:rate_limited` when ceiling is reached.
- Distributed ledger/rate errors are best-effort and do not crash runs by themselves.

6. Child-budget behavior:
- `DzupAgent.createChildBudget()` returns `new IterationBudget(config.guardrails).fork()` when guardrails are configured.
- `fork()` shares budget state, emitted-threshold tracking, and dynamic blocked-tool set by reference.

## Key APIs and Types
`GuardrailConfig` (`guardrail-types.ts`):
- Limits: `maxTokens`, `maxCostCents`, `maxIterations`.
- Tool blocklist: `blockedTools`.
- Warning thresholds: `budgetWarnings` (default used by `IterationBudget`: `[0.7, 0.9]`).
- Legacy output filter: `outputFilter`.
- Stuck detector config/disable: `stuckDetector?: Partial<StuckDetectorConfig> | false`.
- Distributed config: `distributed?: DistributedGuardrailConfig`.

`DistributedGuardrailConfig`:
- `rateLimiter` config: `client`, `windowMs`, `maxRequests`, `keyPrefix`, `fallbackToLocal`.
- `costLedger` config: `client`, `maxCostUsd`, `ttlMs`, `keyPrefix`, `fallbackToLocal`.

`IterationBudget` (`iteration-budget.ts`):
- `recordUsage(usage: TokenUsage): BudgetWarning[]`
- `recordIteration(): BudgetWarning[]`
- `isExceeded(): { exceeded: boolean; reason?: string }`
- `isToolBlocked(toolName: string): boolean`
- `blockTool(toolName: string): void`
- `getState(): Readonly<BudgetState>`
- `fork(): IterationBudget`

`StuckDetector` (`stuck-detector.ts` re-export):
- Exported as a compatibility shim from `@dzupagent/core/utils` (implementation not in this folder).
- Exposes `StuckDetector`, `StuckStatus`, `StuckDetectorConfig`.

`CascadingTimeout` (`cascading-timeout.ts`):
- `create(totalMs, reserveMs?)`
- `fork(childMs?)`
- `signal`, `remainingMs`, `expired`
- `abort(reason?)`
- `dispose()`

Distributed primitives:
- `DistributedRateLimiter.tryConsume(tenantId, agentId)` and `reset(...)`.
- `DistributedCostLedger.record(tenantId, agentId, costUsd)`, `read(...)`, `reset(...)`.

## Dependencies
Direct module dependencies:
- `iteration-budget.ts` depends on `@dzupagent/core/llm` (`calculateCostCents`, `TokenUsage`).
- `stuck-detector.ts` depends on `@dzupagent/core/utils` (re-export only).
- `distributed-rate-limiter.ts` depends on `@dzupagent/core/llm` type `TokenBucket`.
- `distributed-budget.ts` depends on local `RateLimiterClient` shape from `distributed-rate-limiter.ts`.
- `cascading-timeout.ts` uses platform `AbortController`, `AbortSignal`, timers.

Package dependencies relevant to this folder (`packages/agent/package.json`):
- `@dzupagent/core`
- `@dzupagent/agent-types` (package-level dependency; current stuck-detector surface is sourced from `@dzupagent/core/utils`)

## Integration Points
Primary integrations:
- `src/agent/agent-types-config.ts`: public `DzupAgentConfig.guardrails` contract.
- `src/agent/event-bus-installer.ts`: distributed guardrail object construction and wiring.
- `src/agent/rate-limit-coordinator.ts`: distributed limiter gate and distributed cost recording.
- `src/agent/run-engine.ts`: default budget installation and stuck detector setup.
- `src/agent/tool-loop.ts` and `src/agent/tool-loop/result-pipeline.ts`: budget enforcement, dynamic blocks, stuck escalation.
- `src/agent/streaming-run*.ts` and `src/agent/stream-result-helpers.ts`: stream-mode parity for budget/stuck behavior and blocked-tool handling.
- `src/agent/dzip-agent.ts`: `createChildBudget()` helper.

Public integration:
- Consumers configure safety through `DzupAgentConfig.guardrails`.
- Consumers can directly instantiate/import guardrail primitives from `@dzupagent/agent` root exports.

## Testing and Observability
Guardrail-focused tests in `src/__tests__` include:
- `cascading-timeout.test.ts`
- `distributed-rate-limiter.test.ts`
- `distributed-budget.test.ts`
- `stuck-detector.test.ts`
- `stuck-detector-deep.test.ts`
- `stuck-detector-integration.test.ts`
- `stuck-recovery.test.ts`
- `tool-loop-core.test.ts`
- `tool-loop-deep.test.ts`
- `run-engine.test.ts`
- `stream-tool-guardrail-parity.test.ts`

Notable tested behaviors:
- Default unguarded budget fallback (`RF-04`) when `guardrails` is omitted.
- `stuckDetector: false` fully disables detector wiring.
- Stream/generate parity for legacy `guardrails.outputFilter`.
- Distributed limiter/ledger failover behavior (`fallbackToLocal` true/false).

Observability/event surface tied to guardrails:
- Stream events: `budget_warning`, `stuck`, terminal `done` with stop reason.
- Event bus: `agent:stuck_detected`, `agent:rate_limited`, `agent:stop_reason`, plus `run:halted:token-exhausted` for halt cases.

## Risks and TODOs
- `guardrails: {}` is treated as explicit configuration and bypasses unguarded defaults, which can leave budgets effectively uncapped unless callers set limits intentionally.
- Distributed cost ceiling currently emits `agent:rate_limited` telemetry when exceeded but does not hard-stop the in-flight run by itself.
- Native streaming fast path opens provider streams directly and does not currently pass through `awaitRateLimit()` / `recordDistributedCost()`, so distributed guardrail coverage is stronger on generate/fallback paths than on native stream.
- `CascadingTimeout` is exported and tested, but not yet wired as the default timeout primitive in the main run-engine loop.
- Distributed guardrail exports are split across entrypoints (`src/index.ts` has them; `src/tools.ts` currently does not), which can surprise subpath consumers expecting symmetry.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js