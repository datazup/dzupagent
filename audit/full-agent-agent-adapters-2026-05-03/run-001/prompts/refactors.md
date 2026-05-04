# Refactor Prompts (P2 — 4–8h each)

Each prompt is self-contained. Run `yarn verify` after each.

---

## RF-01: Extract `executeStreamingToolCall` into testable helpers
**Finding:** C-03 (Code/P1)
**Agent:** `dzupagent-agent-dev`

**Target file:** `packages/agent/src/agent/run-engine.ts:523–919`

The `executeStreamingToolCall` function is 396 lines with 7 levels of nesting and no unit tests. Extract three helpers:

1. `accumulateStreamChunks(stream: AsyncIterable<StreamChunk>, budget: IterationBudget, signal: AbortSignal): Promise<ChunkAccumulation>` — handles chunk buffering, abort, and budget tracking
2. `dispatchToolResults(toolMessages: ToolMessage[], executor: PolicyEnabledToolExecutor): Promise<ToolResult[]>` — handles tool dispatching and error wrapping
3. `handleStreamAbort(runId: string, budget: IterationBudget): void` — handles abort event emission

The outer `executeStreamingToolCall` delegates to all three sequentially. Create test files for each helper:
- `packages/agent/src/__tests__/accumulate-stream-chunks.test.ts`
- `packages/agent/src/__tests__/dispatch-tool-results.test.ts`

**Acceptance:** `executeStreamingToolCall` is ≤100 LOC. Each helper has ≥5 unit tests. All existing run-engine tests pass.

---

## RF-02: Deduplicate `executeWithRecovery` + `executeWithRecoveryStream`
**Finding:** C-04 (Code/P1)
**Agent:** `dzupagent-connectors-dev`

**Target file:** `packages/agent-adapters/src/recovery/adapter-recovery.ts`

Extract a shared inner loop:
```ts
async function executeWithRecoveryCore<T>(
  runFn: (attempt: number, trace: ExecutionTrace) => Promise<T> | AsyncIterable<T>,
  traceStore: ExecutionTraceStore,
  config: RecoveryCoreConfig,
  opts: { streaming: boolean }
): Promise<T> | AsyncIterable<T>
```

Both `executeWithRecovery` (non-streaming) and `executeWithRecoveryStream` (streaming) become thin wrappers that call `executeWithRecoveryCore` with the appropriate `runFn` type.

**Acceptance:** `adapter-recovery.ts` is ≤500 LOC. All recovery tests pass. `wc -l` shows ≥700 line reduction.

---

## RF-03: Unit tests for `policy-enabled-tool-executor.ts`
**Finding:** H-08 (Code/P2)
**Agent:** `dzupagent-test-dev`

**Create:** `packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts`

Write tests covering every decision branch:
1. Policy denies tool → emits `tool:blocked`, returns error ToolMessage
2. Approval required → emits `approval:requested`, returns pending ToolMessage
3. Safety scan failure with `fail-closed` → emits `tool:blocked`
4. Safety scan failure with `fail-open` → executes tool anyway
5. Successful execution → correct ToolMessage returned
6. Checkpoint result shape `{checkpointed, label}` → emits `checkpoint:created`
7. Checkpoint restore shape `{restored, label, reason}` → emits `checkpoint:restored`
8. Tool timeout exceeded → emits `tool:error` with `TIMEOUT` code

Use `vitest` with mocked `PolicyEnabledToolExecutorDeps`.

**Acceptance:** 100% branch coverage on `policy-enabled-tool-executor.ts`. Tests complete in <10s.

---

## RF-04: Canonicalize `ProviderExecutionPort` in `@dzupagent/adapter-types`
**Finding:** A-02 (Architecture/Critical)
**Agent:** `dzupagent-core-dev`

1. In `packages/adapter-types/src/`, create or extend a file with:
   ```ts
   export interface ProviderExecutionPort { ... }
   export type ProviderExecutionResult = ...
   ```
   (copy from `packages/agent/src/orchestration/provider-adapter/provider-execution-port.ts`)
2. In `packages/agent/src/orchestration/provider-adapter/provider-execution-port.ts`, replace the definition with:
   ```ts
   export type { ProviderExecutionPort, ProviderExecutionResult } from '@dzupagent/adapter-types'
   ```
3. In `packages/agent-adapters/src/integration/provider-execution-port.ts:10-13`, change import source to `@dzupagent/adapter-types`
4. Run `yarn typecheck`

