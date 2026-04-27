# @dzupagent/context Architecture

## Scope
`@dzupagent/context` is the DzupAgent package for context-window management primitives used around long-running LLM conversations.

Current scope in `packages/context` includes:
- Message-history compression and summarization primitives (`message-manager.ts`, `auto-compress.ts`, `progressive-compress.ts`).
- Context-retention policy helpers (`phase-window.ts`, `context-eviction.ts`, `context-transfer.ts`).
- Prompt-cache and reminder helpers (`prompt-cache.ts`, `system-reminder.ts`).
- Token accounting utilities (`token-lifecycle.ts`, `char-estimate-counter.ts`, `tiktoken-counter.ts`).
- Memory integration bridges that do not hard-depend on `@dzupagent/memory` (`extraction-bridge.ts`, `snapshot-builder.ts`).
- Feature-input scoring utility (`completeness-scorer.ts`).

Out of scope for this package:
- Owning model provider clients.
- Persisting memory directly (handled by external memory services).
- Agent orchestration loops and transport concerns (owned by other packages/apps).

## Responsibilities
This package is responsible for:
- Detecting when message history should be compressed (`shouldSummarize`).
- Compressing history while trying to keep tool-call/tool-result structure valid.
- Producing and formatting structured summary context for later turns.
- Offering gradual compression policies (levels 0-4) and budget-oriented entrypoints.
- Providing context transfer between intent boundaries.
- Providing token lifecycle accounting and optional precise token counting.
- Providing Anthropic cache breakpoint marking for both Anthropic-native payloads and LangChain messages.
- Providing a non-fatal frozen snapshot builder from memory-service-like sources.

## Structure
Package layout:
- `src/index.ts`: public export surface.
- `src/message-manager.ts`: core compression primitives.
- `src/auto-compress.ts`: summarize-on-threshold orchestration + hard budget truncation + `FrozenSnapshot` class.
- `src/progressive-compress.ts`: level-based compression and budget-level selection.
- `src/phase-window.ts`: phase detection and retention scoring/split policy.
- `src/context-transfer.ts`: intent-scoped context extraction, relevance matching, and injection.
- `src/context-eviction.ts`: large-content head/tail truncation utility.
- `src/prompt-cache.ts`: Anthropic cache-control helpers and content-addressed breakpoint strategy.
- `src/system-reminder.ts`: interval-based `<system-reminder>` reinjection helper.
- `src/token-lifecycle.ts`: budget model, lifecycle manager, recommendations, token-counter interface.
- `src/char-estimate-counter.ts`: chars/4 heuristic counter.
- `src/tiktoken-counter.ts`: lazy `js-tiktoken` counter with fallback to chars/4.
- `src/extraction-bridge.ts`: pre-summarize extraction hook adapter.
- `src/snapshot-builder.ts`: frozen snapshot construction from `MemoryServiceLike`.
- `src/completeness-scorer.ts`: heuristic spec completeness scoring.
- `src/__tests__/*.test.ts`: unit and integration coverage for the above modules.

Build and packaging:
- ESM package (`"type": "module"`) with `tsup` build to `dist/`.
- Single package export (`.`) from `dist/index.js` + `dist/index.d.ts`.

## Runtime and Control Flow
Primary compression path (`autoCompress`):
1. Evaluate `shouldSummarize(messages, config)` from message count and/or token estimate.
2. If summarization needed, optionally call `onBeforeSummarize` with messages that will be summarized away.
3. If `memoryFrame` is present, run `batchOverlapAnalysis` (`@dzupagent/memory-ipc`) and drop duplicate historical messages while preserving recent messages.
4. Call `summarizeAndTrim(...)`.
5. In `summarizeAndTrim`:
- Prune stale tool outputs (`pruneToolResults`).
- Compute split boundary aligned to tool-call groups (`alignSplitBoundary`).
- Repair orphaned tool-call/result pairs on kept recent window (`repairOrphanedToolPairs`).
- Summarize old window through caller-provided `BaseChatModel` using a fixed structured template.
- On summarization errors: emit `context:compress_failed` if `eventBus` exists, then return fallback trimmed messages and existing/empty summary.
6. If `budget` is configured and output is still over budget, truncate oldest messages until estimated tokens fit, set `fallbackReason: 'truncation'`, and invoke `onFallback`.

Progressive path (`compressToLevel` / `compressToBudget`):
- Level `0`: no compression.
- Level `1`: tool-result pruning + orphan repair.
- Level `2`: level 1 + AI content trimming.
- Level `3`: level 2 + `summarizeAndTrim`.
- Level `4`: keep last N messages, repair pairs, optionally truncate long existing summary.
- `compressToBudget` picks a level heuristically via `selectCompressionLevel` and applies it once.

Context transfer path (`ContextTransferService.transfer`):
1. Check relevance rules for `sourceIntent -> targetIntent`.
2. Extract context from source messages (summary, decision sentences, file paths, optional working state).
3. Compute transfer scope (all/decisions/files/summary) from highest-priority matching rule.
4. Format context as a `SystemMessage`, enforce transfer token budget by truncating text if needed.
5. Inject after first existing system message (or prepend if none).
6. Skip duplicate injection if same transfer marker is already present.

