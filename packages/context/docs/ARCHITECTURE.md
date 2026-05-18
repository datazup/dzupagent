# @dzupagent/context Architecture

## Scope
`@dzupagent/context` is the Layer-2 context-engineering package in `dzupagent/packages/context`. It provides reusable primitives for:
- message-history compression and summarization,
- token-budget tracking and compression triggers,
- prompt-cache marker injection for Claude-compatible flows,
- context transfer between intent boundaries,
- frozen memory snapshot construction,
- large-content eviction and description completeness scoring.

The package is intentionally model-runtime-adjacent, not model-runtime-owning:
- it consumes `@langchain/core` message/model abstractions,
- it does not own provider transport,
- it does not own memory storage,
- it does not own agent loop orchestration.

## Responsibilities
The current codebase assigns these responsibilities to this package:
- Decide when compression should happen (`shouldSummarize`) from message-count and estimated token thresholds.
- Compress transcripts while preserving tool-call/tool-result structural validity (`pruneToolResults`, `repairOrphanedToolPairs`, safe split alignment, summary generation).
- Run automatic compression orchestration (`autoCompress`) with optional pre-summarize extraction hook, optional memory-frame overlap filtering, and optional hard budget truncation fallback.
- Provide progressive compression levels (`compressToLevel`, `compressToBudget`, `selectCompressionLevel`) from no-op to ultra-compressed modes.
- Inject Anthropic prompt-cache markers with strategy controls and model-awareness (`applyCacheBreakpoints`, `injectPromptCacheMarkers*`).
- Track token lifecycle pressure across phases (`TokenLifecycleManager`) and expose recommendations.
- Build transferable context blocks across intent switches (`ContextTransferService`).
- Build frozen memory snapshots from a memory-service-like interface without direct dependency on `@dzupagent/memory` (`buildFrozenSnapshot`).
- Offer utility surfaces for content eviction, completeness scoring, reminder reinjection, and token counters.

## Structure
Source modules in `src/`:
- `index.ts`: package export surface.
- `message-manager.ts`: core summarize/trim pipeline helpers and summary context formatting.
- `auto-compress.ts`: automatic compression orchestration; includes `FrozenSnapshot` class.
- `progressive-compress.ts`: level-based and budget-based compression APIs.
- `phase-window.ts`: phase detection + message retention scoring/split heuristics.
- `context-transfer.ts`: extract/format/inject context between intents.
- `prompt-cache.ts`: Anthropic cache-control breakpoint placement (`positional` and `content-addressed`).
- `prompt-cache-injector.ts`: model-id-aware cache marker injection guardrails.
- `token-lifecycle.ts`: budget model + usage tracking + status/reporting.
- `char-estimate-counter.ts`: lightweight chars/4 token counter.
- `tiktoken-counter.ts`: optional `js-tiktoken`/Anthropic-tokenizer-backed counter with graceful fallback.
- `system-reminder.ts`: interval-based `<system-reminder>` block injector.
- `context-eviction.ts`: head/tail truncation helper for very large content blocks.
- `snapshot-builder.ts`: memory-service adapter to construct frozen snapshots.
- `extraction-bridge.ts`: adapter to turn extraction functions into pre-summarize hooks.
- `completeness-scorer.ts`: heuristic task-description completeness scoring.

Package/build layout:
- ESM package (`"type": "module"`), single public export path (`.`).
- Build output: `dist/` via `tsup` (`src/index.ts` entry, ESM, d.ts, sourcemaps, Node 20 target).
- Tests: `src/**/*.test.ts`/`src/**/*.spec.ts` under Vitest.

## Runtime and Control Flow
### 1) Core Summarization Path (`message-manager.ts`)
1. `shouldSummarize(messages, config)` checks message count and estimated token usage.
2. `summarizeAndTrim(...)` applies:
- tool-result pruning (`pruneToolResults`),
- split-boundary alignment to avoid breaking tool call/result groups,
- orphaned pair repair on kept recent window,
- structured summary generation through caller-provided `BaseChatModel`.
3. On summarization failure, the module emits `context:compress_failed` through optional `eventBus` and returns a safe trimmed fallback instead of throwing.

