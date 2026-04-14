/**
 * Persistent cross-intent context transfer.
 *
 * Bridges the in-memory ContextTransferService (from @dzupagent/context)
 * with BaseStore persistence, so context extracted at the end of one run
 * survives and is available to subsequent runs in the same session.
 *
 * @example
 * ```ts
 * // After generate_feature completes:
 * const context = transferService.extractContext(messages, 'generate_feature', workingState)
 * await runTransfer.save(sessionId, context)
 *
 * // When edit_feature starts:
 * const prior = await runTransfer.loadForIntent(sessionId, 'edit_feature')
 * if (prior) {
 *   const enriched = transferService.injectContext(prior, newMessages)
 * }
 * ```
 */
import type { BaseStore } from '@langchain/langgraph'

/** Serializable context snapshot persisted to the store */
export interface PersistedIntentContext {
  fromIntent: string
  summary: string
  decisions: string[]
  relevantFiles: string[]
  workingState: Record<string, unknown>
  transferredAt: number
  tokenEstimate: number
}

/** Which prior intents can feed context to which current intents */
export const INTENT_CONTEXT_CHAINS: Record<string, string[]> = {
  edit_feature: ['generate_feature', 'create_feature'],
  configure: ['generate_feature', 'create_feature', 'edit_feature'],
  create_template: ['generate_feature'],
  generate_feature: ['configure'],
}

export interface RunContextTransferConfig {
  store: BaseStore
  /** Namespace prefix for context storage (default: ['_run_context']) */
  namespacePrefix?: string[]
  /** Max age in ms before context is considered stale (default: 24h) */
  maxAgeMs?: number
}

const DEFAULT_NAMESPACE_PREFIX = ['_run_context']
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SEARCH_PAGE_SIZE = 100
const MAX_SEARCH_PAGES = 1000

type StoreSearchItem = Awaited<ReturnType<BaseStore['search']>>[number]

export class RunContextTransfer {
  private readonly store: BaseStore
  private readonly namespacePrefix: string[]
  private readonly maxAgeMs: number

  constructor(config: RunContextTransferConfig) {
    this.store = config.store
    this.namespacePrefix = config.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  /**
   * Save context at the end of a run.
   * Overwrites any existing context for the same session + intent.
   */
  async save(sessionId: string, context: PersistedIntentContext): Promise<void> {
    const namespace = [...this.namespacePrefix, sessionId]
    const key = `intent:${context.fromIntent}`
    await this.store.put(namespace, key, {
      ...context,
      transferredAt: context.transferredAt || Date.now(),
    })
  }

  /**
   * Load context from a specific prior intent.
   * Returns null if no context exists or if it's stale.
   */
  async load(sessionId: string, fromIntent: string): Promise<PersistedIntentContext | null> {
    const namespace = [...this.namespacePrefix, sessionId]
    const key = `intent:${fromIntent}`
    const item = await this.findContextItem(namespace, key)

    if (!item) return null

    const context = item.value as unknown as PersistedIntentContext
    if (!context.transferredAt) return null

    const age = Date.now() - context.transferredAt
    if (age > this.maxAgeMs) return null

    return context
  }

  /**
   * Load the best available context for a current intent by checking
   * the known context chain. Returns the first non-stale context found.
   */
  async loadForIntent(sessionId: string, currentIntent: string): Promise<PersistedIntentContext | null> {
    const chain = INTENT_CONTEXT_CHAINS[currentIntent]
    if (!chain || chain.length === 0) return null

    for (const priorIntent of chain) {
      const context = await this.load(sessionId, priorIntent)
      if (context) return context
    }

    return null
  }

  /**
   * List all saved contexts for a session (for debugging/UI).
   */
  async listContexts(sessionId: string): Promise<PersistedIntentContext[]> {
    const namespace = [...this.namespacePrefix, sessionId]
    const items = await this.searchAllContextItems(namespace)
    return items
      .map(i => i.value as unknown as PersistedIntentContext)
      .filter(c => c.fromIntent && c.transferredAt)
  }

  /**
   * Clear all context for a session.
   */
  async clear(sessionId: string): Promise<void> {
    const namespace = [...this.namespacePrefix, sessionId]
    const items = await this.searchAllContextItems(namespace)
    for (const item of items) {
      await this.store.delete(namespace, item.key)
    }
  }

  private async findContextItem(namespace: string[], key: string): Promise<StoreSearchItem | undefined> {
    let page = 0
    let offset = 0

    while (page < MAX_SEARCH_PAGES) {
      const items = await this.store.search(namespace, { limit: SEARCH_PAGE_SIZE, offset })
      const match = items.find(item => item.key === key)
      if (match) return match
      if (items.length < SEARCH_PAGE_SIZE) return undefined

      page++
      offset += SEARCH_PAGE_SIZE
    }

    throw new Error(`RunContextTransfer search exceeded ${MAX_SEARCH_PAGES} pages while loading "${key}"`)
  }

  private async searchAllContextItems(namespace: string[]): Promise<StoreSearchItem[]> {
    const items: StoreSearchItem[] = []

    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const offset = page * SEARCH_PAGE_SIZE
      const batch = await this.store.search(namespace, { limit: SEARCH_PAGE_SIZE, offset })
      items.push(...batch)

      if (batch.length < SEARCH_PAGE_SIZE) {
        return items
      }
    }

    throw new Error(`RunContextTransfer search exceeded ${MAX_SEARCH_PAGES} pages for namespace "${namespace.join('/')}"`)
  }
}