Token lifecycle path:
- `TokenLifecycleManager` tracks per-phase token usage, computes status (`ok | warn | critical | exhausted`), and returns recommendations based on thresholds.

## Key APIs and Types
Public exports are re-exported from `src/index.ts`.

Core compression APIs:
- `shouldSummarize`, `summarizeAndTrim`, `formatSummaryContext`, `pruneToolResults`, `repairOrphanedToolPairs`.
- `MessageManagerConfig`.
- `autoCompress`, `FrozenSnapshot`.
- `AutoCompressConfig`, `CompressResult`.
- `compressToLevel`, `compressToBudget`, `selectCompressionLevel`.
- `CompressionLevel`, `ProgressiveCompressConfig`, `ProgressiveCompressResult`.

Retention and transfer APIs:
- `PhaseAwareWindowManager`, `DEFAULT_PHASES`.
- `ConversationPhase`, `PhaseConfig`, `MessageRetention`, `PhaseDetection`, `PhaseWindowConfig`.
- `ContextTransferService`.
- `IntentContext`, `IntentType`, `ContextTransferConfig`, `IntentRelevanceRule`, `TransferScope`.

Prompt/cache/reminder APIs:
- `applyAnthropicCacheControl`, `applyCacheBreakpoints`.
- `CacheStrategy`, `CacheBreakpointOptions`.
- `SystemReminderInjector`.
- `SystemReminderConfig`, `ReminderContent`.

Token/snapshot/extraction APIs:
- `TokenLifecycleManager`, `createTokenBudget`.
- `TokenBudget`, `TokenPhaseUsage`, `TokenLifecycleConfig`, `TokenLifecycleStatus`, `TokenLifecycleReport`, `TokenCounter`.
- `CharEstimateCounter`, `TiktokenCounter`.
- `buildFrozenSnapshot`.
- `MemoryServiceLike`, `BuildFrozenSnapshotOptions`.
- `createExtractionHook`, `MessageExtractionFn`.

Utility API:
- `scoreCompleteness`.
- `DescriptionInput`, `CompletenessResult`.
- `evictIfNeeded`.
- `EvictionConfig`, `EvictionResult`.

## Dependencies
Runtime dependencies:
- `@dzupagent/memory-ipc`: overlap analysis (`batchOverlapAnalysis`) and memory frame delta checks (`computeFrameDelta`) in `auto-compress.ts`.

Peer dependencies:
- `@langchain/core` (required): message and model types used across all runtime APIs.
- `js-tiktoken` (optional): consumed lazily by `TiktokenCounter`; package degrades to chars/4 when missing.

Dev/build dependencies:
- `tsup`, `typescript`, `vitest`, `apache-arrow` (typing and tests/build tooling).

## Integration Points
Inbound (what callers provide):
- `BaseMessage[]` and `BaseChatModel` (`@langchain/core`).
- Optional token counter implementation through `MessageManagerConfig.tokenCounter`.
- Optional `memoryFrame` object consumed by memory-ipc overlap APIs.
- Optional event bus object (`eventBus.emit(...)`) to observe compression failures.
- Memory service adapter implementing `MemoryServiceLike` for snapshot building.

Outbound (what package returns/emits):
- Compressed message arrays and summary text.
- Optional fallback metadata (`fallbackReason`) and callback telemetry (`onFallback`).
- Injected `SystemMessage` blocks for transfer/reminders/summary context.
- Lifecycle reports for token pressure.
- Optional event bus emission: `context:compress_failed` on summarization failure.

## Testing and Observability
Test setup:
- Vitest (`environment: node`) with coverage thresholds in `vitest.config.ts`:
- statements `60`, branches `50`, functions `50`, lines `60`.
- Coverage excludes test/spec files, `__tests__`, fixtures, and `src/index.ts`.

Current test surface in `src/__tests__` includes:
- Compression core: `message-manager`, `auto-compress`, `progressive-compress`, deep branch suites.
- Policy modules: `phase-window`, `context-transfer`, `context-eviction`, `completeness-scorer` branches via deep/edge suites.
- Integration helpers: `prompt-cache`, `snapshot-builder`, `extraction-bridge`, `token-lifecycle`, `system-reminder`.

Built-in observability hooks:
- `MessageManagerConfig.eventBus` emission (`context:compress_failed`) on summarization failure.
- `onFallback` callback support in `autoCompress` hard-budget truncation path.
- Fallback behavior is intentionally non-fatal in multiple modules (hook errors, overlap-analysis failures, snapshot memory read failures).

## Risks and TODOs
Code-observed risks and follow-ups:
- `AutoCompressConfig.frozenSnapshot` exists as config but is not used inside `autoCompress` logic; currently `FrozenSnapshot` is a separate class consumers must orchestrate themselves.
- `compressToBudget` is heuristic level selection and does not iterate until guaranteed fit; callers requiring hard guarantees should use `autoCompress` with `budget` or add external enforcement.
- `applyCacheBreakpoints` marks every system message plus up to three non-system anchors/messages; multi-system inputs can exceed a strict “max 4 total breakpoints” interpretation.
- Token accounting remains estimation-first by default unless callers explicitly inject `TokenCounter`/`TiktokenCounter`.
- Fallback paths are resilient but mostly callback/event based; central metrics aggregation is caller-owned.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

