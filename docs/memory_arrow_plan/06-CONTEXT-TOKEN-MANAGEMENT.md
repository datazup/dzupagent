# 06 -- Context and Token Management with Arrow

> **Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/memory-ipc`, `@dzipagent/context`
> **Depends on:** 02-MEMORYFRAME-SCHEMA.md (MemoryFrame schema), 03-IPC-PACKAGE.md (FrameBuilder/FrameReader)
> **Integrates with:** `@dzipagent/context` (auto-compress, progressive-compress, phase-window, context-transfer, prompt-cache)

---

## Overview

DzipAgent's context management stack -- `autoCompress`, `ProgressiveCompress`, `PhaseAwareWindowManager`, `ContextTransferService`, `FrozenSnapshot`/`FrozenMemorySnapshot`, and the prompt cache utilities -- currently operates on `BaseMessage[]` arrays and `Record<string, unknown>[]` memory records. Token estimation is per-record (`text.length / charsPerToken`), and there is no facility for bulk analysis of which memories are worth their token cost relative to the full context budget.

Arrow integration introduces columnar token analysis, budget-aware memory selection, and efficient delta detection for prompt cache stability. The key insight is that token budget management is a **multi-dimensional knapsack problem** across four budget partitions (system prompt, memory context, conversation, tools), and Arrow's columnar layout makes the scoring and selection computable in a single vectorized pass.

---

## 1. Token Budget Analysis with Arrow

### 1.1 Problem

The current token estimation in `ProgressiveCompress` and `PhaseAwareWindowManager`:

```typescript
// progressive-compress.ts, line 78-83
function estimateTokens(messages: BaseMessage[], charsPerToken: number): number {
  let totalChars = 0
  for (const m of messages) {
    totalChars += getContent(m).length
  }
  return Math.ceil(totalChars / charsPerToken)
}
```

This works for messages but there is no equivalent for memory records. When `MemoryService.formatForPrompt()` renders memories into the system prompt, the token cost is unknown until after rendering. There is no way to ask: "given a 4,000-token memory budget, which subset of 200 candidate memories maximizes information value?"

### 1.2 Solution: `batchTokenEstimate()`

Operate on the `text` column of a MemoryFrame Arrow Table to compute token costs for the entire memory set in one pass.

```typescript
// @dzipagent/memory-ipc/src/token-budget.ts

import { Table, Utf8, Float64, Int32 } from 'apache-arrow'

/**
 * Estimate token counts for all records in a MemoryFrame Table.
 *
 * Reads the 'text' column (plus 'payload_json' if includePayload is true),
 * computes character length, and divides by charsPerToken.
 *
 * Returns an Int32Array aligned with the table rows -- index i holds
 * the estimated token count for row i.
 *
 * @param table       MemoryFrame Arrow Table
 * @param options     Configuration for token estimation
 * @returns           Int32Array of per-row token estimates
 *
 * @example
 * ```ts
 * const frame = await memoryService.exportFrame('lessons', scope)
 * const tokens = batchTokenEstimate(frame, { charsPerToken: 4 })
 * const totalTokens = tokens.reduce((a, b) => a + b, 0)
 * console.log(`Total memory token cost: ${totalTokens}`)
 * ```
 */
export function batchTokenEstimate(
  table: Table,
  options?: {
    /** Characters per token (default: 4) */
    charsPerToken?: number
    /** Include payload_json in the estimate (default: false) */
    includePayload?: boolean
    /** Per-record overhead for formatting (newlines, headers) in tokens (default: 5) */
    formattingOverhead?: number
  },
): Int32Array {
  const charsPerToken = options?.charsPerToken ?? 4
  const includePayload = options?.includePayload ?? false
  const overhead = options?.formattingOverhead ?? 5

  const numRows = table.numRows
  const result = new Int32Array(numRows)

  const textColumn = table.getChild('text')
  const payloadColumn = includePayload ? table.getChild('payload_json') : null

  for (let i = 0; i < numRows; i++) {
    let charCount = 0

    const text = textColumn?.get(i)
    if (text !== null && text !== undefined) {
      charCount += (text as string).length
    }

    if (payloadColumn) {
      const payload = payloadColumn.get(i)
      if (payload !== null && payload !== undefined) {
        charCount += (payload as string).length
      }
    }

    result[i] = Math.ceil(charCount / charsPerToken) + overhead
  }

  return result
}
```

### 1.3 Solution: `selectByTokenBudget()`

Greedy knapsack selection: sort records by a composite score (importance x decay x recency), then select highest-scoring records until the token budget is exhausted.

```typescript
/**
 * Composite score for a memory record.
 * Used to rank records for budget-constrained selection.
 *
 * Formula: importance * decayStrength * recencyBoost * phaseWeight
 *
 * Where:
 *   importance  = 'importance' column (0-1), default 0.5 if null
 *   decayStrength = 'decay_strength' column (0-1), default 1.0 if null
 *   recencyBoost  = 1 / log2(2 + hoursSinceCreation), normalized to [0.1, 1.0]
 *   phaseWeight   = optional per-namespace weight from phase config
 */
export interface CompositeScoreWeights {
  importance: number   // default: 0.3
  decay: number        // default: 0.3
  recency: number      // default: 0.2
  phase: number        // default: 0.2
}

/**
 * Per-record composite score result.
 */
export interface ScoredRecord {
  /** Row index in the source Table */
  rowIndex: number
  /** Composite score (higher = more valuable) */
  score: number
  /** Estimated token cost for this record */
  tokenCost: number
}

