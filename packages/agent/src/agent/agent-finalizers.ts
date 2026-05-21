/**
 * Agent post-run finalizer helpers — extracted from DzupAgent.
 *
 * These helpers handle the "after the loop runs" concerns: updating the
 * conversation summary (compression), persisting the final response to
 * memory (write-back). Keeping them out of `dzip-agent.ts` makes the
 * class body focus on orchestration.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { shouldSummarize, summarizeAndTrim } from '@dzupagent/context'
import { findWeakMemories, MemoryPruner, ConsolidationEngine } from '@dzupagent/memory'
import type { DecayMetadata, PrunerMemoryStore } from '@dzupagent/memory'
import { PiiDetector } from '@dzupagent/security'
import type { DzupAgentConfig } from './agent-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

const DEFAULT_DECAY_THRESHOLD = 200
const DECAY_STRENGTH_THRESHOLD = 0.1

export interface UpdateSummaryParams {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  conversationSummary: string | null
  messages: BaseMessage[]
  memoryFrame?: unknown
}

/**
 * Maybe update the running conversation summary for the agent.
 *
 * Runs the full compression pipeline (prune + repair + split + summarize)
 * via `summarizeAndTrim` when the input messages exceed the configured
 * threshold. Returns the new summary string (or the previous one if no
 * update was needed). Failures are swallowed — summarization must never
 * abort a run.
 */
export async function maybeUpdateSummary(
  params: UpdateSummaryParams,
): Promise<string | null> {
  const { agentId, config, resolvedModel, conversationSummary, messages, memoryFrame } = params

  if (!shouldSummarize(messages, config.messageConfig)) {
    return conversationSummary
  }

  try {
    // Use a cheaper model for summarization when a registry is configured.
    const summaryModel = config.registry
      ? config.registry.getModel('chat')
      : resolvedModel

    const { summary } = await summarizeAndTrim(
      messages,
      conversationSummary,
      summaryModel,
      omitUndefined({
        ...config.messageConfig,
        ...(memoryFrame ? { memoryFrame } : {}),
        onFallback: config.onFallback
          ? (reason: string, before: number, after: number) => {
              config.onFallback!(reason, before, after)
              config.eventBus?.emit({
                type: 'agent:context_fallback',
                agentId,
                reason,
                before,
                after,
              })
            }
          : config.eventBus
            ? (reason: string, before: number, after: number) => {
                config.eventBus!.emit({
                  type: 'agent:context_fallback',
                  agentId,
                  reason,
                  before,
                  after,
                })
              }
            : undefined,
      }),
    )
    return summary
  } catch {
    // Summarization failures are non-fatal
    return conversationSummary
  }
}

export interface WriteBackMemoryParams {
  agentId: string
  runId?: string
  config: DzupAgentConfig
  content: string
}

/**
 * Persist the agent's final response content to the configured memory
 * store so memory becomes durable across calls without callers having to
 * do it manually.
 *
 * No-op unless `memory`, `memoryNamespace`, `memoryScope` are all set,
 * `memoryWriteBack !== false`, and `content` is non-empty. Failures are
 * swallowed — write-back must never throw.
 */
