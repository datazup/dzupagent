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

export interface ArrowMemoryRuntimeOptions {
  config: AgentMemoryContextLoaderConfig
  loadArrowRuntime: () => Promise<ArrowMemoryRuntime>
}

export async function loadArrowMemoryContext(
  opts: ArrowMemoryRuntimeOptions,
  memory: AgentMemoryService,
  namespace: string,
  scope: Record<string, string>,
  messages: BaseMessage[],
  arrowCfg: ResolvedArrowMemoryConfig,
): Promise<{ context: string | null; frame: unknown }> {
  const { config, loadArrowRuntime } = opts

  const {
    extendMemoryServiceWithArrow,
    selectMemoriesByBudget,
    phaseWeightedSelection,
    FrameReader,
  } = await loadArrowRuntime()

  const arrowExt = extendMemoryServiceWithArrow(
    memory as unknown as MemoryServiceLike,
  )
  const frame = (await arrowExt.exportFrame(namespace, scope)) as {
    numRows: number
  }

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