/**
 * Select records from a MemoryFrame that fit within a token budget,
 * maximizing total composite score.
 *
 * Algorithm:
 * 1. Compute composite score for each row using Arrow columns
 * 2. Compute token cost for each row via batchTokenEstimate()
 * 3. Sort by score/tokenCost ratio (value density) descending
 * 4. Greedily select records until budget is exhausted
 *
 * Returns an array of row indices into the original Table, in
 * score-descending order. The caller uses these indices to build
 * the prompt context.
 *
 * @param table       MemoryFrame Arrow Table
 * @param tokenBudget Maximum tokens to allocate to memory context
 * @param options     Scoring weights, phase config, time reference
 * @returns           Selected row indices and their scores
 *
 * @example
 * ```ts
 * const frame = await memoryService.exportFrame('lessons', scope)
 * const selected = selectByTokenBudget(frame, 4000, {
 *   phaseWeights: { lessons: 1.5, decisions: 1.0 },
 *   now: Date.now(),
 * })
 *
 * // Build prompt from selected records
 * const reader = new FrameReader(frame)
 * const records = selected.map(s => reader.getRecord(s.rowIndex))
 * const prompt = memoryService.formatForPrompt(records)
 * ```
 */
export function selectByTokenBudget(
  table: Table,
  tokenBudget: number,
  options?: {
    /** Composite score weights (default: balanced) */
    weights?: Partial<CompositeScoreWeights>
    /** Per-namespace phase weight multiplier */
    phaseWeights?: Record<string, number>
    /** Current timestamp for recency calculation (default: Date.now()) */
    now?: number
    /** Chars per token for estimation (default: 4) */
    charsPerToken?: number
    /** Minimum score threshold -- records below this are never selected (default: 0.05) */
    minScore?: number
  },
): ScoredRecord[] {
  // implementation outlined in algorithm above
}
```

### 1.4 Token Budget Breakdown

The full context window is partitioned into four zones. Arrow enables real-time rebalancing as conversation grows.

```
Total Context Window (e.g., 200,000 tokens)
  |
  +-- System Prompt (fixed, ~2,000 tokens)
  |     Includes: agent persona, tool descriptions, instructions
  |
  +-- Memory Context (variable, dynamically budgeted)
  |     Includes: decisions, lessons, conventions, observations
  |     Budget: min(maxMemoryTokens, remaining - conversationReserve)
  |
  +-- Conversation History (variable, grows over time)
  |     Includes: human/AI/tool messages
  |     Managed by: autoCompress, progressiveCompress, phaseWindow
  |
  +-- Tool Definitions (fixed per invocation, ~500-2,000 tokens)
        Includes: tool schemas, MCP tool descriptions
```

```typescript
/**
 * Real-time token budget allocator.
 *
 * As conversation grows, memory budget shrinks. Arrow enables instant
 * recalculation of which memories to include without re-querying the store.
 *
 * @example
 * ```ts
 * const allocator = new TokenBudgetAllocator({
 *   totalBudget: 200_000,
 *   systemPromptTokens: 2_000,
 *   toolTokens: 1_500,
 *   memoryFrame: await memoryService.exportFrame('lessons', scope),
 * })
 *
 * // After each agent turn, rebalance
 * const budget = allocator.rebalance(conversationTokens)
 * // budget.memoryTokens might shrink from 10,000 to 6,000
 * // budget.selectedMemories gives the new optimal subset
 * ```
 */
export interface TokenBudgetAllocation {
  /** Tokens allocated to memory context */
  memoryTokens: number
  /** Tokens consumed by conversation so far */
  conversationTokens: number
  /** Tokens reserved for system prompt */
  systemPromptTokens: number
  /** Tokens reserved for tool definitions */
  toolTokens: number
  /** Remaining tokens available for agent response */
  responseReserve: number
  /** Row indices of selected memories */
  selectedMemoryIndices: number[]
  /** Total composite score of selected memories */
  totalScore: number
}

export interface TokenBudgetAllocatorConfig {
  /** Total context window size in tokens */
  totalBudget: number
  /** Fixed system prompt token count */
  systemPromptTokens: number
  /** Fixed tool definition token count */
  toolTokens: number
  /** MemoryFrame Arrow Table for budget analysis */
  memoryFrame: Table
  /** Maximum fraction of remaining budget for memory (default: 0.3) */
  maxMemoryFraction?: number
  /** Minimum tokens to reserve for agent response (default: 4,000) */
  minResponseReserve?: number
  /** Phase-aware namespace weights */
  phaseWeights?: Record<string, number>
}

export class TokenBudgetAllocator {
  private readonly config: Required<TokenBudgetAllocatorConfig>
  private readonly tokenEstimates: Int32Array

  constructor(config: TokenBudgetAllocatorConfig)

  /**
   * Rebalance the token budget given current conversation size.
   *
   * This is cheap to call repeatedly -- Arrow column scans are sub-millisecond
   * and the knapsack selection runs on pre-computed scores.
   */
  rebalance(conversationTokens: number): TokenBudgetAllocation

  /**
   * Update the memory frame (e.g., after new memories are written mid-session).
   * Recomputes token estimates and scores.
   */
  updateFrame(newFrame: Table): void
}
```

### 1.5 Data Flow: Budget Rebalancing

```
Agent Turn N:
  conversation grows by ~500 tokens
      |
      v
  TokenBudgetAllocator.rebalance(currentConversationTokens)
      |
      +-- remaining = total - system - tools - conversation - responseReserve
      +-- memoryBudget = min(remaining * maxMemoryFraction, remaining)
      +-- selectByTokenBudget(memoryFrame, memoryBudget, phaseWeights)
      |     |
      |     +-- Column scan: importance, decay_strength, system_created_at, namespace
      |     +-- Compute composite scores (vectorized over columns)
      |     +-- Sort by score/tokenCost ratio
      |     +-- Greedy selection until budget exhausted
      |     |
      |     +-- Returns: ScoredRecord[] (row indices + scores)
      |
      +-- Return TokenBudgetAllocation
      |
      v
  Agent formats selected memories into system prompt
  (only if selection changed from previous turn)