export async function maybeWriteBackMemory(
  params: WriteBackMemoryParams,
): Promise<void> {
  const { agentId, runId, config, content } = params
  if (
    config.memoryWriteBack === false ||
    !config.memory ||
    !config.memoryNamespace ||
    !config.memoryScope ||
    !content
  ) return

  // OWASP-aligned PII gate (audit MC-01 / AG-09).
  // - `pii: 'redact'` rewrites SSN/CC/IBAN/JWT/API-key with typed
  //   markers before the record reaches the memory store.
  // - `pii: 'block'` aborts write-back when any PII is detected and
  //   surfaces a `memory:error` event so callers can audit the gate.
  const piiMode = config.security?.pii ?? 'off'
  let toWrite = content
  if (piiMode !== 'off') {
    const detector = new PiiDetector()
    const scan = detector.scan(content)
    if (scan.hasPii) {
      if (piiMode === 'block') {
        config.eventBus?.emit({
          type: 'memory:error',
          agentId,
          ...(runId !== undefined ? { runId } : {}),
          namespace: config.memoryNamespace,
          key: 'pii-blocked',
          scopeKeys: getSafeScopeKeys(config.memoryScope),
          message: `Memory write-back blocked: PII detected (${scan.types.join(',')})`,
        })
        return
      }
      toWrite = detector.sanitize(content)
    }
  }

  const now = Date.now()
  const key = now.toString()
  try {
    await config.memory.put(
      config.memoryNamespace,
      config.memoryScope,
      key,
      {
        text: toWrite,
        agentId,
        timestamp: now,
        ...(config.ttlMs !== undefined
          ? { expiresAt: now + config.ttlMs }
          : {}),
      },
    )
    config.eventBus?.emit({
      type: 'memory:written',
      agentId,
      ...(runId !== undefined ? { runId } : {}),
      namespace: config.memoryNamespace,
      key,
      scopeKeys: getSafeScopeKeys(config.memoryScope),
    })
    // Fire-and-forget decay sweep — must never delay or abort the run
    void runMemoryDecay(agentId, config)
    // Fire-and-forget MC-02 prune (TTL + capacity cap) — also non-blocking
    void runMemoryPruner(agentId, config)
    // Fire-and-forget MC-02 consolidation sweep — clusters + summarises entries
    void runConsolidateFinalizer(agentId, config)
  } catch {
    config.eventBus?.emit({
      type: 'memory:put_failed',
      agentId,
      ...(runId !== undefined ? { runId } : {}),
      namespace: config.memoryNamespace,
      key,
      scopeKeys: getSafeScopeKeys(config.memoryScope),
      message: 'Memory write-back failed',
    })
    config.eventBus?.emit({
      type: 'memory:error',
      agentId,
      ...(runId !== undefined ? { runId } : {}),
      namespace: config.memoryNamespace,
      key,
      scopeKeys: getSafeScopeKeys(config.memoryScope),
      message: 'Memory write-back failed',
    })
    // write-back failures are non-fatal
  }
}

function getSafeScopeKeys(scope: Record<string, string>): string[] {
  return Object.keys(scope).sort()
}

interface DecayRecord {
  _key?: string
  _decay?: DecayMetadata
  [key: string]: unknown
}

/**
 * Fire-and-forget memory decay sweep.
 *
 * Loads all records for the namespace, identifies those below the
 * forgetting-curve strength threshold, and deletes them via the public
 * MemoryService API. Only runs when the record count exceeds
 * `memoryDecayThreshold` to avoid sweeping on every write.
 *
 * Failures are fully swallowed — decay is a background hygiene task and
 * must never interfere with the agent run result.
 */
async function runMemoryDecay(
  agentId: string,
  config: DzupAgentConfig,
): Promise<void> {
  const memory = config.memory
  const namespace = config.memoryNamespace
  const scope = config.memoryScope
  if (!memory || !namespace || !scope) return

  const threshold = config.memoryDecayThreshold ?? DEFAULT_DECAY_THRESHOLD
  if (threshold === 0 || !isFinite(threshold)) return

  try {
    const records = await memory.get(namespace, scope)
    if (records.length < threshold) return

    const withDecay = records.flatMap((r): Array<{ key: string; meta: DecayMetadata }> => {
      const rec = r as DecayRecord
      const key = typeof rec['_key'] === 'string' ? rec['_key'] : undefined
      const meta = rec['_decay']
      if (!key || !meta) return []
      return [{ key, meta }]
    })

    if (withDecay.length === 0) return

    const weak = findWeakMemories(withDecay, DECAY_STRENGTH_THRESHOLD)
    if (weak.length === 0) return

    let pruned = 0
    for (const { key } of weak) {
      const deleted = await memory.delete(namespace, scope, key)
      if (deleted) pruned++
    }

    if (pruned > 0) {
      config.eventBus?.emit({
        type: 'memory:written',
        agentId,
        namespace,
        key: `decay:sweep:${Date.now()}`,
        scopeKeys: getSafeScopeKeys(scope),
      })
    }
  } catch {
    // Decay sweep failures are non-fatal
  }
}