**Acceptance:** `packages/agent-adapters` no longer imports these types from `@dzupagent/agent`. Typecheck clean.

---

## RF-05: Extract `hashToolInput` utility + `BaseStuckDetectorConfig`
**Finding:** A-05 (Architecture/High)
**Agent:** `dzupagent-core-dev`

1. Create `packages/core/src/utils/hash.ts`:
   ```ts
   import { createHash } from 'crypto'
   export function hashToolInput(input: unknown): string {
     return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
   }
   ```
2. In `packages/agent-types/src/`, add `BaseStuckDetectorConfig` interface with at least `repeatCallThreshold`, `errorRateThreshold`, `windowSize`
3. In `packages/agent/src/guardrails/stuck-detector.ts`, replace the inline hash implementation with `import { hashToolInput } from '@dzupagent/core/utils/hash'`
4. In `packages/agent-adapters/src/guardrails/adapter-guardrails.ts`, same change
5. Run `yarn test --filter=@dzupagent/agent --filter=@dzupagent/agent-adapters -- stuck`

**Acceptance:** Single `hashToolInput` implementation. Both packages import it. Tests pass.

---

## RF-06: Create `BaseSdkAdapter` abstract class
**Finding:** A-12 (Architecture/Medium)
**Agent:** `dzupagent-connectors-dev`

Create `packages/agent-adapters/src/base/base-sdk-adapter.ts` with abstract class `BaseSdkAdapter implements AgentCLIAdapter`:

Methods to centralize:
- `protected buildStartedEvent(runId, sessionId, providerId): AgentStartedEvent`
- `protected buildCompletedEvent(runId, usage, metadata): AgentCompletedEvent`
- `protected buildFailedEvent(runId, error): AgentFailedEvent`
- `protected initInteractionResolver(config): InteractionResolver`
- `protected createAbortController(): AbortController`
- `protected filterSensitiveEnvVars(env: Record<string, string>): Record<string, string>`

Make `ClaudeAgentAdapter` and `CodexAdapter` extend `BaseSdkAdapter` and remove the duplicated implementations.

**Acceptance:** Each adapter is ~200 LOC smaller. `BaseSdkAdapter` has its own unit tests. All adapter tests pass.

---

## RF-07: Extract shared structured-output utilities to `@dzupagent/core`
**Finding:** A-10 (Architecture/Medium)
**Agent:** `dzupagent-core-dev`

Create `packages/core/src/structured/extract.ts` with:
- `extractJsonFromText(raw: string): unknown | null` — tries code-block extraction then bare JSON
- `extractJsonFromMarkdownBlocks(raw: string): string[]` — returns all fenced code blocks
- `buildZodSchemaHint(schema: z.ZodType): string` — produces a schema description string

Update both:
- `packages/agent/src/structured/structured-output-engine.ts:230` — import shared utilities
- `packages/agent-adapters/src/output/structured-output.ts:361` — import shared utilities

Remove duplicated logic from both files.

**Acceptance:** Single implementation. Both packages import from `@dzupagent/core`. Tests pass.

---

## RF-08: Add tool-output schema validation
**Finding:** AG-01 (Agent/High)
**Agent:** `dzupagent-agent-dev`

1. Create `packages/agent/src/agent/tool-loop/output-validator.ts` exporting:
   ```ts
   export function validateToolOutput(
     toolName: string,
     result: string | unknown,
     outputSchema: JSONSchema | z.ZodType | undefined,
     config: { autoRepair?: boolean }
   ): { valid: boolean; sanitized: string; error?: string }
   ```
2. In `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts`, insert a call between line 215 (raw result) and line 217 (safety scan)
3. On validation failure: emit `tool:error` with `errorCode: 'OUTPUT_VALIDATION_FAILED'` and return a `ToolMessage` explaining the deviation
4. Add `validateToolResults?: boolean | { autoRepair?: boolean }` to `ToolLoopConfig`
5. Add tests in `__tests__/tool-loop-canonical-audit.test.ts`

**Acceptance:** Tool returning wrong-shape output is blocked. Existing tests pass. New tests added.

---