```

### 1.6 Integration Points

| Existing Component | Integration |
|---|---|
| `MemoryService.formatForPrompt()` | Accepts `ScoredRecord[]` indices to format only selected records |
| `ProgressiveCompress.selectCompressionLevel()` | Uses `TokenBudgetAllocation.conversationTokens` for accurate budget |
| `PhaseAwareWindowManager` | Provides `phaseWeights` to `selectByTokenBudget()` |
| `FrozenMemorySnapshot` | Freezes the `memoryFrame` Table at session start |

### 1.7 Test Cases

| Test | Description |
|------|-------------|
| `batch-token-estimate-accuracy` | 100 records with known text lengths, verify token estimates within 5% of `text.length / 4` |
| `select-budget-respects-limit` | 50 records totaling 10K tokens, budget=5K, verify selected records fit within 5K |
| `select-budget-prefers-high-score` | 10 records with varying importance, verify highest-importance selected first |
| `select-budget-value-density` | Record A: 100 tokens, score 0.8. Record B: 1000 tokens, score 0.9. Budget=150 tokens. Verify A selected (better density) |
| `rebalance-shrinks-memory` | Conversation grows from 10K to 50K tokens, verify memory budget decreases |
| `rebalance-stable-selection` | Two consecutive calls with same conversation size return identical selections |
| `empty-table` | Zero records, verify empty selection returned without error |
| `null-columns` | Records with null importance/decay, verify defaults applied (0.5/1.0) |

---

## 2. Memory-Aware Auto-Compression

### 2.1 Current Integration Point

`autoCompress()` (in `@dzipagent/context/auto-compress.ts`) accepts an `onBeforeSummarize` hook that receives messages about to be compressed away. The `extraction-bridge.ts` creates this hook from a generic `MessageExtractionFn`. The `MemoryAwareExtractor` uses it to extract observations before messages are lost.

The problem: `MemoryAwareExtractor.findDuplicate()` checks observations one at a time using `MemoryService.search()`. For 20 observations extracted from a compression batch, that is 20 serial search calls. Arrow enables batch deduplication.

### 2.2 Arrow-Enhanced Extraction

```typescript
// @dzipagent/memory-ipc/src/memory-aware-compress.ts

import { Table } from 'apache-arrow'

/**
 * Result of batch overlap analysis between extracted observations
 * and existing memories.
 */
export interface OverlapAnalysis {
  /** Observations that have no similar existing memory (safe to store) */
  novel: Array<{ text: string; index: number }>
  /** Observations that overlap with existing memories (skip storage) */
  duplicate: Array<{
    text: string
    index: number
    existingRowIndex: number
    similarity: number
  }>
  /** Time taken for the analysis in milliseconds */
  analysisMs: number
}

/**
 * Batch-analyze which extracted observations overlap with existing memories.
 *
 * Instead of N serial search() calls, this function:
 * 1. Receives the existing memory as an Arrow Table (pre-loaded)
 * 2. Computes word-level Jaccard similarity between each observation
 *    and each memory text in a nested loop over Arrow columns
 * 3. Returns novel vs duplicate classifications
 *
 * The nested loop is efficient because Arrow's text column is contiguous
 * in memory, enabling CPU cache-friendly sequential access.
 *
 * @param observations  Extracted observation texts
 * @param memoryTable   Arrow Table of existing memories (must have 'text' column)
 * @param threshold     Jaccard similarity threshold for duplicate detection (default: 0.8)
 * @returns             Overlap analysis result
 *
 * @example
 * ```ts
 * const existingMemories = await memoryService.exportFrame('observations', scope)
 * const observations = await extractor.extract(oldMessages)
 *
 * const analysis = batchOverlapAnalysis(
 *   observations.map(o => o.text),
 *   existingMemories,
 *   0.8,
 * )
 *
 * // Store only novel observations
 * for (const { text, index } of analysis.novel) {
 *   await memoryService.put('observations', scope, `obs-${index}`, { text })
 * }
 * ```
 */
export function batchOverlapAnalysis(
  observations: string[],
  memoryTable: Table,
  threshold?: number,
): OverlapAnalysis
```

### 2.3 Integration with `onBeforeSummarize`

```typescript
/**
 * Create an Arrow-enhanced extraction hook for autoCompress.
 *
 * Pre-loads the memory frame once at hook creation time, then uses
 * batchOverlapAnalysis on each compression cycle to deduplicate.
 *
 * @param memoryFrame  Arrow Table of existing memories
 * @param extractFn    Observation extraction function
 * @param storeFn      Function to store novel observations
 * @returns            Hook compatible with AutoCompressConfig.onBeforeSummarize
 */
export function createArrowExtractionHook(
  memoryFrame: Table,
  extractFn: (messages: BaseMessage[]) => Promise<Array<{ text: string }>>,
  storeFn: (observations: Array<{ text: string; index: number }>) => Promise<void>,
): (messages: BaseMessage[]) => Promise<void>
```

### 2.4 Data Flow

```
autoCompress() triggers onBeforeSummarize with old messages
      |
      v
Arrow-enhanced extraction hook:
  1. extractFn(oldMessages) --> observations[]
  2. batchOverlapAnalysis(observations, memoryFrame, 0.8)
       |
       +-- For each observation:
       |     Read memoryFrame 'text' column (contiguous scan)
       |     Compute Jaccard similarity against all existing texts
       |     If max similarity >= 0.8: mark as duplicate
       |     Else: mark as novel
       |
       +-- Return OverlapAnalysis
  3. storeFn(analysis.novel) --> store only new observations
      |
      v
