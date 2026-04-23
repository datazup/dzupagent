import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { estimateTokens, type RunJournalEntry } from '@dzupagent/core'
import type {
  CompressionLogEntry,
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import { createToolLoopLearningHook } from './tool-loop-learning.js'
import {
  estimateConversationTokensForMessages,
  extractFinalAiMessageContent,
} from './message-utils.js'
import { rehydrateMessagesFromJournal } from './resume-utils.js'
import { runToolLoop, type StopReason, type ToolStat } from './tool-loop.js'
import { ReflectionAnalyzer } from '../reflection/reflection-analyzer.js'
import { buildWorkflowEventsFromToolStats } from '../reflection/learning-bridge.js'

export interface PreparedRunState {
  maxIterations: number
  budget?: IterationBudget
  preparedMessages: BaseMessage[]
  tools: StructuredToolInterface[]
  toolMap: Map<string, StructuredToolInterface>
  model: BaseChatModel
  stuckDetector?: StuckDetector
  /**
   * Per-run memory frame snapshot captured during `prepareMessages`.
   * Threaded through the run state (instead of stored on the agent instance)
   * so concurrent `generate()`/`stream()` calls on the same agent cannot
   * clobber each other's frame reference.
   */
  memoryFrame?: unknown
}

interface PrepareRunStateParams {
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  messages: BaseMessage[]
  options?: GenerateOptions
  prepareMessages: (
    messages: BaseMessage[],
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
  getTools: () => StructuredToolInterface[]
  bindTools: (model: BaseChatModel, tools: StructuredToolInterface[]) => BaseChatModel
  runBeforeAgentHooks: () => Promise<void>
  /**
   * Optional journal used for resume rehydration. When `options._resume.lastStateSeq`
   * is set, the run engine will pull entries up to that seq and reconstruct the
   * message history instead of using `prepareMessages`' result.
   */
  journal?: { getAll: (runId: string) => Promise<RunJournalEntry[]> }
  /** Run id used to query the journal when resuming. */
  runId?: string
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
  maybeUpdateSummary: (messages: BaseMessage[], memoryFrame?: unknown) => Promise<void>
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

  const prepared = await params.prepareMessages(params.messages)
  const preparedMessages = prepared.messages
  const memoryFrame = prepared.memoryFrame

  // When resuming from a checkpoint, reconstruct message history from the journal
  // so the agent continues from the last committed step rather than re-executing.
  let finalMessages = preparedMessages
  const resumeSeq = params.options?._resume?.lastStateSeq
  if (resumeSeq !== undefined && params.journal != null && params.runId != null) {
    const allEntries = await params.journal.getAll(params.runId)
    const entriesUpToSeq = allEntries.filter((e) => e.seq <= resumeSeq)
    const startedEntry = allEntries.find((e) => e.type === 'run_started')
    const originalInput =
      startedEntry != null
        ? String((startedEntry.data as { input?: unknown }).input ?? '')
        : extractFirstHumanMessage(preparedMessages)
    const rehydrated = rehydrateMessagesFromJournal(entriesUpToSeq, originalInput)
    if (rehydrated.length > 0) {
      finalMessages = rehydrated
    }
  }

  const tools = params.getTools()
  const model = params.bindTools(params.resolvedModel, tools)

  // Charge the prompt-build phase to the token lifecycle plugin (if any)
  // so per-phase token breakdowns appear in lifecycle reports. This runs
  // AFTER prepareMessages/rehydration so it reflects the final transcript
  // that will be sent to the model.
  if (params.config.tokenLifecyclePlugin) {
    const promptTokens = estimateConversationTokensForMessages(finalMessages)
    params.config.tokenLifecyclePlugin.trackPhase('prompt', promptTokens)
  }

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
    preparedMessages: finalMessages,
    tools,
    toolMap: new Map(tools.map(tool => [tool.name, tool])),
    model,
    stuckDetector,
    memoryFrame,
  }
}

/**
 * Best-effort extraction of the first human-authored message content from a
 * prepared transcript. Used as a fallback when the journal lacks a
 * `run_started` entry during resume rehydration.
 */
function extractFirstHumanMessage(messages: BaseMessage[]): string {
  for (const m of messages) {
    const typed = m as { _getType?: () => string }
    if (typeof typed._getType === 'function' && typed._getType() === 'human') {
      return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }
  }
  return ''
}

export async function executeGenerateRun(
  params: ExecuteGenerateRunParams,
): Promise<GenerateResult> {
  // Accumulates compression events observed during the run. Surfaced back
  // to the caller via `GenerateResult.compressionLog` so telemetry/UIs can
  // inspect when (and by how much) the conversation was compacted.
  const compressionLog: CompressionLogEntry[] = []

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
      onToolResult: (_name, result) => {
        // Charge tool-result bytes against the token lifecycle plugin so
        // per-phase breakdowns reflect tool output ingestion separately
        // from LLM input/output.
        if (params.config.tokenLifecyclePlugin && result) {
          params.config.tokenLifecyclePlugin.trackPhase(
            'tool-result',
            estimateTokens(result),
          )
        }
      },
      onToolLatency: (name, durationMs, error) => {
        params.config.eventBus?.emit({
          type: 'tool:latency',
          toolName: name,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        })
      },
      shouldHalt: params.config.tokenLifecyclePlugin
        ? () => params.config.tokenLifecyclePlugin!.shouldHalt()
        : undefined,
      // Auto-compression — delegates to the token lifecycle plugin.
      // The plugin short-circuits internally when pressure is ok/warn;
      // actual compression only runs when pressure transitions to
      // critical or exhausted.
      maybeCompress: params.config.tokenLifecyclePlugin
        ? (messages) =>
            params.config.tokenLifecyclePlugin!.maybeCompress(
              messages,
              params.runState.model,
              null,
            )
        : undefined,
      // Persist each compression event to the run-scoped compressionLog so
      // callers can inspect when (and by how much) the history was compacted.
      // Only fires when `maybeCompress` returned `compressed: true`.
      onCompressed: (info) => {
        compressionLog.push({
          before: info.before,
          after: info.after,
          summary: info.summary,
          ts: Date.now(),
        })
      },
      // Note: run:halted:token-exhausted is emitted AFTER the loop
      // completes (below) so the iteration count is accurate.
    },
  )

  // Emit token-exhaustion telemetry as soon as the loop reports the
  // matching stop reason. This precedes agent:stop_reason so dashboards
  // can react to the halt before the generic stop event fires.
  if (result.stopReason === 'token_exhausted') {
    params.config.eventBus?.emit({
      type: 'run:halted:token-exhausted',
      agentId: params.agentId,
      iterations: result.llmCalls,
      reason: 'token_exhausted',
    })
  }

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

  await params.maybeUpdateSummary(result.messages, params.runState.memoryFrame)

  // --- Post-run reflection analysis (best-effort, non-fatal) ---
  if (params.config.onReflectionComplete) {
    try {
      const analyzer = new ReflectionAnalyzer(params.config.reflectionAnalyzerConfig)
      const events = buildWorkflowEventsFromToolStats(result.toolStats, result.stopReason)
      const summary = analyzer.analyze(
        params.agentId + ':' + Date.now().toString(36),
        events,
      )
      await params.config.onReflectionComplete(summary)
    } catch {
      // Reflection callback errors must NEVER affect the run result.
    }
  }

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
    // Surface the per-run memory frame for observability so callers (and the
    // public `RunResult` via `runInBackground`) can inspect which memory
    // context was attached to this run.
    memoryFrame: params.runState.memoryFrame,
    // Only expose the compression log when at least one compression event
    // fired; leave undefined otherwise to avoid cluttering result payloads
    // for runs that never compacted.
    ...(compressionLog.length > 0 ? { compressionLog } : {}),
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
