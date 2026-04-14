import type { BaseMessage } from '@langchain/core/messages'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import { estimateTokens } from '@dzupagent/core'

import type { DzupAgentConfig } from './agent-types.js'
import { resolveArrowMemoryConfig } from './memory-profiles.js'

type AgentMemoryService = NonNullable<DzupAgentConfig['memory']>
type ResolvedArrowMemoryConfig = NonNullable<ReturnType<typeof resolveArrowMemoryConfig>>

interface ArrowMemoryRecord {
  value: Record<string, unknown>
  meta: {
    namespace?: string
  }
}

export interface ArrowMemoryRuntime {
  extendMemoryServiceWithArrow: (
    memory: MemoryServiceLike,
  ) => {
    exportFrame: (
      namespace: string,
      scope: Record<string, string>,
    ) => Promise<unknown>
  }
  selectMemoriesByBudget: (
    frame: unknown,
    memoryBudget: number,
  ) => Array<{ rowIndex: number }>
  phaseWeightedSelection: (
    frame: unknown,
    phase: NonNullable<ResolvedArrowMemoryConfig['currentPhase']>,
    memoryBudget: number,
  ) => Array<{ rowIndex: number }>
  FrameReader: new (frame: unknown) => {
    toRecords(): ArrowMemoryRecord[]
  }
}

export interface AgentMemoryContextLoaderConfig {
  instructions: string
  memory?: DzupAgentConfig['memory']
  memoryNamespace?: string
  memoryScope?: Record<string, string>
  arrowMemory?: DzupAgentConfig['arrowMemory']
  memoryProfile?: DzupAgentConfig['memoryProfile']
  estimateConversationTokens: (messages: BaseMessage[]) => number
  loadArrowRuntime?: () => Promise<ArrowMemoryRuntime>
}

async function loadArrowRuntime(): Promise<ArrowMemoryRuntime> {
  return await import('@dzupagent/memory-ipc') as unknown as ArrowMemoryRuntime
}

export class AgentMemoryContextLoader {
  private readonly loadArrowRuntime: () => Promise<ArrowMemoryRuntime>

  constructor(private readonly config: AgentMemoryContextLoaderConfig) {
    this.loadArrowRuntime = config.loadArrowRuntime ?? loadArrowRuntime
  }

  async load(messages: BaseMessage[]): Promise<string | null> {
    const memory = this.config.memory
    const scope = this.config.memoryScope
    const namespace = this.config.memoryNamespace

    if (!memory || !scope || !namespace) {
      return null
    }

    const resolvedArrowConfig = resolveArrowMemoryConfig(
      this.config.arrowMemory,
      this.config.memoryProfile,
    )

    if (resolvedArrowConfig) {
      try {
        return await this.loadArrowMemoryContext(
          memory,
          namespace,
          scope,
          messages,
          resolvedArrowConfig,
        )
      } catch {
        // Fall back to the standard path if Arrow selection fails.
      }
    }

    const records = await memory.get(namespace, scope)
    return memory.formatForPrompt(records) || null
  }

  private async loadArrowMemoryContext(
    memory: AgentMemoryService,
    namespace: string,
    scope: Record<string, string>,
    messages: BaseMessage[],
    arrowCfg: ResolvedArrowMemoryConfig,
  ): Promise<string | null> {
    const {
      extendMemoryServiceWithArrow,
      selectMemoriesByBudget,
      phaseWeightedSelection,
      FrameReader,
    } = await this.loadArrowRuntime()

    const arrowExt = extendMemoryServiceWithArrow(
      memory as unknown as MemoryServiceLike,
    )
    const frame = await arrowExt.exportFrame(namespace, scope) as { numRows: number }

    if (frame.numRows === 0) {
      return null
    }

    const totalBudget = arrowCfg.totalBudget ?? 128_000
    const maxMemoryFraction = arrowCfg.maxMemoryFraction ?? 0.3
    const minResponseReserve = arrowCfg.minResponseReserve ?? 4_000
    const systemPromptTokens = estimateTokens(this.config.instructions)
    const conversationTokens = this.config.estimateConversationTokens(messages)
    const remaining = totalBudget - systemPromptTokens - conversationTokens - minResponseReserve
    const memoryBudget = Math.max(0, Math.min(
      Math.floor(remaining),
      Math.floor(totalBudget * maxMemoryFraction),
    ))

    if (memoryBudget <= 0) {
      return null
    }

    const phase = arrowCfg.currentPhase
    const selected = phase && phase !== 'general'
      ? phaseWeightedSelection(frame, phase, memoryBudget)
      : selectMemoriesByBudget(frame, memoryBudget)

    if (selected.length === 0) {
      return null
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
      const text = typeof record.value.text === 'string'
        ? record.value.text
        : JSON.stringify(record.value)
      lines.push(`- [${recordNamespace}] ${text}`)
    }

    return lines.join('\n')
  }
}