autoCompress() proceeds with summarization
```

### 2.5 Test Cases

| Test | Description |
|------|-------------|
| `batch-overlap-empty-memory` | No existing memories, all observations marked novel |
| `batch-overlap-exact-match` | Observation text identical to existing memory, marked duplicate |
| `batch-overlap-partial-match` | 85% Jaccard overlap, marked duplicate (threshold 0.8) |
| `batch-overlap-below-threshold` | 70% Jaccard overlap, marked novel (threshold 0.8) |
| `batch-overlap-performance` | 50 observations x 500 existing memories completes in <50ms |
| `hook-integration` | createArrowExtractionHook called via autoCompress, verify store called with novel only |

---

## 3. Phase-Aware Memory Selection

### 3.1 Current Phase Scoring

`PhaseAwareWindowManager` (in `@dzipagent/context/phase-window.ts`) detects conversation phases and scores **messages** for retention:

- planning: 1.5x retention multiplier
- debugging: 2.0x retention multiplier
- coding: 1.0x retention multiplier
- reviewing: 0.8x retention multiplier

This scoring applies only to messages. Memories are not phase-scored -- all memories contribute equally to the prompt regardless of whether the agent is planning or debugging.

### 3.2 Arrow-Enabled Phase-Weighted Memory Selection

Extend the phase concept to memory records. When the current phase is 'debugging', boost memories from 'lessons' and 'incidents' namespaces. When planning, boost 'decisions' and 'conventions'.

```typescript
// @dzipagent/memory-ipc/src/phase-memory-selection.ts

import { Table } from 'apache-arrow'
import type { ConversationPhase } from '@dzipagent/context'

/**
 * Phase-to-namespace weight mapping.
 *
 * Each phase defines boost multipliers for memory namespaces.
 * Namespaces not listed get a multiplier of 1.0 (no boost).
 */
export const PHASE_NAMESPACE_WEIGHTS: Record<
  ConversationPhase,
  Record<string, number>
> = {
  planning: {
    decisions: 2.0,
    conventions: 1.5,
    lessons: 1.2,
    observations: 0.8,
  },
  coding: {
    conventions: 2.0,
    decisions: 1.5,
    lessons: 1.0,
    observations: 0.8,
  },
  debugging: {
    lessons: 2.5,
    incidents: 2.0,
    decisions: 1.0,
    conventions: 0.8,
    observations: 1.2,
  },
  reviewing: {
    conventions: 2.0,
    decisions: 1.5,
    lessons: 1.0,
    observations: 0.5,
  },
  general: {
    // All namespaces at 1.0 (no boost)
  },
}

/**
 * Phase-to-category weight mapping.
 *
 * Operates on the dictionary-encoded 'category' column in the MemoryFrame.
 * Used alongside namespace weights for finer-grained control.
 */
export const PHASE_CATEGORY_WEIGHTS: Record<
  ConversationPhase,
  Record<string, number>
> = {
  planning: { decision: 2.0, convention: 1.5, lesson: 1.0, observation: 0.7 },
  coding: { convention: 2.0, procedural: 1.8, decision: 1.0, observation: 0.6 },
  debugging: { lesson: 2.5, observation: 2.0, 'causal-edge': 1.8, decision: 1.0 },
  reviewing: { convention: 2.0, decision: 1.5, lesson: 1.0, observation: 0.5 },
  general: {},
}

/**
 * Select memories optimized for the current conversation phase.
 *
 * Arrow enables columnar phase-matching:
 * 1. Read 'namespace' column (dictionary-encoded) -- O(1) per row due to integer indices
 * 2. Read 'category' column (dictionary-encoded) -- O(1) per row
 * 3. Multiply each record's composite score by the phase weight for its namespace and category
 * 4. Run selectByTokenBudget() with phase-adjusted scores
 *
 * @param table          MemoryFrame Arrow Table
 * @param currentPhase   Current conversation phase (from PhaseAwareWindowManager.detectPhase())
 * @param tokenBudget    Maximum tokens for memory context
 * @param options        Additional configuration
 * @returns              Selected records sorted by phase-weighted score
 *
 * @example
 * ```ts
 * const phase = phaseManager.detectPhase(messages)
 * const frame = await memoryService.exportFrame('all', scope)
 *
 * const selected = phaseWeightedSelection(
 *   frame,
 *   phase.phase,
 *   4000,
 * )
 *
 * // During debugging: lessons and incidents boosted 2x-2.5x
 * // During planning: decisions and conventions boosted 1.5x-2.0x
 * ```
 */
export function phaseWeightedSelection(
  table: Table,
  currentPhase: ConversationPhase,
  tokenBudget: number,
  options?: {
    /** Override default phase-namespace weights */
    namespaceWeights?: Record<string, number>
    /** Override default phase-category weights */
    categoryWeights?: Record<string, number>
    /** Chars per token (default: 4) */
    charsPerToken?: number
    /** Current timestamp for recency (default: Date.now()) */
    now?: number
  },
): ScoredRecord[]
```

### 3.3 Data Flow

```
PhaseAwareWindowManager.detectPhase(messages)
      |
      +-- phase = 'debugging', confidence = 0.8
      |
      v
phaseWeightedSelection(memoryFrame, 'debugging', 4000)
      |
      +-- Read 'namespace' column (dictionary Int32 indices)
      |     For each row: lookup PHASE_NAMESPACE_WEIGHTS['debugging'][namespace]
      |     Result: Float64Array of namespace multipliers
      |
      +-- Read 'category' column (dictionary Int32 indices)
      |     For each row: lookup PHASE_CATEGORY_WEIGHTS['debugging'][category]
      |     Result: Float64Array of category multipliers
      |
      +-- Compute adjusted score for each row:
      |     adjustedScore = baseScore * namespaceWeight * categoryWeight
      |
      +-- selectByTokenBudget(table, 4000, { precomputedScores: adjustedScores })
      |
      +-- Return ScoredRecord[]
      |
      v
