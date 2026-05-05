# Major Changes (P3 — 16h+ each)

---

## MC-01: Implement Claude Prompt Caching [C-01, AGENT-020, AGENT-050]
**Target agent:** dzupagent-connectors-dev + dzupagent-agent-dev
**Effort:** ~16h

### Context
The Claude adapter (`packages/agent-adapters/src/claude/claude-adapter.ts:632-693`) never sets `cache_control` markers. Prompt caching can reduce costs by 50-90% for long-running agents with stable system prompts and tool definitions.

### Steps
1. **Extend config** — add `promptCache: 'auto' | 'manual' | 'off'` to `AdapterConfig` (default `'auto'`)
2. **System prompt segmentation** — in `packages/agent-adapters/src/prompts/system-prompt-builder.ts`, mark the stable system prompt segment with `cache_control: { type: 'ephemeral' }` when `promptCache !== 'off'`
3. **Tool definitions caching** — when building `queryOptions.tools`, mark the tool definitions array with a cache breakpoint after the last tool definition
4. **Memory frame caching** — when `config.memory.frozenSnapshot` is enabled, mark the frozen snapshot messages with a cache breakpoint
5. **Cost tracking** — wire `cache_creation_input_tokens` and `cache_read_input_tokens` from the SDK response into the `CostReport` middleware
6. **Test coverage** — integration test mocking the Anthropic SDK confirms: cache markers present in query options; cost tracking records both cache token types; `'off'` mode produces no markers

### Acceptance Criteria
- Integration test green
- Cost tracking middleware records cache token counts
- `promptCache: 'off'` produces no `cache_control` markers
- No change to adapter public API surface

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run claude-adapter`

---

## MC-02: Implement Memory Consolidation Engine [AGENT-010, AGENT-011, AGENT-013]
**Target agent:** dzupagent-core-dev
**Effort:** ~24h

### Context
- `consolidateOnComplete` in `team-runtime.ts:368-371` throws "not supported" 
- Memory grows unbounded — no periodic pruning loop
- PII detection does not cover tool-result-to-memory path
- Memory consolidation is a critical feature for long-running agents

### Architecture
```
packages/memory/src/consolidation-engine.ts
packages/memory/src/memory-pruner.ts
packages/agent/src/agent/agent-finalizers.ts  (update)
packages/agent/src/orchestration/team/team-runtime.ts  (update)
```

### Steps
1. **`ConsolidationEngine`** — class with:
   - `consolidate(scope: string, namespace: string, store: MemoryStore): Promise<ConsolidationResult>`
   - Clusters similar entries by semantic similarity (use embedding or LLM judge)
   - Summarises each cluster via LLM call → single summary entry
   - Marks child entries as `consolidated` with decay accelerated (strength 0.1)
   - Returns provenance map (summary → children)

2. **`MemoryPruner`** — class with:
   - `prune(store: MemoryStore, options: PruneOptions): Promise<PruneResult>`
   - Hard ceiling enforcement (LRU-by-strength eviction above ceiling)
   - TTL-based expiry
   - Configurable thresholds per agent via `DzupAgentConfig.memory.maxEntries`

3. **Wire consolidation triggers**:
   - On `team:run_complete` event → call `engine.consolidate(teamId, namespace)`
   - On agent finalize → run pruner if `memory.pruneFinalizer !== false`
   - Expose `agent.consolidate()` public method for manual trigger

4. **PII scan on tool-result-to-memory path** in `agent-finalizers.ts:140-144` — scan tool results before they enter memory via consolidation hooks (extend the existing `pii: 'block'|'redact'` configuration to cover this path)

### Acceptance Criteria
- Long-running integration test (24-hour soak simulation) stays within configured ceiling
- Consolidation produces semantically coherent summaries
- PII scan verified on tool-result path
- `consolidateOnComplete: true` team policy invokes engine

**Validate:** `yarn workspace @dzupagent/memory test && yarn workspace @dzupagent/agent test`

---

## MC-03: Refactor `TeamRuntime` into `TeamCoordinationStrategy` hierarchy [ARCH-005, CODE-011]
**Target agent:** dzupagent-agent-dev
**Effort:** ~12h

### Context
`packages/agent/src/orchestration/team/team-runtime.ts` is 1,281 LOC implementing 5 coordination patterns in one class, with its own circuit-breaker state that duplicates `orchestration/circuit-breaker.ts`.

### Steps
1. **Define `TeamPattern` interface in `packages/agent-types/src/orchestration-contracts.ts`**:
   ```typescript
   export interface TeamPatternContext {
     task: string; runId: string; participants: TeamParticipant[]
     checkpointStore?: CheckpointStore; workspace?: TeamWorkspace
     circuitBreaker: CircuitBreaker; otelSpan: Span
   }
   export interface TeamPattern {
     readonly id: CoordinatorPattern
     execute(ctx: TeamPatternContext): Promise<TeamPatternResult>
     resume?(ctx: TeamPatternContext, checkpoint: TeamCheckpoint): Promise<TeamPatternResult>
   }
   ```

2. **Extract 5 concrete strategies** to `orchestration/team/patterns/`:
   - `supervisor-pattern.ts` (~120 LOC)
   - `contract-net-pattern.ts` (~150 LOC)
   - `blackboard-pattern.ts` (~100 LOC)
   - `peer-to-peer-pattern.ts` (~90 LOC)
   - `council-pattern.ts` (~80 LOC)

3. **Refactor `TeamRuntime`** to become a ~200 LOC dispatcher:
   - Owns: lifecycle events, OTel span, policy validation, pattern lookup, shared state
   - Reuses `orchestration/circuit-breaker.ts` instead of inline circuit-breaker state
   - Delegates `execute`/`resume` to the selected pattern

### Acceptance Criteria
- All existing `team-runtime.test.ts` tests pass
- Each pattern has ≥3 unit tests
- `TeamRuntime` ≤250 LOC; each pattern ≤200 LOC
- `orchestration/circuit-breaker.ts` is used (no inline `Map<string, AgentBreakerState>`)

**Validate:** `yarn workspace @dzupagent/agent test`

---

## MC-04: Extract `AdapterStreamRunner` — eliminate per-adapter stream boilerplate [ARCH-010]
**Target agent:** dzupagent-connectors-dev
**Effort:** ~16h

### Context
All 9 adapters re-implement: `AbortController` plumbing, 15-second heartbeat detection, raw-event passthrough, lifecycle event emission, usage extraction, error classification. This is the single highest-value abstraction opportunity in `agent-adapters`.

### Interface
```typescript
// packages/agent-adapters/src/base/stream-runner.ts

