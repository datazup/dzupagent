/**
 * LLM-powered semantic memory consolidation.
 *
 * Unlike the naive prefix-100-char deduplication in `memory-consolidation.ts`,
 * this module uses an LLM to compare semantically similar memory records and
 * determine the correct action: ADD, UPDATE, DELETE, NOOP, MERGE, or CONTRADICT.
 *
 * The existing `consolidateNamespace` / `consolidateAll` remain as the non-LLM
 * fallback. This class is designed to be used alongside them.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsolidationAction = 'add' | 'update' | 'delete' | 'noop' | 'merge' | 'contradict'

export interface ConsolidationDecision {
  action: ConsolidationAction
  /** Key of existing memory to update/delete/merge with */
  targetKey?: string | undefined
  /** New content for update/merge actions */
  mergedContent?: string | undefined
  /** Explanation of why this action was chosen */
  reason: string
}

export interface SemanticConsolidationConfig {
  /** LLM model for consolidation (use cheapest tier, e.g. Haiku) */
  model: BaseChatModel
  /** Max similar entries to compare per candidate (default: 5) */
  topK?: number | undefined
  /** Max LLM calls per consolidation run (default: 20) */
  maxLLMCalls?: number | undefined
  /** Similarity threshold for triggering LLM comparison (default: 0.5) */
  similarityThreshold?: number | undefined
}