Format selected records into system prompt
```

### 3.4 Integration Points

| Existing Component | Integration |
|---|---|
| `PhaseAwareWindowManager.detectPhase()` | Provides `currentPhase` input |
| `PhaseAwareWindowManager.scoreMessages()` | Message scoring unchanged; memory scoring added alongside |
| `selectByTokenBudget()` | Receives phase-adjusted scores via `precomputedScores` option |
| `TokenBudgetAllocator` | Accepts optional `currentPhase` to auto-apply phase weights |

### 3.5 Test Cases

| Test | Description |
|------|-------------|
| `debugging-boosts-lessons` | 10 lessons + 10 decisions, debugging phase, budget fits 10: verify lessons selected first |
| `planning-boosts-decisions` | 10 lessons + 10 decisions, planning phase, budget fits 10: verify decisions selected first |
| `general-no-boost` | General phase: all namespaces treated equally (score difference only from importance/decay) |
| `category-override` | Custom categoryWeights override defaults |
| `missing-namespace` | Record has namespace not in weight map, verify default 1.0 applied |
| `combined-weights` | Namespace weight 2.0 + category weight 1.5 = 3.0x total boost |

---

## 4. Prompt Cache Optimization

### 4.1 Current State

`FrozenMemorySnapshot` (in `@dzipagent/memory/frozen-snapshot.ts`) freezes memory reads at session start and buffers writes. `FrozenSnapshot` (in `@dzipagent/context/auto-compress.ts`) freezes a context string. Both enable Anthropic prompt cache stability by keeping the system prompt prefix identical across turns.

The problem: after a long session, new memories may have been written (buffered in `FrozenMemorySnapshot.writeBuffer`). When the session ends and `unfreeze()` flushes writes, the next session's frozen context will differ. There is no efficient way to detect how much the memory has changed, or whether re-freezing is worthwhile.

### 4.2 Arrow Delta Detection

```typescript
// @dzipagent/memory-ipc/src/cache-delta.ts

import { Table } from 'apache-arrow'

/**
 * Result of comparing two MemoryFrame snapshots.
 */
export interface FrameDelta {
  /** Number of records added since the frozen snapshot */
  added: number
  /** Number of records removed since the frozen snapshot */
  removed: number
  /** Number of records whose content changed (same key, different text/payload hash) */
  modified: number
  /** Total records in the frozen frame */
  frozenTotal: number
  /** Total records in the current frame */
  currentTotal: number
  /** Change ratio: (added + removed + modified) / frozenTotal */
  changeRatio: number
  /** Whether the delta exceeds the re-freeze threshold */
  shouldRefreeze: boolean
}

/**
 * Compare a frozen MemoryFrame snapshot with the current state.
 *
 * Uses row-level hash comparison on the 'id' column for set difference
 * (added/removed) and content hash on 'text' + 'payload_json' for
 * modification detection.
 *
 * Arrow enables this efficiently:
 * - 'id' column: build a Set from frozen IDs, scan current IDs for membership
 * - 'text' column: compute FNV-1a hash per row, compare across frames
 *
 * @param frozen           Arrow Table from the frozen snapshot
 * @param current          Arrow Table from the current memory state
 * @param refreezeThreshold  Re-freeze if changeRatio exceeds this (default: 0.1 = 10%)
 * @returns                  Delta analysis
 *
 * @example
 * ```ts
 * const frozenFrame = sessionState.frozenMemoryFrame
 * const currentFrame = await memoryService.exportFrame('all', scope)
 *
 * const delta = computeFrameDelta(frozenFrame, currentFrame, 0.1)
 * if (delta.shouldRefreeze) {
 *   // Re-freeze the prompt cache -- memory has changed significantly
 *   frozenSnapshot.thaw()
 *   frozenSnapshot.freeze(currentFrame)
 * }
 * ```
 */
export function computeFrameDelta(
  frozen: Table,
  current: Table,
  refreezeThreshold?: number,
): FrameDelta {
  const threshold = refreezeThreshold ?? 0.1
  const frozenTotal = frozen.numRows
  const currentTotal = current.numRows

  // Build ID set from frozen frame
  const frozenIds = new Set<string>()
  const frozenIdCol = frozen.getChild('id')
  for (let i = 0; i < frozenTotal; i++) {
    const id = frozenIdCol?.get(i)
    if (id !== null && id !== undefined) frozenIds.add(id as string)
  }

  // Build ID set from current frame
  const currentIds = new Set<string>()
  const currentIdCol = current.getChild('id')
  for (let i = 0; i < currentTotal; i++) {
    const id = currentIdCol?.get(i)
    if (id !== null && id !== undefined) currentIds.add(id as string)
  }

  // Set difference for added/removed
  let added = 0
  for (const id of currentIds) {
    if (!frozenIds.has(id)) added++
  }
  let removed = 0
  for (const id of frozenIds) {
    if (!currentIds.has(id)) removed++
  }

  // For shared IDs, compare content hashes
  // Build hash maps: id -> FNV-1a(text + payload_json)
  const frozenHashes = buildContentHashMap(frozen)
  const currentHashes = buildContentHashMap(current)

  let modified = 0
  for (const [id, hash] of currentHashes) {
    const frozenHash = frozenHashes.get(id)
    if (frozenHash !== undefined && frozenHash !== hash) {
      modified++
    }
  }

  const changeRatio = frozenTotal > 0
    ? (added + removed + modified) / frozenTotal
    : currentTotal > 0 ? 1.0 : 0.0

  return {
    added,
    removed,
    modified,
    frozenTotal,
    currentTotal,
    changeRatio,
    shouldRefreeze: changeRatio > threshold,
  }
}

/**
 * Build a Map of record ID to FNV-1a content hash.
 * Hashes the concatenation of 'text' and 'payload_json' columns.
 */
function buildContentHashMap(table: Table): Map<string, number> {
  const result = new Map<string, number>()
  const idCol = table.getChild('id')
  const textCol = table.getChild('text')
  const payloadCol = table.getChild('payload_json')
  const numRows = table.numRows

  for (let i = 0; i < numRows; i++) {
    const id = idCol?.get(i) as string | null
    if (id === null || id === undefined) continue

    const text = (textCol?.get(i) as string | null) ?? ''
    const payload = (payloadCol?.get(i) as string | null) ?? ''
    result.set(id, fnv1aHash(text + payload))
  }

  return result
}

