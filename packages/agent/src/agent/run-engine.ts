import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import { createToolLoopLearningHook } from './tool-loop-learning.js'
import { extractFinalAiMessageContent } from './message-utils.js'
import { runToolLoop, type StopReason, type ToolStat } from './tool-loop.js'

export interface PreparedRunState {
  maxIterations: number
  budget?: IterationBudget
  preparedMessages: BaseMessage[]
  tools: StructuredToolInterface[]
  toolMap: Map<string, StructuredToolInterface>
  model: BaseChatModel
  stuckDetector?: StuckDetector
}

interface PrepareRunStateParams {
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  messages: BaseMessage[]
  options?: GenerateOptions
  prepareMessages: (messages: BaseMessage[]) => Promise<BaseMessage[]>
  getTools: () => StructuredToolInterface[]
  bindTools: (model: BaseChatModel, tools: StructuredToolInterface[]) => BaseChatModel
  runBeforeAgentHooks: () => Promise<void>
}

interface ExecuteGenerateRunParams {
  agentId: string
  config: DzupAgentConfig
  options?: GenerateOptions
  runState: PreparedRunState
  invokeModel: (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage>
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  maybeUpdateSummary: (messages: BaseMessage[]) => Promise<void>
}

interface StreamingToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface StreamingToolExecutionResult {
  message: ToolMessage
  eventResult: string
  stuckReason?: string
  stuckRecovery?: string
  repeatedTool?: string
  shouldStop?: boolean
  stuckNudge?: ToolMessage
}

export interface ToolStatTracker {
  record: (name: string, durationMs: number, error?: string) => void
  toArray: () => ToolStat[]
}

export async function prepareRunState(
  params: PrepareRunStateParams,
): Promise<PreparedRunState> {
  const maxIterations = params.options?.maxIterations
    ?? params.config.guardrails?.maxIterations
    ?? params.config.maxIterations
    ?? 10

  const budget = params.config.guardrails
    ? new IterationBudget(params.config.guardrails)
    : undefined

  const preparedMessages = await params.prepareMessages(params.messages)
  const tools = params.getTools()
  const model = params.bindTools(params.resolvedModel, tools)

  await params.runBeforeAgentHooks()

  const stuckDetector = params.config.guardrails?.stuckDetector === false
    ? undefined
    : new StuckDetector(
        typeof params.config.guardrails?.stuckDetector === 'object'
          ? params.config.guardrails.stuckDetector
          : undefined,
      )

  const learningHook = createToolLoopLearningHook(params.config.selfLearning)
  if (learningHook) {
    await learningHook.loadSpecialistConfig().catch(() => { /* non-fatal */ })
  }

  return {
    maxIterations,
    budget,
    preparedMessages,
    tools,
    toolMap: new Map(tools.map(tool => [tool.name, tool])),
    model,
    stuckDetector,
  }
}

export async function executeGenerateRun(
  params: ExecuteGenerateRunParams,
): Promise<GenerateResult> {
  const result = await runToolLoop(
    params.runState.model,
    params.runState.preparedMessages,
    params.runState.tools,
    {
      maxIterations: params.runState.maxIterations,
      budget: params.runState.budget,
      signal: params.options?.signal,
      stuckDetector: params.runState.stuckDetector,
      toolStatsTracker: params.config.toolStatsTracker,
      intent: params.options?.intent,
      onStuckDetected: (reason, recovery) => {
        params.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: params.agentId,
          reason,
          recovery,
          timestamp: Date.now(),
        })
      },
      onStuck: (toolName, stage) => {
        params.config.eventBus?.emit({
          type: 'agent:stuck_detected',
          agentId: params.agentId,
          reason: `Stuck on tool "${toolName}" (escalation stage ${stage})`,
          recovery: stage >= 3 ? 'Aborting loop' : stage === 2 ? 'Nudge injected' : 'Tool blocked',
          timestamp: Date.now(),
        })
      },
      invokeModel: (model, messages) => params.invokeModel(model, messages),
      transformToolResult: (name, input, result) =>
        params.transformToolResult(name, input, result),
      onUsage: (usage) => {
        params.options?.onUsage?.(usage)
      },
      onToolLatency: (name, durationMs, error) => {
        params.config.eventBus?.emit({
          type: 'tool:latency',
          toolName: name,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        })
      },
    },
  )

  emitStopReasonTelemetry(params.config, params.agentId, {
    stopReason: result.stopReason,
    llmCalls: result.llmCalls,
    toolStats: result.toolStats,
  })

  let content = extractFinalAiMessageContent(result.messages)
  if (params.config.guardrails?.outputFilter && content) {
    const filtered = await params.config.guardrails.outputFilter(content)
    if (filtered !== null) {
      content = filtered
    }
  }

  await params.maybeUpdateSummary(result.messages)

  return {
    content,
    messages: result.messages,
    usage: {
      totalInputTokens: result.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens,
      llmCalls: result.llmCalls,
    },
    hitIterationLimit: result.hitIterationLimit,
    stopReason: result.stopReason,
    toolStats: result.toolStats,
    stuckError: result.stuckError,
  }
}