### 2) Auto Compression Orchestration (`auto-compress.ts`)
1. Exit fast if `shouldSummarize` is false.
2. Optionally run `onBeforeSummarize(oldMessages)` for extract-before-loss workflows.
3. If `memoryFrame` is provided, call `batchOverlapAnalysis` (`@dzupagent/memory-ipc`) and drop duplicated old messages while preserving recent messages.
4. Delegate to `summarizeAndTrim`.
5. If `budget` is configured and output still exceeds it, drop oldest messages until the budget fits and return `fallbackReason: 'truncation'` (also invoking `onFallback`).

`FrozenSnapshot` runtime behavior:
- Holds frozen context text and optional frame.
- Can compare frozen vs new frame via `computeFrameDelta` to decide invalidation.
- Is used by upstream consumers; `AutoCompressConfig.frozenSnapshot` itself is currently only a declared option and not consumed inside `autoCompress` logic.

### 3) Progressive Compression (`progressive-compress.ts`)
Compression levels:
- `0`: no compression.
- `1`: prune tool results + repair orphaned pairs.
- `2`: level 1 + trim verbose AI messages.
- `3`: level 2 + structured summarization (`summarizeAndTrim`).
- `4`: keep only latest N messages + summary truncation safeguards.

`compressToBudget(...)` flow:
1. Choose initial level via `selectCompressionLevel`.
2. Run compression and verify estimated tokens.
3. Escalate to stronger levels if still above budget.
4. If still over budget at level 4, perform hard trimming (`hardTrimToBudget`) with tool-pair repair.

### 4) Prompt Cache Path
- `applyCacheBreakpoints` enforces Anthropic’s effective four-breakpoint cap by reserving one marker for the last system message and up to three for non-system anchors.
- Content-addressed mode prefers explicit `additional_kwargs.cacheAnchor === true` and large messages (`>= 2000` chars), then falls back to positional marking when no stable anchors exist.
- `injectPromptCacheMarkers` / `injectPromptCacheMarkersForModel` apply markers only for Claude-compatible model IDs and only when estimated prompt size passes a minimum threshold (default 1024 tokens).

### 5) Context Transfer Path (`context-transfer.ts`)
1. Extract summary/decisions/file paths/optional working state from source intent messages.
2. Determine relevance and transfer scope from configured rules (highest-priority match wins).
3. Format as a `SystemMessage`, enforce max transfer budget by truncation if needed.
4. Inject after first system message (or prepend if none).
5. Idempotency guard skips injection when matching transfer marker already exists.

### 6) Token Lifecycle Path (`token-lifecycle.ts`)
- `TokenLifecycleManager` tracks phase token usage, computes pressure status (`ok`, `warn`, `critical`, `exhausted`), and returns a report with recommendations.
- State is in-memory and resettable (`reset()`), designed for per-run/per-conversation wiring.

## Key APIs and Types
Public exports are defined in `src/index.ts`.

Compression and summarization:
- `shouldSummarize`, `summarizeAndTrim`, `formatSummaryContext`
- `pruneToolResults`, `repairOrphanedToolPairs`
- `autoCompress`, `FrozenSnapshot`
- `compressToLevel`, `compressToBudget`, `selectCompressionLevel`
- Types: `MessageManagerConfig`, `AutoCompressConfig`, `CompressResult`, `AutoCompressTokenizer`, `CompressionLevel`, `ProgressiveCompressConfig`, `ProgressiveCompressResult`

Prompt cache:
- `applyAnthropicCacheControl`, `applyCacheBreakpoints`
- `injectPromptCacheMarkers`, `injectPromptCacheMarkersForModel`, `isClaudeId`, `resolveModelId`
- Types: `CacheStrategy`, `CacheBreakpointOptions`

Context transfer and phase retention:
- `ContextTransferService`
- `PhaseAwareWindowManager`, `DEFAULT_PHASES`
- Types: `IntentContext`, `IntentType`, `ContextTransferConfig`, `IntentRelevanceRule`, `TransferScope`, `ConversationPhase`, `PhaseConfig`, `MessageRetention`, `PhaseDetection`, `PhaseWindowConfig`