/**
 * FNV-1a 32-bit hash for fast content comparison.
 * Not cryptographic -- used only for change detection.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) | 0
  }
  return hash >>> 0
}
```

### 4.3 Integration with FrozenMemorySnapshot

```typescript
/**
 * Extended FrozenMemorySnapshot that stores the frozen state as an Arrow Table
 * and supports efficient delta detection.
 */
export class ArrowFrozenMemorySnapshot {
  private frozenFrame: Table | null = null
  private writeBuffer: BufferedWrite[] = []
  private frozen = false

  constructor(
    private memoryService: MemoryService,
    private frameExporter: (ns: string, scope: Record<string, string>) => Promise<Table>,
  ) {}

  /** Freeze memory as an Arrow Table */
  async freeze(
    namespaces: string[],
    scope: Record<string, string>,
  ): Promise<void> {
    // Export all namespaces into a single Arrow Table
    // (FrameBuilder can merge multiple namespace exports)
    const frames: Table[] = []
    for (const ns of namespaces) {
      frames.push(await this.frameExporter(ns, scope))
    }
    this.frozenFrame = mergeFrames(frames)
    this.frozen = true
    this.writeBuffer = []
  }

  /** Check if re-freezing is needed based on memory delta */
  async shouldRefreeze(
    namespaces: string[],
    scope: Record<string, string>,
    threshold?: number,
  ): Promise<FrameDelta | null> {
    if (!this.frozenFrame) return null

    const frames: Table[] = []
    for (const ns of namespaces) {
      frames.push(await this.frameExporter(ns, scope))
    }
    const currentFrame = mergeFrames(frames)

    return computeFrameDelta(this.frozenFrame, currentFrame, threshold)
  }

  // ... existing get/put/unfreeze methods delegate appropriately
}
```

### 4.4 Test Cases

| Test | Description |
|------|-------------|
| `delta-no-change` | Identical frozen and current frames: changeRatio = 0, shouldRefreeze = false |
| `delta-additions` | 10 frozen, 12 current (2 new): changeRatio = 0.2, shouldRefreeze = true (threshold 0.1) |
| `delta-removals` | 10 frozen, 8 current (2 removed): changeRatio = 0.2 |
| `delta-modifications` | 10 frozen, 10 current, 1 text changed: changeRatio = 0.1, shouldRefreeze = false at 0.1 threshold |
| `delta-empty-frozen` | Frozen has 0 records, current has 5: changeRatio = 1.0 |
| `delta-empty-both` | Both empty: changeRatio = 0.0 |
| `fnv1a-deterministic` | Same string always produces same hash |
| `fnv1a-collision-resistance` | 1000 unique strings, verify <1% collision rate |

---

## 5. Context Transfer with Arrow

### 5.1 Current State

`ContextTransferService` (in `@dzipagent/context/context-transfer.ts`) extracts decisions, file paths, and a summary from messages when an intent switch occurs. The extracted `IntentContext` is a plain object:

```typescript
interface IntentContext {
  fromIntent: IntentType
  toIntent: IntentType
  summary: string
  decisions: string[]
  relevantFiles: string[]
  workingState: Record<string, unknown>
  transferredAt: number
  tokenEstimate: number
}
```

The problem: when transferring from a long intent (e.g., "generate feature" with 50 accumulated memories), the text summary loses information. The receiving intent must re-retrieve memories from the store, which may return different results due to decay or new writes.

### 5.2 Arrow Memory Frame Transfer

Add an optional `memoryFrame` field to `IntentContext` that carries serialized Arrow IPC bytes of relevant memories. The receiving intent can import this frame directly, avoiding re-retrieval.

```typescript
// Extended IntentContext (backward compatible -- field is optional)

export interface IntentContext {
  fromIntent: IntentType
  toIntent: IntentType
  summary: string
  decisions: string[]
  relevantFiles: string[]
  workingState: Record<string, unknown>
  transferredAt: number
  tokenEstimate: number

  /**
   * Optional Arrow IPC-serialized MemoryFrame containing relevant memories
   * from the source intent. Serialized as Uint8Array for direct transport.
   *
   * When present, the receiving intent can import this frame via
   * FrameReader.fromIPC() to access the exact memories available
   * during the source intent, avoiding re-retrieval.
   *
   * This field is only populated when Arrow IPC is available
   * (@dzipagent/memory-ipc is installed). Without it, the field is undefined
   * and the receiving intent falls back to store-based retrieval.
   */
  memoryFrame?: Uint8Array
}
```

### 5.3 Enhanced ContextTransferService

```typescript
// @dzipagent/memory-ipc/src/arrow-context-transfer.ts

import { Table } from 'apache-arrow'
import type { IntentContext, ContextTransferConfig } from '@dzipagent/context'

export interface ArrowContextTransferConfig extends ContextTransferConfig {
  /**
   * Function to export memories as an Arrow Table.
   * Called during context extraction to capture the current memory state.
   */
  exportFrame?: (namespace: string, scope: Record<string, string>) => Promise<Table>

  /**
   * Namespaces to include in the memory frame transfer.
   * Default: ['decisions', 'lessons', 'conventions']
   */
  transferNamespaces?: string[]

  /**
   * Maximum size of the serialized Arrow IPC bytes (default: 256KB).
   * If the frame exceeds this, it is trimmed to the highest-scoring records.
   */
  maxFrameBytes?: number

  /** Scope for memory export */
  scope?: Record<string, string>
}