## RF-09: Add per-tool retry with exponential backoff
**Finding:** AG-02 (Agent/Medium)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:194-211`:

1. Create `ToolRetryPolicy` type (re-export `RetryPolicy` from `packages/agent/src/pipeline/retry-policy.ts`)
2. Add `toolRetryPolicies?: Record<string, ToolRetryPolicy>` and `defaultToolRetryPolicy?: ToolRetryPolicy` to `ToolLoopConfig`
3. Wrap the `invokeWithOptionalTimeout` call in a retry loop:
   - Use `calculateBackoff(attempt, policy)` for wait times
   - Use `isRetryable(err.message, policy)` to decide whether to retry
   - Respect `config.signal` between attempts (abort if aborted)
4. Emit `tool:retry` event: `{ toolName, attempt, backoffMs, error }` before each retry
5. Add a test: fake tool that throws `RateLimitError` twice then succeeds — assert exactly 3 invocations

**Acceptance:** Transient tool errors retry. Permanent errors fail immediately. Events emitted correctly.

---

## RF-10: Wire memory decay/consolidation into agent loop
**Finding:** AG-07 (Agent/Medium)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/agent/memory-context-loader.ts`:

1. Add optional `memoryRanker?: (records: MemoryRecord[], query: string) => MemoryRecord[]` to `AgentMemoryContextLoaderConfig`
2. Default it to: `(records, query) => MemoryDecayEngine.scoreMemoriesForRetrieval(records, query)` (import from `@dzupagent/memory`)
3. Apply `memoryRanker` in `loadStandardMemoryContext` and `loadBoundedStandardMemoryContext` BEFORE the token budget bound
4. In `packages/agent/src/agent/agent-finalizers.ts` in `maybeWriteBackMemory`:
   - After writing, check if `memoryService.count(namespace) > config.memoryConsolidationThreshold ?? 200`
   - If over threshold, call `MemoryConsolidator.consolidate({ namespace, scope })` in the background (fire-and-forget with `.catch(logger.error)`)
5. Extend `memory-context-loader.test.ts` with tests asserting ranked ordering

**Acceptance:** Memory records returned in decay-strength order. Consolidation triggered at threshold. Tests pass.

---

## RF-11: Add LLM rate limiting
**Finding:** AG-10 (Agent/Medium)
**Agent:** `dzupagent-agent-dev`

1. Add to `packages/agent-types/src/`:
   ```ts
   export interface RateLimit {
     acquire(estimatedTokens?: number): Promise<void>
     release?(actualTokens?: number): void
   }
   ```
2. Create `packages/core/src/rate-limit/token-bucket.ts` implementing `RateLimit` with RPM + TPM token-bucket algorithm
3. In `packages/agent/src/agent/dzip-agent.ts`, in `invokeModel`:
   - Before middleware pipeline: `await this.config.rateLimit?.acquire(estimateTokens(messages))`
   - After `extractTokenUsage`: `this.config.rateLimit?.release?.(usage?.totalTokens)`
4. Add `rateLimit?: RateLimit | { rpm: number; tpm?: number }` to `DzupAgentConfig`
5. Test: configure `rpm: 2`, make 3 calls, assert wall-clock gap ≥ 30s between calls 2 and 3

**Acceptance:** Rate limit is respected. Multi-agent runs stop hitting 429s unnecessarily.

---

## RF-12: Fix stale cost rate table + cached-token accounting
**Finding:** AG-11 (Agent/Medium)
**Agent:** `dzupagent-agent-dev`

1. Create `packages/core/src/pricing/provider-rates.ts` with:
   ```ts
   export interface ModelRates {
     input: number     // per 1M tokens, USD cents
     output: number
     cachedInput: number
     cacheWrite: number
     validUntil: string  // ISO date
   }
   export const PROVIDER_RATES: Record<string, Record<string, ModelRates>> = { ... }
   ```
   Populate with current 2026 rates for `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`, `gpt-4o`, `gpt-4o-mini`
2. In `packages/agent-adapters/src/middleware/cost-tracking.ts:27-37`:
   - Import from `@dzupagent/core/pricing`
   - Update `estimateCost` to use `cachedInput` rate when `usage.cachedTokens` is present
3. Add a CI test: `yarn test --project=core -- pricing-staleness` that fails if any `validUntil` is more than 90 days in the past

**Acceptance:** Cost estimates use correct per-model rates. Cached tokens get the discount. CI test added.

---

## RF-13: Implement Anthropic prompt caching
**Finding:** AG-12 (Agent/High)
**Agent:** `dzupagent-agent-dev`

Create `packages/context/src/prompt-cache-injector.ts`:

```ts
export function injectPromptCacheMarkers(
  messages: BaseMessage[],
  modelId: string,
  opts?: { minTokensForCache?: number }
): BaseMessage[]
```

Logic:
- If `!modelId.startsWith('claude-')`: return messages unchanged
- Find the system message; split into blocks: `instructions`, `memory`, `tools`, `dynamic`
- For each of the first 3 blocks, if token estimate ≥ `minTokensForCache` (default: 1024 for Sonnet, 2048 for Haiku):
  - Set `additional_kwargs.cache_control = { type: 'ephemeral' }` on that message

Wire into `packages/agent/src/agent/run-engine.ts` in `prepareRunState`, after memory loading, before model invocation.

Update `extractTokenUsage` in `packages/agent-adapters/src/claude/claude-adapter.ts` to extract `cache_creation_input_tokens` and `cache_read_input_tokens` from Anthropic responses.

Add tests:
- Sonnet with 1200-token system prompt → `cache_control` markers present
- GPT-4o → no markers added
- Short system prompt → no markers (below threshold)

**Acceptance:** Anthropic runs use prompt caching. Cache token metrics visible in cost tracking. Tests pass.

---

## RF-14: Semantic plateau detection in stuck detector
**Finding:** AG-14 (Agent/Medium)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/guardrails/stuck-detector.ts`:

1. Add a new `RegressDetector` class tracking the last K `AIMessage.content` values (default K=3)
2. On each `AIMessage`, compute edit-distance (Levenshtein or Jaro-Winkler) between current and previous content
3. If normalized distance < 0.05 for K consecutive turns: mark as stuck with reason `'semantic-plateau'`
4. Add to `StuckDetectorConfig`: `contentSimilarity?: { threshold: number; window: number }`
5. Compose with existing repeat-call and block-hash detectors in `StuckDetector`

**Acceptance:** Agent alternating `editFile({content:'X'})` and `editFile({content:'X '})` is detected as stuck within 5 turns.

---

## RF-15: Add `OutputRefinementLoop` convergence check
**Finding:** M-09 (Code/P3)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/self-correction/output-refinement-loop.ts`:

1. Add `converged?: (prev: string, curr: string) => boolean` to `OutputRefinementConfig`
2. Default: string equality OR (if both >100 chars) normalized edit-distance > 0.98
3. In the loop: after each iteration, call `converged(prev, curr)` — if true, emit `refinement:converged` event and break early
4. Add `{ iterations: number; convergedAt?: number }` to the return type

**Acceptance:** Identical consecutive outputs trigger early exit. Convergence event emitted. Test added.

---

## RF-16: Add `maxConcurrency` guard to `AgentOrchestrator.parallel`
**Finding:** M-07 (Code/P3)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/orchestration/orchestrator.ts` parallel execution path:

1. Add `maxConcurrency?: number` to `ParallelConfig` (default: `Math.min(agents.length, 5)`)
2. Replace `Promise.all(agents.map(...))` with a p-limit style queue that runs at most `maxConcurrency` at a time
3. Test: 20-agent run with `maxConcurrency: 3` — assert at most 3 in-flight at any time (track via counter)

**Acceptance:** Unbounded concurrency eliminated. Existing parallel orchestration tests pass.

---

## RF-17: Add `PipelineExecutorPort` DI for `AdapterWorkflowBuilder`
**Finding:** A-01 (Architecture/Critical)
**Agent:** `dzupagent-agent-dev`

1. In `packages/core/src/`, create a `PipelineExecutorPort` interface:
   ```ts
   export interface PipelineExecutorPort {
     execute(definition: PipelineDefinition, config: PipelineRuntimeConfig): Promise<PipelineRunResult>
   }
   ```
2. In `packages/agent/src/pipeline/`, create `PipelineRuntimePort` (implements `PipelineExecutorPort` by wrapping `new PipelineRuntime(...)`)
3. In `packages/agent-adapters/src/workflow/adapter-workflow.ts`:
   - Add `executorPort?: PipelineExecutorPort` to the constructor/config
   - If not provided, default to `new PipelineRuntimePort()` (lazy import to avoid hard dep)
4. Update `packages/agent-adapters/src/workflow/adapter-workflow.ts:42` to remove the direct `import { PipelineRuntime } from '@dzupagent/agent'`

**Acceptance:** `packages/agent-adapters` does not directly import `PipelineRuntime`. Typecheck passes. Workflow tests pass.
