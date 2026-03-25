import { ForgeAgent } from '@forgeagent/agent'
import { HumanMessage } from '@langchain/core/messages'
import type { RunExecutor, RunExecutorResult } from './run-worker.js'

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
  if (input == null) return ''
  return String(input)
}

export interface ForgeAgentRunExecutorOptions {
  fallback?: RunExecutor
}

function isStructuredResult(value: unknown): value is RunExecutorResult {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'output' in (value as Record<string, unknown>),
  )
}

/**
 * RunExecutor that executes runs through @forgeagent/agent ForgeAgent.
 */
export function createForgeAgentRunExecutor(
  options?: ForgeAgentRunExecutorOptions,
): RunExecutor {
  return async (ctx): Promise<RunExecutorResult> => {
    const prompt = toPrompt(ctx.input) || 'Proceed with the requested task.'

    try {
      const agent = new ForgeAgent({
        id: ctx.agent.id,
        name: ctx.agent.name,
        description: ctx.agent.description,
        instructions: ctx.agent.instructions,
        model: ctx.agent.modelTier as 'chat' | 'reasoning' | 'codegen' | 'embedding',
        registry: ctx.modelRegistry,
      })

      const chunks: string[] = []
      const logs: RunExecutorResult['logs'] = []
      let hitIterationLimit = false
      let lastFlushAt = 0

      for await (const event of agent.stream([new HumanMessage(prompt)])) {
        if (event.type === 'text') {
          const content = typeof event.data['content'] === 'string' ? event.data['content'] : ''
          if (content) {
            chunks.push(content)
            ctx.eventBus.emit({
              type: 'agent:stream_delta',
              agentId: ctx.agentId,
              runId: ctx.runId,
              content,
            })
            const now = Date.now()
            if (now - lastFlushAt > 250) {
              lastFlushAt = now
              await ctx.runStore.update(ctx.runId, {
                output: { message: chunks.join('') },
              })
            }
          }
          continue
        }

        if (event.type === 'tool_call') {
          const toolName = typeof event.data['name'] === 'string' ? event.data['name'] : 'unknown'
          const input = event.data['args']
          logs.push({
            level: 'info',
            phase: 'tool_call',
            message: `Tool called: ${toolName}`,
            data: { input },
          })
          ctx.eventBus.emit({
            type: 'tool:called',
            toolName,
            input: input ?? {},
          })
          continue
        }

        if (event.type === 'tool_result') {
          const toolName = typeof event.data['name'] === 'string' ? event.data['name'] : 'unknown'
          logs.push({
            level: 'info',
            phase: 'tool_result',
            message: `Tool result: ${toolName}`,
            data: { result: event.data['result'] },
          })
          ctx.eventBus.emit({
            type: 'tool:result',
            toolName,
            durationMs: 0,
          })
          continue
        }

        if (event.type === 'budget_warning') {
          const message = typeof event.data['message'] === 'string'
            ? event.data['message']
            : 'Budget warning'
          logs.push({
            level: 'warn',
            phase: 'budget',
            message,
          })
          continue
        }

        if (event.type === 'error') {
          const message = typeof event.data['message'] === 'string'
            ? event.data['message']
            : 'Unknown stream error'
          logs.push({
            level: 'error',
            phase: 'agent',
            message,
          })
          throw new Error(message)
        }

        if (event.type === 'done') {
          hitIterationLimit = Boolean(event.data['hitIterationLimit'])
          const doneContent = typeof event.data['content'] === 'string' ? event.data['content'] : ''
          if (doneContent && chunks.length === 0) {
            chunks.push(doneContent)
          }
        }
      }

      const content = chunks.join('')
      ctx.eventBus.emit({
        type: 'agent:stream_done',
        agentId: ctx.agentId,
        runId: ctx.runId,
        finalContent: content,
      })

      return {
        output: { message: content || '[empty response]' },
        metadata: {
          streamMode: true,
          chunkCount: chunks.length,
          hitIterationLimit,
        },
        logs,
      }
    } catch (error) {
      if (options?.fallback) {
        const fallbackResult = await options.fallback(ctx)
        if (isStructuredResult(fallbackResult)) {
          return {
            ...fallbackResult,
            metadata: {
              ...(fallbackResult.metadata ?? {}),
              fallbackUsed: true,
              fallbackReason: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return {
          output: fallbackResult,
          metadata: {
            fallbackUsed: true,
            fallbackReason: error instanceof Error ? error.message : String(error),
          },
        }
      }
      throw error
    }
  }
}
