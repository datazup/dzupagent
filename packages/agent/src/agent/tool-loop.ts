/**
 * ReAct-style tool calling loop.
 *
 * Iteratively invokes the LLM, executes any tool calls it returns,
 * appends tool results, and re-invokes until the LLM produces a
 * final text response (no tool calls) or limits are reached.
 */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { extractTokenUsage, type TokenUsage } from '@forgeagent/core'
import type { IterationBudget } from '../guardrails/iteration-budget.js'

interface ToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface ToolLoopConfig {
  maxIterations: number
  budget?: IterationBudget
  onUsage?: (usage: TokenUsage) => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (name: string, result: string) => void
  onBudgetWarning?: (message: string) => void
  invokeModel?: (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage>
  transformToolResult?: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  signal?: AbortSignal
}

export interface ToolLoopResult {
  messages: BaseMessage[]
  totalInputTokens: number
  totalOutputTokens: number
  llmCalls: number
  hitIterationLimit: boolean
}

/**
 * Run the ReAct tool-calling loop.
 *
 * @param model - LLM instance (should already have tools bound if applicable)
 * @param messages - Initial messages including system prompt
 * @param tools - Available tools (used for execution, not for binding)
 * @param config - Loop configuration
 */
export async function runToolLoop(
  model: BaseChatModel,
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
  config: ToolLoopConfig,
): Promise<ToolLoopResult> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const allMessages = [...messages]
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let llmCalls = 0
  let hitIterationLimit = false

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    // Check abort signal
    if (config.signal?.aborted) {
      break
    }

    // Check budget hard limits
    if (config.budget) {
      const check = config.budget.isExceeded()
      if (check.exceeded) {
        hitIterationLimit = true
        // Add a message explaining why we stopped
        allMessages.push(new AIMessage(
          `[Agent stopped: ${check.reason}]`,
        ))
        break
      }
    }

    // Record iteration in budget
    if (config.budget) {
      const warnings = config.budget.recordIteration()
      for (const w of warnings) {
        config.onBudgetWarning?.(w.message)
      }
    }

    // Invoke LLM
    const response = config.invokeModel
      ? await config.invokeModel(model, allMessages)
      : await model.invoke(allMessages)
    llmCalls++

    // Track usage
    const modelName = (model as BaseChatModel & { model?: string }).model
    const usage = extractTokenUsage(response, modelName)
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    config.onUsage?.(usage)

    // Record in budget
    if (config.budget) {
      const warnings = config.budget.recordUsage(usage)
      for (const w of warnings) {
        config.onBudgetWarning?.(w.message)
      }
    }

    allMessages.push(response)

    // Check for tool calls
    const ai = response as AIMessage
    const toolCalls = ai.tool_calls as ToolCall[] | undefined

    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls — this is the final response
      break
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      const toolName = tc.name
      const toolCallId = tc.id ?? `call_${Date.now()}`

      // Check if tool is blocked
      if (config.budget?.isToolBlocked(toolName)) {
        allMessages.push(new ToolMessage({
          content: `[Tool "${toolName}" is blocked by guardrails]`,
          tool_call_id: toolCallId,
          name: toolName,
        }))
        config.onToolResult?.(toolName, '[blocked]')
        continue
      }

      const tool = toolMap.get(toolName)
      if (!tool) {
        allMessages.push(new ToolMessage({
          content: `Error: Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
          tool_call_id: toolCallId,
          name: toolName,
        }))
        config.onToolResult?.(toolName, '[not found]')
        continue
      }

      config.onToolCall?.(toolName, tc.args)

      try {
        const result = await tool.invoke(tc.args)
        const rawResultStr = typeof result === 'string' ? result : JSON.stringify(result)
        const resultStr = config.transformToolResult
          ? await config.transformToolResult(toolName, tc.args, rawResultStr)
          : rawResultStr
        allMessages.push(new ToolMessage({
          content: resultStr,
          tool_call_id: toolCallId,
          name: toolName,
        }))
        config.onToolResult?.(toolName, resultStr)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        allMessages.push(new ToolMessage({
          content: `Error executing tool "${toolName}": ${errMsg}`,
          tool_call_id: toolCallId,
          name: toolName,
        }))
        config.onToolResult?.(toolName, `[error: ${errMsg}]`)
      }
    }

    // Check if this was the last allowed iteration
    if (iteration === config.maxIterations - 1) {
      hitIterationLimit = true
    }
  }

  return {
    messages: allMessages,
    totalInputTokens,
    totalOutputTokens,
    llmCalls,
    hitIterationLimit,
  }
}