export interface SemanticConsolidationResult {
  namespace: string[]
  before: number
  after: number
  actions: Array<{ key: string; decision: ConsolidationDecision }>
  llmCallsUsed: number
  contradictions: Array<{ keys: [string, string]; reason: string }>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. Compare these two memory records and determine the correct action.

Record A (key: {keyA}):
{textA}

Record B (key: {keyB}):
{textB}

Determine ONE action:
- ADD: Record A contains new information not captured by B. Keep both.
- UPDATE: Record A supersedes B. Provide merged content that combines the best of both.
- DELETE: Record A is obsolete given B. Remove A.
- NOOP: Records are essentially the same. Keep B, remove A.
- MERGE: Combine both into a single richer record. Provide merged content.
- CONTRADICT: Records contain opposing facts. Flag for human review.

Respond as JSON: {"action": "...", "mergedContent": "...", "reason": "..."}
The mergedContent field is only needed for UPDATE and MERGE actions.`

const VALID_ACTIONS = new Set<ConsolidationAction>([
  'add', 'update', 'delete', 'noop', 'merge', 'contradict',
])

interface StoreItem {
  key: string
  value: Record<string, unknown>
  text: string
}

function extractText(value: Record<string, unknown>): string {
  return typeof value['text'] === 'string' ? value['text'] : JSON.stringify(value)
}

/**
 * Parse a JSON response from the LLM. Handles markdown code blocks and
 * other common wrappers that models sometimes add.
 */
function parseLLMJson(raw: string): { action: string; mergedContent?: string | undefined; reason: string } | null {
  // Strip markdown code fences if present
  let cleaned = raw.trim()
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim()
  }

  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'action' in parsed &&
      'reason' in parsed &&
      typeof (parsed as Record<string, unknown>)['action'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['reason'] === 'string'
    ) {
      const obj = parsed as Record<string, unknown>
      return {
        action: obj['action'] as string,
        mergedContent: typeof obj['mergedContent'] === 'string' ? obj['mergedContent'] : undefined,
        reason: obj['reason'] as string,
      }
    }
  } catch {
    // Unparseable — fall through to return null
  }
  return null
}

// ---------------------------------------------------------------------------
// SemanticConsolidator
// ---------------------------------------------------------------------------

export class SemanticConsolidator {
  private readonly model: BaseChatModel
  private readonly topK: number
  private readonly maxLLMCalls: number
  private readonly similarityThreshold: number

  constructor(config: SemanticConsolidationConfig) {
    this.model = config.model
    this.topK = config.topK ?? 5
    this.maxLLMCalls = config.maxLLMCalls ?? 20
    this.similarityThreshold = config.similarityThreshold ?? 0.5
  }

  /**
   * Run semantic consolidation on a single namespace.
   *
   * Algorithm:
   * 1. Load all records via store.search
   * 2. For each record, find similar entries using semantic search
   * 3. For each similar pair above threshold, ask LLM for a decision
   * 4. Execute actions (update, delete, merge, flag contradiction)
   * 5. Return structured result
   */
  async consolidate(
    store: BaseStore,
    namespace: string[],
  ): Promise<SemanticConsolidationResult> {
    let llmCallsUsed = 0
    const actions: Array<{ key: string; decision: ConsolidationDecision }> = []
    const contradictions: Array<{ keys: [string, string]; reason: string }> = []
    const deletedKeys = new Set<string>()

    // Phase 1: Load all records
    const rawItems = await store.search(namespace, { limit: 200 })
    const before = rawItems.length

    if (before === 0) {
      return { namespace, before: 0, after: 0, actions: [], llmCallsUsed: 0, contradictions: [] }
    }

    const items: StoreItem[] = rawItems.map(item => ({
      key: item.key,
      value: item.value as Record<string, unknown>,
      text: extractText(item.value as Record<string, unknown>),
    }))

    // Track which pairs we have already compared to avoid double-processing
    const comparedPairs = new Set<string>()

    // Phase 2-3: For each record, find similar entries and compare via LLM
    for (const item of items) {
      if (deletedKeys.has(item.key)) continue
      if (llmCallsUsed >= this.maxLLMCalls) break
      if (!item.text) continue

      // Semantic search for similar records
      let similarItems: Array<{ key: string; value: Record<string, unknown>; score?: number }>
      try {
        similarItems = await store.search(namespace, {
          query: item.text,
          limit: this.topK + 1, // +1 because the item itself may appear
        })
      } catch {
        // If semantic search is unavailable, skip this record
        continue
      }

      for (const similar of similarItems) {
        if (similar.key === item.key) continue
        if (deletedKeys.has(similar.key)) continue
        if (llmCallsUsed >= this.maxLLMCalls) break

        // Build a canonical pair key to avoid comparing A-B and B-A
        const pairKey = [item.key, similar.key].sort().join('::')
        if (comparedPairs.has(pairKey)) continue
        comparedPairs.add(pairKey)

        // Check similarity threshold if score is available
        const score = (similar as { score?: number }).score
        if (typeof score === 'number' && score < this.similarityThreshold) continue

        const similarText = extractText(similar.value as Record<string, unknown>)
        if (!similarText) continue

        // Ask LLM to compare
        const decision = await this.comparePair(
          item.key, item.text,
          similar.key, similarText,
        )
        llmCallsUsed++

        if (!decision) continue // LLM call failed or unparseable

        actions.push({ key: item.key, decision })

        // Execute the decision
        try {
          await this.executeDecision(store, namespace, item, similar, decision, deletedKeys)
        } catch {
          // Non-fatal — store operation failed, continue
        }

        if (decision.action === 'contradict') {
          contradictions.push({
            keys: [item.key, similar.key],
            reason: decision.reason,
          })
        }

        // If item A was deleted by the decision, stop comparing it
        if (deletedKeys.has(item.key)) break
      }
    }

    const after = before - deletedKeys.size
    return { namespace, before, after, actions, llmCallsUsed, contradictions }
  }

  /**
   * Ask the LLM to compare two memory records and return a consolidation decision.
   * Returns null if the LLM call fails or the response is unparseable.
   */
  private async comparePair(
    keyA: string,
    textA: string,
    keyB: string,
    textB: string,
  ): Promise<ConsolidationDecision | null> {
    const prompt = CONSOLIDATION_PROMPT
      .replace('{keyA}', keyA)
      .replace('{textA}', textA)
      .replace('{keyB}', keyB)
      .replace('{textB}', textB)

    try {
      const response = await this.model.invoke([
        new SystemMessage('You are a memory consolidation agent. Respond only with valid JSON.'),
        new HumanMessage(prompt),
      ])

      const content = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content) && response.content.length > 0
          ? String(response.content[0])
          : ''

      const parsed = parseLLMJson(content)
      if (!parsed) return null

      const action = parsed.action.toLowerCase() as ConsolidationAction
      if (!VALID_ACTIONS.has(action)) return null

      return {
        action,
        targetKey: keyB,
        mergedContent: parsed.mergedContent,
        reason: parsed.reason,
      }
    } catch {
      // Non-fatal — LLM call failed, skip this pair
      return null
    }
  }

  /**
   * Execute a consolidation decision against the store.
   */
  private async executeDecision(
    store: BaseStore,
    namespace: string[],
    itemA: StoreItem,
    itemB: { key: string; value: Record<string, unknown> },
    decision: ConsolidationDecision,
    deletedKeys: Set<string>,
  ): Promise<void> {
    switch (decision.action) {
      case 'add':
        // Keep both — nothing to do
        break

      case 'noop':
        // Records are essentially the same — remove A, keep B
        await store.delete(namespace, itemA.key)
        deletedKeys.add(itemA.key)
        break

      case 'delete':
        // A is obsolete — remove it
        await store.delete(namespace, itemA.key)
        deletedKeys.add(itemA.key)
        break

      case 'update': {
        // A supersedes B — update B with merged content, remove A
        if (decision.mergedContent) {
          const updatedValue = {
            ...(itemB.value as Record<string, unknown>),
            text: decision.mergedContent,
            consolidatedAt: new Date().toISOString(),
          }
          await store.put(namespace, itemB.key, updatedValue)
        }
        await store.delete(namespace, itemA.key)
        deletedKeys.add(itemA.key)
        break
      }

      case 'merge': {
        // Combine both into B, remove A
        if (decision.mergedContent) {
          const mergedValue = {
            ...(itemB.value as Record<string, unknown>),
            text: decision.mergedContent,
            consolidatedAt: new Date().toISOString(),
          }
          await store.put(namespace, itemB.key, mergedValue)
        }
        await store.delete(namespace, itemA.key)
        deletedKeys.add(itemA.key)
        break
      }

      case 'contradict': {
        // Flag both — do not delete either. Add metadata for human review.
        const contradictMetaA = {
          ...itemA.value,
          _contradicts: itemB.key,
          _contradictionFlaggedAt: new Date().toISOString(),
        }
        const contradictMetaB = {
          ...(itemB.value as Record<string, unknown>),
          _contradicts: itemA.key,
          _contradictionFlaggedAt: new Date().toISOString(),
        }
        await store.put(namespace, itemA.key, contradictMetaA)
        await store.put(namespace, itemB.key, contradictMetaB)
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * One-shot semantic consolidation for a namespace.
 * Convenience wrapper around SemanticConsolidator.
 */
export async function consolidateWithLLM(
  store: BaseStore,
  namespace: string[],
  config: SemanticConsolidationConfig,
): Promise<SemanticConsolidationResult> {
  const consolidator = new SemanticConsolidator(config)
  return consolidator.consolidate(store, namespace)
}