Token lifecycle and counters:
- `TokenLifecycleManager`, `createTokenBudget`
- `CharEstimateCounter`, `TiktokenCounter`
- Types: `TokenBudget`, `TokenPhaseUsage`, `TokenLifecycleConfig`, `TokenLifecycleStatus`, `TokenLifecycleReport`, `TokenCounter`

Snapshot/extraction/utilities:
- `buildFrozenSnapshot`, `createExtractionHook`, `scoreCompleteness`, `evictIfNeeded`, `SystemReminderInjector`
- Types: `MemoryServiceLike`, `BuildFrozenSnapshotOptions`, `MessageExtractionFn`, `DescriptionInput`, `CompletenessResult`, `EvictionConfig`, `EvictionResult`, `SystemReminderConfig`, `ReminderContent`

## Dependencies
Direct runtime dependency:
- `@dzupagent/memory-ipc`: used by `autoCompress` (`batchOverlapAnalysis`, `computeFrameDelta`).

Peer dependencies:
- `@langchain/core` (required): message/model abstractions across all primary APIs.
- `js-tiktoken` (optional): used lazily by `TiktokenCounter`.
- `@anthropic-ai/tokenizer` (optional): used lazily by `TiktokenCounter` for Claude-specific counting path.

Build/test dependencies relevant to this package:
- `typescript`, `tsup`, `vitest`, `apache-arrow`.

## Integration Points
Internal monorepo integration (observed current usage):
- `packages/agent` imports and uses:
- compression APIs (`shouldSummarize`, `summarizeAndTrim`, `autoCompress`),
- prompt-cache marker injection (`injectPromptCacheMarkers*`) in run-engine message preparation,
- snapshot builder (`buildFrozenSnapshot`) in agent factory bootstrap,
- token lifecycle types/managers in lifecycle wiring.
- `packages/server` uses `TokenLifecycleManager`/`createTokenBudget` for per-run lifecycle reporting.

Contract boundaries:
- Does not import `@dzupagent/core` runtime internals; accepts LangChain and structural interfaces.
- `snapshot-builder` depends on a structural `MemoryServiceLike` interface instead of concrete memory package types.
- `auto-compress` accepts opaque `memoryFrame` and only interprets it through `@dzupagent/memory-ipc` calls.

Consumer extension hooks:
- `onBeforeSummarize` to extract knowledge before old messages are compressed away.
- `onFallback` for hard-truncation telemetry.
- `eventBus.emit` for summarization failure events.
- Custom token counters via `MessageManagerConfig.tokenCounter`.

## Testing and Observability
Testing:
- Test runner: Vitest (`environment: node`, `testTimeout: 30_000`).
- Coverage provider: V8, reporters `text` + `json-summary`.
- Coverage thresholds:
- statements `60`, branches `50`, functions `50`, lines `60`.
- Test scope includes extensive suites under `src/__tests__/` for:
- message compression and edge cases,
- progressive/budget compression behavior,
- prompt cache and model-aware injection,
- context transfer edge paths,
- snapshot builder,
- token lifecycle,
- counters and reminder logic.

Observability and failure behavior:
- Non-fatal error handling is a consistent pattern in compression/snapshot flows.
- `message-manager` emits `context:compress_failed` through optional event bus on summarize failure.
- `autoCompress` exposes `onFallback` callback and returns `fallbackReason` when hard truncation occurs.
- Multiple modules intentionally degrade gracefully (hook failures, overlap analysis failures, missing optional tokenization packages).

## Risks and TODOs
Codebase-grounded risks and follow-ups:
- `AutoCompressConfig.frozenSnapshot` is currently a declared config field but is not consumed by `autoCompress`; snapshot behavior is currently driven by explicit `FrozenSnapshot` usage in callers.
- Token estimation remains heuristic in many paths unless callers wire precise counters/tokenizers (`TokenCounter`, `AutoCompressTokenizer`, or `TiktokenCounter`).
- `ContextTransferService` may include raw `workingState` content when scope is `all`; callers should ensure sensitive state redaction before transfer in security-sensitive deployments.
- `README.md` auto-generated metrics are stale versus current test inventory (README reports fewer test files than currently present in `src/__tests__`).

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

