import { invokeWithTimeout, type RunStore, type ModelRegistry } from '@forgeagent/core'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { RunExecutor } from './run-worker.js'

function toPrompt(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const direct = ['message', 'content', 'prompt']
      .map((key) => record[key])
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (direct) return direct
    return JSON.stringify(input, null, 2)
  }
  if (input === null || input === undefined) return ''
  return String(input)
}

function normalizeResponseContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>
          if (typeof record['text'] === 'string') return record['text']
        }
        return ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  if (content == null) return ''
  return String(content)
}

async function appendUsageLog(
  runStore: RunStore,
  runId: string,
  usage: { model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await runStore.addLog(runId, {
    level: 'info',
    phase: 'llm',
    message: 'LLM usage',
    data: usage,
  })
}

/**
 * Default run executor for queue workers.
 * Uses model registry when configured; otherwise returns deterministic fallback text.
 */
export function createDefaultRunExecutor(modelRegistry: ModelRegistry): RunExecutor {
  return async ({ input, agent, runId, runStore, metadata }) => {
    const prompt = toPrompt(input)

    if (!modelRegistry.isConfigured()) {
      return {
        message: prompt
          ? `[${agent.name}] ${prompt}`
          : `[${agent.name}] Run processed successfully`,
      }
    }

    // Use router-selected tier from metadata, fall back to agent tier, then 'chat'
    const rawTier = typeof metadata?.['modelTier'] === 'string'
      ? metadata['modelTier']
      : (agent.modelTier || 'chat')
    const tier = rawTier as 'chat' | 'reasoning' | 'codegen' | 'embedding'
    const { model, provider } = modelRegistry.getModelWithFallback(tier, { streaming: false })
    await runStore.addLog(runId, {
      level: 'info',
      phase: 'llm',
      message: 'Invoking model',
      data: { provider },
    })

    try {
      const response = await invokeWithTimeout(
        model,
        [
          new SystemMessage(agent.instructions),
          new HumanMessage(prompt || 'Proceed with the requested task.'),
        ],
        {
          onUsage: (usage) => {
            void appendUsageLog(runStore, runId, usage)
          },
          trackingContext: `run:${runId}`,
        },
      )
      modelRegistry.recordProviderSuccess(provider)

      const message = normalizeResponseContent(response.content)
      return {
        message: message || '[empty model response]',
        provider,
      }
    } catch (error) {
      if (error instanceof Error) {
        modelRegistry.recordProviderFailure(provider, error)
      }
      throw error
    }
  }
}
