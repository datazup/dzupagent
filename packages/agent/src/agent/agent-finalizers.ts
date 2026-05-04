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
import { findWeakMemories } from '@dzupagent/memory'
import type { DecayMetadata } from '@dzupagent/memory'
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
  } catch {
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
