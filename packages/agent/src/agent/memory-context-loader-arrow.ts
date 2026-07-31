import type { BaseMessage } from '@langchain/core/messages'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import {
  type AgentMemoryContextLoaderConfig,
  type AgentMemoryService,
  type ArrowMemoryRuntime,
  type ResolvedArrowMemoryConfig,
} from './memory-context-loader-types.js'
import {
  computeMemoryBudget,
  safeNamespace,
} from './memory-context-loader-budget.js'

/**
 * The arrow path reads four members of the loader config. Declaring the whole
 * \`AgentMemoryContextLoaderConfig\` (14 members) forced every caller and test
 * double to satisfy ten fields this function never looks at.
 */
export type ArrowMemoryLoaderConfig = Pick<
  AgentMemoryContextLoaderConfig,
  | 'instructions'
  | 'estimateConversationTokens'
  | 'onFallback'
  | 'onFallbackDetail'
>

export interface ArrowMemoryRuntimeOptions {
  config: ArrowMemoryLoaderConfig
  loadArrowRuntime: () => Promise<ArrowMemoryRuntime>
}

export interface PreparedArrowMemoryFrame {
  runtime: ArrowMemoryRuntime
  frame: { numRows: number }
}

/** Export the current frame once so snapshot comparison and rendering share it. */
export async function exportArrowMemoryFrame(
  loadArrowRuntime: () => Promise<ArrowMemoryRuntime>,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
): Promise<PreparedArrowMemoryFrame> {
  const runtime = await loadArrowRuntime()
  const arrowExt = runtime.extendMemoryServiceWithArrow(
    memory as unknown as MemoryServiceLike,
  )
  const frame = (await arrowExt.exportFrame(namespace, scope)) as {
    numRows: number
  }
  return { runtime, frame }
}

export async function loadArrowMemoryContext(
  opts: ArrowMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  arrowCfg: ResolvedArrowMemoryConfig,
  prepared?: PreparedArrowMemoryFrame,
): Promise<{ context: string | null; frame: unknown }> {
  const { config, loadArrowRuntime } = opts

  const resolved = prepared ?? await exportArrowMemoryFrame(
    loadArrowRuntime,
    memory,
    namespace,
    scope,
  )
  const { frame } = resolved
  const {
    selectMemoriesByBudget,
    phaseWeightedSelection,
    FrameReader,
  } = resolved.runtime

  if (frame.numRows === 0) {
    return { context: null, frame }
  }

  const {
    memoryBudget,
    totalBudget,
    maxMemoryFraction,
    minResponseReserve,
    systemPromptTokens,
    conversationTokens,
  } = computeMemoryBudget({
    instructions: config.instructions,
    messages,
    arrowCfg,
    estimateConversationTokens: config.estimateConversationTokens,
  })

  if (memoryBudget <= 0) {
    const tokensBefore = systemPromptTokens + conversationTokens
    config.onFallback?.('budget_zero', tokensBefore, 0)
    config.onFallbackDetail?.({
      reason: 'memory_budget_zero',
      // detail uses only numeric estimates — no scope or record content.
      detail:
        `systemPromptTokens=${systemPromptTokens} ` +
        `conversationTokens=${conversationTokens} ` +
        `totalBudget=${totalBudget} ` +
        `minResponseReserve=${minResponseReserve} ` +
        `maxMemoryFraction=${maxMemoryFraction}`,
      namespace: safeNamespace(namespace),
      provider: 'arrow',
      tokensBefore,
      tokensAfter: 0,
    })
    return { context: null, frame }
  }

  const phase = arrowCfg.currentPhase
  const selected =
    phase && phase !== 'general'
      ? phaseWeightedSelection(frame, phase, memoryBudget)
      : selectMemoriesByBudget(frame, memoryBudget)

  if (selected.length === 0) {
    return { context: null, frame }
  }

  const reader = new FrameReader(frame)
  const allRecords = reader.toRecords()
  const lines: string[] = ['## Memory Context']

  for (const candidate of selected) {
    const record = allRecords[candidate.rowIndex]
    if (!record) {
      continue
    }

    const recordNamespace = record.meta.namespace || namespace
    const text =
      typeof record.value.text === 'string'
        ? record.value.text
        : JSON.stringify(record.value)
    lines.push(`- [${recordNamespace}] ${text}`)
  }

  return { context: lines.join('\n'), frame }
}