export function emitStopReasonTelemetry(
  config: Pick<DzupAgentConfig, 'eventBus'>,
  agentId: string,
  payload: {
    stopReason: StopReason
    llmCalls: number
    toolStats: ToolStat[]
  },
): void {
  config.eventBus?.emit({
    type: 'agent:stop_reason',
    agentId,
    reason: payload.stopReason,
    iterations: payload.llmCalls,
    toolStats: payload.toolStats,
  })
}

export function createToolStatTracker(): ToolStatTracker {
  const statMap = new Map<string, { calls: number; errors: number; totalMs: number }>()

  return {
    record(name, durationMs, error) {
      const current = statMap.get(name) ?? { calls: 0, errors: 0, totalMs: 0 }
      current.calls += 1
      current.totalMs += durationMs
      if (error !== undefined) {
        current.errors += 1
      }
      statMap.set(name, current)
    },
    toArray() {
      return [...statMap.entries()].map(([name, stat]) => ({
        name,
        calls: stat.calls,
        errors: stat.errors,
        totalMs: stat.totalMs,
        avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
      }))
    },
  }
}

export async function executeStreamingToolCall(params: {
  toolCall: StreamingToolCall
  toolMap: Map<string, StructuredToolInterface>
  budget?: IterationBudget
  stuckDetector?: StuckDetector
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  statTracker: ToolStatTracker
}): Promise<StreamingToolExecutionResult> {
  const { toolCall } = params
  const toolCallId = toolCall.id ?? `call_${Date.now()}`

  if (params.budget?.isToolBlocked(toolCall.name)) {
    return {
      message: new ToolMessage({
        content: `[Tool "${toolCall.name}" is blocked by guardrails]`,
        tool_call_id: toolCallId,
        name: toolCall.name,
      }),
      eventResult: '[blocked]',
    }
  }

  const tool = params.toolMap.get(toolCall.name)
  if (!tool) {
    return {
      message: new ToolMessage({
        content: `Error: Tool "${toolCall.name}" not found. Available tools: ${[...params.toolMap.keys()].join(', ')}`,
        tool_call_id: toolCallId,
        name: toolCall.name,
      }),
      eventResult: '[not found]',
    }
  }

  const startMs = Date.now()
  let errorMsg: string | undefined

  try {
    const result = await tool.invoke(toolCall.args)
    const rawResult = typeof result === 'string' ? result : JSON.stringify(result)
    const transformedResult = await params.transformToolResult(
      toolCall.name,
      toolCall.args,
      rawResult,
    )
    const durationMs = Date.now() - startMs
    params.statTracker.record(toolCall.name, durationMs)
    params.onToolLatency?.(toolCall.name, durationMs)

    const stuckCheck = params.stuckDetector?.recordToolCall(toolCall.name, toolCall.args)
    if (stuckCheck?.stuck) {
      const reason = stuckCheck.reason ?? 'Unknown stuck condition'
      const recovery = `Tool "${toolCall.name}" has been blocked. Try a different approach.`
      params.budget?.blockTool(toolCall.name)
      return {
        message: new ToolMessage({
          content: transformedResult,
          tool_call_id: toolCallId,
          name: toolCall.name,
        }),
        eventResult: transformedResult,
        stuckReason: reason,
        stuckRecovery: recovery,
        repeatedTool: toolCall.name,
        stuckNudge: new ToolMessage({
          content: `[Agent appears stuck: ${reason}. ${recovery}]`,
          tool_call_id: toolCallId,
          name: toolCall.name,
        }),
      }
    }

    return {
      message: new ToolMessage({
        content: transformedResult,
        tool_call_id: toolCallId,
        name: toolCall.name,
      }),
      eventResult: transformedResult,
    }
  } catch (error: unknown) {
    errorMsg = error instanceof Error ? error.message : String(error)
    const durationMs = Date.now() - startMs
    params.statTracker.record(toolCall.name, durationMs, errorMsg)
    params.onToolLatency?.(toolCall.name, durationMs, errorMsg)

    const stuckCheck = params.stuckDetector?.recordError(new Error(errorMsg))
    const reason = stuckCheck?.stuck
      ? (stuckCheck.reason ?? 'Unknown stuck condition')
      : undefined
    const recovery = reason ? 'Stopping due to repeated errors.' : undefined

    return {
      message: new ToolMessage({
        content: `Error executing tool "${toolCall.name}": ${errorMsg}`,
        tool_call_id: toolCallId,
        name: toolCall.name,
      }),
      eventResult: `[error: ${errorMsg}]`,
      stuckReason: reason,
      stuckRecovery: recovery,
      repeatedTool: reason ? toolCall.name : undefined,
      shouldStop: reason !== undefined,
    }
  }
}