/**
 * Fire-and-forget {@link MemoryPruner} sweep (MC-02).
 *
 * Bounds the configured namespace by TTL (`memoryPolicy.ttlMs`, default 7
 * days) and capacity (`memoryPolicy.maxEntries`, default 1000). Disabled
 * when `memoryPolicy.pruneFinalizer === false` or when the configured
 * `MemoryService` does not expose a backing `BaseStore`. Failures are
 * fully swallowed.
 */
async function runMemoryPruner(
  agentId: string,
  config: DzupAgentConfig,
): Promise<void> {
  const policy = config.memoryPolicy
  if (policy?.pruneFinalizer === false) return

  const memory = config.memory
  const namespace = config.memoryNamespace
  const scope = config.memoryScope
  if (!memory || !namespace || !scope) return

  // The pruner needs direct store access; older MemoryService instances
  // without `getStore()` are skipped silently.
  const getStore = (memory as { getStore?: () => unknown }).getStore
  if (typeof getStore !== 'function') return

  let store: unknown
  try {
    store = getStore.call(memory)
  } catch {
    return
  }
  if (!isPrunerStore(store)) return
  const prunerStore = store as unknown as PrunerMemoryStore

  // Build the namespace tuple the same way MemoryService does — `[scope-values..., namespace]`
  // is too coarse for hosted stores so we stick to the (scope, namespace) tuple.
  const tuple = buildPruneNamespaceTuple(scope, namespace)

  try {
    const pruner = new MemoryPruner()
    const result = await pruner.prune(prunerStore, {
      namespace: tuple,
      maxEntries: policy?.maxEntries ?? 1000,
      ttlMs: policy?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    })
    if (result.expired > 0 || result.evicted > 0) {
      config.eventBus?.emit({
        type: 'memory:written',
        agentId,
        namespace,
        key: `pruner:sweep:${Date.now()}`,
        scopeKeys: getSafeScopeKeys(scope),
      })
    }
  } catch {
    // Pruner failures are non-fatal — memory hygiene must never abort a run.
  }
}

/**
 * Fire-and-forget {@link ConsolidationEngine} sweep (MC-02).
 *
 * Clusters semantically related entries in the agent's namespace and
 * summarises each cluster into a single summary record. Disabled unless
 * `memoryPolicy.consolidateFinalizer === true`. Failures are swallowed.
 */
export async function runConsolidateFinalizer(
  agentId: string,
  config: DzupAgentConfig,
): Promise<void> {
  const policy = config.memoryPolicy
  if (policy?.consolidateFinalizer !== true) return

  const memory = config.memory
  const namespace = config.memoryNamespace
  const scope = config.memoryScope
  if (!memory || !namespace || !scope) return

  const getStore = (memory as { getStore?: () => unknown }).getStore
  if (typeof getStore !== 'function') return

  let store: unknown
  try {
    store = getStore.call(memory)
  } catch {
    return
  }
  if (!isPrunerStore(store)) return

  const engine = new ConsolidationEngine({
    minClusterSize: policy.consolidateMinCluster ?? 3,
  })

  try {
    const result = await engine.consolidate(agentId, namespace, store as PrunerMemoryStore)
    if (result.summarized > 0) {
      config.eventBus?.emit({
        type: 'memory:written',
        agentId,
        namespace,
        key: `consolidation:sweep:${Date.now()}`,
        scopeKeys: getSafeScopeKeys(scope),
      })
    }
  } catch {
    // Consolidation failures are non-fatal.
  }
}

interface PrunerStoreLike {
  search: (
    namespace: string[],
    options?: { query?: string; limit?: number; offset?: number },
  ) => Promise<unknown>
  put: (
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
  ) => Promise<void>
  delete: (namespace: string[], key: string) => Promise<void>
}

function isPrunerStore(value: unknown): value is PrunerStoreLike {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['search'] === 'function' &&
    typeof v['put'] === 'function' &&
    typeof v['delete'] === 'function'
  )
}

/**
 * Construct the namespace tuple used by the pruner. Mirrors the
 * `[...scopeKeys, namespace]` convention favoured by `MemoryService`.
 */
function buildPruneNamespaceTuple(
  scope: Record<string, string>,
  namespace: string,
): string[] {
  const scopeValues = Object.values(scope)
  return scopeValues.length > 0 ? [...scopeValues, namespace] : [namespace]
}