/**
 * Arrow-enhanced context transfer service.
 *
 * Wraps ContextTransferService and adds Arrow memory frame to the
 * IntentContext. The frame contains the exact memory state available
 * during the source intent, enabling zero-loss transfers.
 *
 * @example
 * ```ts
 * const arrowTransfer = new ArrowContextTransferService({
 *   exportFrame: (ns, scope) => memoryIpc.exportFrame(ns, scope),
 *   transferNamespaces: ['decisions', 'lessons'],
 *   scope: { tenantId: 't1', projectId: 'p1' },
 * })
 *
 * // Transfer includes both text context and Arrow memory frame
 * const result = arrowTransfer.transfer(
 *   sourceMessages, 'generate_feature',
 *   targetMessages, 'edit_feature',
 * )
 * // result contains IntentContext with memoryFrame: Uint8Array
 * ```
 */
export class ArrowContextTransferService {
  constructor(config: ArrowContextTransferConfig)

  /**
   * Extract context with Arrow memory frame.
   * Delegates text extraction to base ContextTransferService,
   * then appends the serialized Arrow frame.
   */
  async extractContext(
    messages: readonly BaseMessage[],
    intentType: string,
    workingState?: Record<string, unknown>,
  ): Promise<IntentContext>

  /**
   * Import a received memory frame into the local memory service.
   *
   * @param context     IntentContext with memoryFrame
   * @param importFn    Function to import records from the frame
   * @returns           Number of records imported
   */
  async importMemoryFrame(
    context: IntentContext,
    importFn: (records: Array<{ namespace: string; key: string; value: Record<string, unknown> }>) => Promise<number>,
  ): Promise<number>
}
```

### 5.4 Data Flow

```
Intent A: "generate_feature" ending
      |
      v
ArrowContextTransferService.extractContext(messages, 'generate_feature')
      |
      +-- Base: extract summary, decisions, files (text analysis)
      +-- Arrow: for each transferNamespace:
      |     exportFrame(ns, scope) --> Table
      |     selectByTokenBudget(table, perNamespaceBudget)
      |     tableToIPC(selectedSubTable) --> Uint8Array
      |
      +-- Merge IPC bytes into single frame
      +-- Set context.memoryFrame = mergedIpcBytes
      |
      v
Intent B: "edit_feature" starting
      |
      +-- Receive IntentContext with memoryFrame
      +-- If memoryFrame present:
      |     tableFromIPC(memoryFrame) --> Table
      |     FrameReader.toRecords(table) --> Record[]
      |     Import into local MemoryService
      |
      +-- Also inject text summary as SystemMessage (existing behavior)
```

### 5.5 Test Cases

| Test | Description |
|------|-------------|
| `transfer-with-frame` | Transfer from intent A to B, verify memoryFrame is Uint8Array |
| `transfer-without-ipc` | No exportFrame configured, verify memoryFrame is undefined (graceful fallback) |
| `frame-size-limit` | 1MB of memories, maxFrameBytes=256KB, verify frame trimmed to budget |
| `round-trip-fidelity` | Export frame, serialize to IPC, import at destination, verify record equality |
| `cross-namespace-merge` | Transfer from 3 namespaces, verify merged frame contains all |
| `import-to-service` | importMemoryFrame calls importFn with correct record structure |

---

## 6. Progressive Compression + Arrow

### 6.1 Current Compression Levels

From `progressive-compress.ts`:

| Level | Action | Arrow Opportunity |
|-------|--------|-------------------|
| 0 | No compression | None |
| 1 | Tool result pruning + orphan repair | None (operates on message structure) |
| 2 | Level 1 + trim verbose AI responses | Arrow can identify which responses overlap with stored memories |
| 3 | Level 2 + LLM summarization | Arrow Table replaces per-record search for memory overlap |
| 4 | Ultra-compressed: summary + last N messages | Arrow Table IS the compressed memory context |

### 6.2 Level 2-3 Enhancement: Memory-Aware Trimming

At levels 2-3, some AI responses contain information that is already stored in memory. Trimming these first (instead of trimming by character length) preserves unique information.

```typescript
// @dzipagent/memory-ipc/src/compress-with-memory.ts

import { Table } from 'apache-arrow'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { CompressionLevel, ProgressiveCompressResult } from '@dzipagent/context'

/**
 * Configuration for memory-aware compression.
 */
export interface MemoryAwareCompressConfig {
  /** Existing memory as Arrow Table */
  memoryTable: Table
  /** Token budget for the final compressed output */
  tokenBudget: number
  /** Characters per token (default: 4) */
  charsPerToken?: number
  /** Overlap threshold: messages with this fraction of content in memory are trimmed first (default: 0.6) */
  overlapThreshold?: number
  /** Number of recent messages to preserve regardless of overlap (default: 3) */
  preserveRecent?: number
}

/**
 * Per-message overlap analysis result.
 */
export interface MessageOverlap {
  /** Message index in the array */
  index: number
  /** Fraction of message content that overlaps with existing memories (0-1) */
  overlapFraction: number
  /** Whether this message is a candidate for aggressive trimming */
  isRedundant: boolean
  /** Estimated token count for this message */
  tokenCount: number
}

/**
 * Analyze overlap between conversation messages and existing memories.
 *
 * For each AI message, computes what fraction of its content is already
 * captured in the memory Arrow Table. Messages with high overlap are
 * candidates for aggressive trimming because the information is preserved
 * in memory.
 *
 * Uses word-level Jaccard similarity between message text and each memory
 * 'text' column entry. The maximum similarity across all memories is the
 * overlap fraction.
 *
 * @param messages     Conversation messages
 * @param memoryTable  Arrow Table of existing memories
 * @param options      Configuration
 * @returns            Per-message overlap analysis
 */
export function analyzeMessageMemoryOverlap(
  messages: BaseMessage[],
  memoryTable: Table,
  options?: {
    overlapThreshold?: number
    preserveRecent?: number
  },
): MessageOverlap[]