export interface AdapterStreamSource<TRaw> {
  readonly providerId: AdapterProviderId
  open(input: AgentInput, signal: AbortSignal): AsyncIterable<TRaw>
  mapRawEvent(raw: TRaw): AgentEvent | null
  extractUsage?(raw: TRaw): TokenUsage | undefined
  detectThreadStart?(raw: TRaw): { threadId: string; sessionId?: string } | null
  detectHeartbeat?(raw: TRaw): boolean
}

export class AdapterStreamRunner<TRaw> {
  constructor(private readonly config: AdapterStreamRunnerConfig) {}
  async *run(
    source: AdapterStreamSource<TRaw>,
    input: AgentInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>
}
```

### The runner owns
- `AbortController` + multi-signal combine
- 15-second gap heartbeat detection (configurable)
- Raw-event passthrough as `adapter:provider_raw`
- `adapter:started` emission on thread-start detection
- `adapter:completed`/`adapter:failed` lifecycle events
- Usage capture and `CostReport` update
- Error classification → structured `adapter:failed`

### Refactor priority order
1. `claude/claude-adapter.ts` — reference implementation
2. `codex/codex-adapter.ts` — most complex, validates the interface
3. `openai/openai-adapter.ts`, `openrouter/openrouter-adapter.ts` — share SSE source
4. `gemini/gemini-cli-adapter.ts`, `gemini/gemini-sdk-adapter.ts`
5. `qwen/qwen-adapter.ts`, `goose/goose-adapter.ts`, `crush/crush-adapter.ts`

### Acceptance Criteria
- All adapter tests pass unchanged
- `ClaudeAdapter` ≤400 LOC; `CodexAdapter` ≤400 LOC
- Each adapter is a simple `AdapterStreamSource<TRaw>` impl + config building ≤300 LOC
- New adapters can be added in <100 LOC

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## MC-05: Decompose `AdapterRegistry` into CRUD + Health + Router [ARCH-011]
**Target agent:** dzupagent-connectors-dev
**Effort:** ~10h

### Context
`packages/agent-adapters/src/registry/adapter-registry.ts` (750 LOC, 22+ public methods) blends three subsystems.

### Split
```
registry/
  registry.ts           — pure CRUD: register, get, enable, disable, list
  health-monitor.ts     — recordSuccess, recordFailure, getHealthStatus, getDetailedHealth
                          (imports circuit-breaker from core, replaces inline logic)
  router.ts             — getForTask, setRouter, routing strategy ownership
  adapter-registry.ts   — keeps ProviderAdapterRegistry as back-compat façade,
                          delegates to the three above
```

### Acceptance Criteria
- `ProviderAdapterRegistry` public API unchanged (all tests pass)
- Each sub-module ≤250 LOC
- Health monitor reuses `@dzupagent/core` circuit breaker

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## MC-06: Promote `WorkflowGraphBuilder` to shared DSL [ARCH-007]
**Target agent:** dzupagent-architect
**Effort:** ~20h

### Context
`packages/agent/src/workflow/workflow-builder.ts` (954 LOC) and `packages/agent-adapters/src/workflow/adapter-workflow.ts` (1128 LOC) both implement the same `step`/`parallel`/`branch`/`loop`/`transform`/`build()` DSL.

### Steps
1. **Write ADR-0009** ratifying the new `@dzupagent/workflow-dsl` package (or `agent-types/workflow-dsl/` submodule)
2. **Extract shared base** into the new package:
   - `step`, `parallel`, `branch`, `loop`, `transform`, `build()` → `PipelineDefinition`
   - Shared helpers: `resolveTemplate`, `mergeParallelResults`, retry policy defaults
3. **`WorkflowBuilder` (in `agent`)** extends base with:
   - `withJournal(store)`, `withStore(store)`, `withCheckpointStore(store)`, `getHandle()`
4. **`AdapterWorkflowBuilder` (in `agent-adapters`)** extends base with:
   - `provider(id, config)` step routing
   - `PipelineExecutorFactory` injection
5. **Migrate all consumers**

### Acceptance Criteria
- ADR-0009 committed
- `@dzupagent/workflow-dsl` package passes `typecheck`
- Both `WorkflowBuilder` and `AdapterWorkflowBuilder` extend the shared base
- All existing tests pass

---

## MC-07: Implement Distributed Budget + Rate Limiter via Redis [AGENT-033/H-21]
**Target agent:** dzupagent-core-dev
**Effort:** ~20h

### Context
`dzip-agent.ts:719-733` uses an in-process `TokenBucket` and `rateLimiter`. Multi-instance deployments can independently exhaust the budget, allowing 10x the configured cost ceiling across a fleet.

### Implementation
1. **`DistributedRateLimiter`** in `packages/agent/src/guardrails/distributed-rate-limiter.ts`:
   - Redis-backed sliding-window token bucket using `IORedis`
   - Key: `${tenantId}:${agentId}:ratelimit`
   - Pessimistic increment (`INCR` + `EXPIREAT`)
   - Graceful degradation to local limiter when Redis is unavailable
   
2. **`DistributedCostLedger`** in `packages/agent/src/guardrails/distributed-budget.ts`:
   - Redis-backed cost accumulator
   - Atomic compare-and-increment with ceiling check
   
3. **Wire via `DzupAgentConfig.guardrails.distributed`**:
   ```typescript
   distributed?: {
     redisClient: IORedis
     rateLimitKey?: string  // default: tenantId:agentId
     costLedgerKey?: string
   }
   ```
   When configured, `DzupAgent` uses distributed limiter/ledger instead of in-process.

### Acceptance Criteria
- Unit tests with mock Redis client covering: normal token deduction, ceiling hit, Redis unavailability → graceful fallback, concurrent increment races
- Multi-instance integration test (3 Node.js processes sharing test Redis) confirms global budget enforcement
- Documented p99 latency impact <5ms with local Redis

**Validate:** `yarn workspace @dzupagent/agent test`

---

## MC-08: Implement Real Tokenizer Integration [AGENT-021/H-22]
**Target agent:** dzupagent-core-dev
**Effort:** ~16h

### Context
`dzip-agent.ts:626-628` uses `estimateTokens` (heuristic char/4). Compression triggers and budget warnings fire at imprecise thresholds.

### Implementation
1. **`Tokenizer` interface** in `packages/core/src/llm/tokenizer.ts`:
   ```typescript
   export interface Tokenizer {
     model: string
     encode(text: string): number[]
     countTokens(text: string): number
     countMessages(messages: ChatMessage[]): number
   }
   ```

2. **Implementations**:
   - `AnthropicTokenizer` using `@anthropic-ai/tokenizer` (lazy-loaded)
   - `TiktokenTokenizer` using `js-tiktoken` for OpenAI/Codex (lazy-loaded, browser-safe)
   - `HeuristicTokenizer` — current char/4 logic as fallback

3. **`ModelRegistry` integration** — register tokenizer per model name pattern; `resolveTokenizer(modelId)` returns the appropriate implementation

4. **Wire into consumers**:
   - `packages/agent/src/context/auto-compress.ts`
   - `packages/agent/src/agent/dzip-agent.ts:626-628`
   - `packages/agent/src/guardrails/iteration-budget.ts` (token threshold checks)

### Acceptance Criteria
- Within ±2% of provider-reported usage on a 50-example recorded fixture set
- `HeuristicTokenizer` retained as fallback when no tokenizer registered
- Browser-safe (no Node.js native bindings in `TiktokenTokenizer`)

---

## MC-09: Unified `DzupEvent` extension typing [CODE-001, CODE-002, AGENT-001 long-term fix]
**Target agent:** dzupagent-core-dev
**Effort:** ~20h

### Context
There are 15+ `as never` event casts across `agent` and `agent-adapters` because the `DzupEvent` discriminated union requires modification for every new event type. Downstream packages cannot add events without modifying core.

### Architecture
Replace the flat `DzupEvent` union with a brand-pattern extensible bus:

```typescript
// packages/core/src/events/
export type DzupCoreEvent = 
  | { type: 'agent:started'; ... }
  | { type: 'agent:completed'; ... }
  // ... all existing events ...

export type DzupEvent = DzupCoreEvent  // initially

// Helper for downstream packages to declare their own events:
export function defineEvent<T extends string, P extends object>(
  type: T
): EventDefinition<{ type: T } & P>

// DzupEventBus becomes generic:
export interface DzupEventBus<TEvent extends { type: string } = DzupEvent> {
  emit(event: TEvent): void
  on<T extends TEvent['type']>(type: T, handler: (event: DzupEventOf<TEvent, T>) => void): () => void
}
```

Packages (`agent`, `agent-adapters`) declare their own event extensions:
```typescript
// packages/agent/src/events/agent-events.ts
export type AgentExtEvent = 
  | { type: 'agent:rate_limited'; agentId: string; reason: string }
  | { type: 'tool:retry'; toolName: string; attempt: number; ... }
  | { type: 'approval:webhook_failed'; ... }
  // ...
```

`DzupAgent` uses `DzupEventBus<DzupEvent | AgentExtEvent>`.

### Acceptance Criteria
- Zero `as never` / `as Parameters` casts in all of `packages/agent/src` and `packages/agent-adapters/src`
- New boundary test enforces zero event-type assertion casts
- All existing event subscriptions continue to work
- New packages can declare events without modifying `@dzupagent/core`

---

## MC-10: Resolve `playground/` — migrate or remove [ARCH-015]
**Target agent:** dzupagent-agent-dev
**Effort:** ~8h

### Context
`packages/agent/src/playground/` is 1,556 LOC (marked as moved to `apps/codev-app` in CLAUDE.md). The `./playground/ui` export is bricked (`null`) but `./playground` still resolves.

### Steps
1. **Audit consumers**: find all imports of `@dzupagent/agent/playground` or `@dzupagent/agent` playground symbols across the workspace
2. **Extract useful symbols**: `SharedWorkspace`, `TeamSpawnedAgent`, any still-needed interfaces → move to `orchestration/team/` proper
3. **Migrate app-level code**: `playground.ts`, `team-coordinator.ts`, `ui/` → move to `apps/codev-app/` if Codev still depends on them
4. **Drop subpath export**: remove `./playground` from `package.json` exports
5. **Delete source files**: `packages/agent/src/playground/` should be empty after migration

### Acceptance Criteria
- `packages/agent/src/playground/` directory deleted
- `./playground` subpath export removed from `package.json`
- All consumers updated and building

**Validate:** `yarn verify`