/**
 * Compress messages with memory context awareness.
 *
 * Joint optimization that considers both message retention value and
 * memory coverage. Messages whose content is already in memory are
 * compressed more aggressively; messages with unique information are
 * preserved longer.
 *
 * Level behavior:
 *   Level 0-1: No Arrow integration (pass through to base compressor)
 *   Level 2: Trim AI responses that have >60% overlap with memories first
 *   Level 3: LLM summarization, but skip messages already in memory
 *   Level 4: Arrow Table IS the context -- summary + top-N memories by score
 *
 * @param messages      Conversation messages
 * @param memoryTable   Arrow Table of existing memories
 * @param level         Compression level (0-4)
 * @param model         LLM for summarization (levels 3-4)
 * @param config        Compression configuration
 * @returns             Compressed result
 *
 * @example
 * ```ts
 * const memories = await memoryService.exportFrame('all', scope)
 * const result = await compressWithMemoryContext(
 *   messages,
 *   memories,
 *   3,        // Level 3: structured summarization
 *   model,
 *   { tokenBudget: 8000 },
 * )
 * // Messages overlapping with memories were trimmed first,
 * // preserving unique conversation content longer
 * ```
 */
export async function compressWithMemoryContext(
  messages: BaseMessage[],
  memoryTable: Table,
  level: CompressionLevel,
  model: BaseChatModel,
  config: MemoryAwareCompressConfig,
): Promise<ProgressiveCompressResult>
```

### 6.3 Level 4: Arrow Table as Compressed Context

At level 4 (ultra-compressed), the conversation is reduced to a summary + last N messages. With Arrow, we can replace the summary with a structured memory selection that preserves more information.

```typescript
/**
 * Level 4 Arrow context: replace text summary with structured memory selection.
 *
 * Instead of:
 *   "Agent discussed database design, decided on PostgreSQL..."
 *
 * Produces:
 *   ## Memory Context (12 records, 3,200 tokens)
 *   ### Decisions
 *   - Use PostgreSQL for persistence [importance: 0.9, decay: 0.95]
 *   - Event-driven architecture for real-time [importance: 0.85, decay: 0.88]
 *   ### Lessons
 *   - Always validate Prisma schema before migration [importance: 0.8, decay: 0.72]
 *   ...
 *
 * This is more structured and preserves the actual memory records rather
 * than a lossy LLM summary.
 */
export function buildLevel4ArrowContext(
  memoryTable: Table,
  tokenBudget: number,
  options?: {
    phaseWeights?: Record<string, number>
    charsPerToken?: number
    includeScores?: boolean
  },
): { context: string; selectedCount: number; totalScore: number }
```

### 6.4 Data Flow

```
selectCompressionLevel(messages, tokenBudget) --> level 3
      |
      v
compressWithMemoryContext(messages, memoryTable, 3, model, config)
      |
      +-- analyzeMessageMemoryOverlap(messages, memoryTable)
      |     |
      |     +-- For each AI message:
      |     |     Compute Jaccard overlap with each memory text (Arrow column scan)
      |     |     Return max overlap fraction
      |     |
      |     +-- Mark messages with overlap > 0.6 as 'redundant'
      |
      +-- Reorder messages for compression:
      |     Move redundant messages to front (trimmed first)
      |     Keep recent messages at back (preserved)
      |
      +-- Apply level 2: trim redundant messages aggressively
      +-- Apply level 3: summarize remaining old messages
      |
      +-- Return ProgressiveCompressResult
```

### 6.5 Test Cases

| Test | Description |
|------|-------------|
| `overlap-detection` | AI message "Use PostgreSQL" with memory containing "Use PostgreSQL": overlap > 0.8 |
| `no-overlap` | AI message about new topic, no matching memories: overlap = 0 |
| `redundant-trimmed-first` | 5 redundant + 5 unique messages, level 2: redundant trimmed, unique preserved |
| `level4-arrow-context` | Level 4 produces structured memory context instead of text summary |
| `level4-budget-respected` | Level 4 context fits within tokenBudget |
| `preserve-recent` | Last 3 messages never marked redundant regardless of overlap |
| `level0-passthrough` | Level 0 returns messages unchanged, no Arrow interaction |
| `missing-memory-table` | Null memoryTable falls back to standard compression (no crash) |

---

## Appendix: File Structure

```
packages/forgeagent-memory-ipc/src/
  token-budget.ts                    # batchTokenEstimate, selectByTokenBudget, TokenBudgetAllocator
  phase-memory-selection.ts          # phaseWeightedSelection, PHASE_NAMESPACE_WEIGHTS
  cache-delta.ts                     # computeFrameDelta, FrameDelta, buildContentHashMap
  memory-aware-compress.ts           # batchOverlapAnalysis, createArrowExtractionHook
  compress-with-memory.ts            # compressWithMemoryContext, analyzeMessageMemoryOverlap
  arrow-context-transfer.ts          # ArrowContextTransferService

  __tests__/
    token-budget.test.ts
    phase-memory-selection.test.ts
    cache-delta.test.ts
    memory-aware-compress.test.ts
    compress-with-memory.test.ts
    arrow-context-transfer.test.ts
```

**Total: 6 source files + 6 test files = 12 files**
**Estimated effort: 8h**

---

## Appendix: Dependency Constraints

- `@dzipagent/memory-ipc` depends on `apache-arrow` (peer) and `@dzipagent/memory` (peer)
- `@dzipagent/memory-ipc` may import types from `@dzipagent/context` (for `ConversationPhase`, `CompressionLevel`, `IntentContext`)
- `@dzipagent/context` does NOT depend on `@dzipagent/memory-ipc` -- Arrow integration is opt-in via the IPC package
- `@dzipagent/memory` does NOT depend on `apache-arrow` -- the core memory package remains lightweight
- All Arrow-context integration functions accept `Table` as input, not `MemoryService` -- keeping the dependency on the interface, not the implementation
