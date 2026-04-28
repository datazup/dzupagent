import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  calculateCostCents,
  estimateTokens,
  ForgeError,
  type DzupEventBus,
  type RunJournalEntry,
  type SafetyMonitor,
  type ToolGovernance,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
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
import {
  runToolLoop,
  type StopReason,
  type ToolLoopTracer,
  type ToolStat,
} from './tool-loop.js'
import {
  type ToolArgValidatorConfig,
} from './tool-arg-validator.js'
import {
  emitToolCalled,
  emitToolError,
  emitToolResult,
  extractInputMetadataKeys,
  invokeWithOptionalTimeout,
  maybeValidateArgs,
  resolveValidatorConfig,
  statusFromError,
} from './tool-lifecycle-policy.js'
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
  approvalPending?: boolean
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

/**
 * MJ-AGENT-02 — public policy bundle threaded by `streamRun()` into
 * {@link executeStreamingToolCall} so the native streaming branch
 * enforces the same governance / permission / validation / timeout /
 * safety stack as the sequential `tool-loop.ts` path. Each field is
 * optional; omitting all of them preserves the pre-MJ-AGENT-02
 * "lite" behaviour (budget block + tool existence only) for callers
 * that did not opt in via `DzupAgentConfig.toolExecution`.
 */
export interface StreamingToolPolicyOptions {
  toolGovernance?: ToolGovernance
  toolPermissionPolicy?: ToolPermissionPolicy
  validateToolArgs?: boolean | ToolArgValidatorConfig
  toolTimeouts?: Record<string, number>
  safetyMonitor?: SafetyMonitor
  scanToolResults?: boolean
  tracer?: ToolLoopTracer
  agentId?: string
  runId?: string
  eventBus?: DzupEventBus
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

  // MJ-AGENT-01 — extract the optional public tool-execution policy bundle
  // and resolve it into the corresponding ToolLoopConfig fields. Each
  // field is optional; omitting any of them preserves pre-MJ-AGENT-01
  // behaviour. `toolExecution.agentId` falls back to the agent's own id
  // so callers don't have to repeat it. `safetyMonitor` takes precedence
  // over the public-surface alias `resultScanner`.
  const toolExec = params.config.toolExecution
  const resolvedSafetyMonitor =
    toolExec?.safetyMonitor ?? toolExec?.resultScanner

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
      // MJ-AGENT-01 — public tool-execution policy surface. Each field is
      // forwarded only when present so the resulting ToolLoopConfig stays
      // identical to the pre-MJ-AGENT-01 shape when `toolExecution` is
      // unset (backwards compatibility guarantee).
      ...(toolExec?.governance !== undefined
        ? { toolGovernance: toolExec.governance }
        : {}),
      ...(resolvedSafetyMonitor !== undefined
        ? { safetyMonitor: resolvedSafetyMonitor }
        : {}),
      ...(toolExec?.scanToolResults !== undefined
        ? { scanToolResults: toolExec.scanToolResults }
        : {}),
      ...(toolExec?.timeouts !== undefined
        ? { toolTimeouts: toolExec.timeouts }
        : {}),
      ...(toolExec?.tracer !== undefined
        ? { tracer: toolExec.tracer }
        : {}),
      // agentId: fall back to the agent's own id ONLY when toolExecution
      // is provided, so the pre-MJ-AGENT-01 surface (no toolExecution) is
      // bit-for-bit identical to the previous behaviour. When threaded,
      // the loop tags canonical lifecycle events (`tool:called`,
      // `tool:result`, `tool:error`) with provenance and feeds permission
      // policies with the caller id.
      ...(toolExec
        ? { agentId: toolExec.agentId ?? params.agentId }
        : {}),
      ...(toolExec?.runId !== undefined ? { runId: toolExec.runId } : {}),
      ...(toolExec?.argumentValidator !== undefined
        ? { validateToolArgs: toolExec.argumentValidator }
        : {}),
      ...(toolExec?.permissionPolicy !== undefined
        ? { toolPermissionPolicy: toolExec.permissionPolicy }
        : {}),
      // Forward the agent's eventBus to the loop ONLY when toolExecution
      // is configured. Without `toolExecution`, the loop continues to
      // operate without lifecycle telemetry — matching pre-MJ-AGENT-01
      // behaviour exactly. With `toolExecution`, downstream policy events
      // (e.g. `approval:requested`) and canonical lifecycle events are
      // routed to the same bus the agent already uses for `llm:invoked`,
      // `tool:latency`, etc.
      ...(toolExec && params.config.eventBus !== undefined
        ? { eventBus: params.config.eventBus }
        : {}),
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
        // Compliance / audit — ISO/IEC 42001 traceability: every LLM
        // invocation must be recorded in the audit store. The event bus
        // listener in ComplianceAuditLogger picks this up automatically.
        params.config.eventBus?.emit({
          type: 'llm:invoked',
          agentId: params.agentId,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costCents: calculateCostCents(usage),
          timestamp: Date.now(),
        })
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

// ---------- Streaming policy stack helpers (MJ-AGENT-02) ----------

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
  /**
   * MJ-AGENT-02 — optional public policy bundle. When present, the
   * streaming executor enforces the SAME governance, permission,
   * validation, timeout, safety, and tracing controls as the
   * sequential tool-loop path (`executeSingleToolCall` in
   * `tool-loop.ts`). When `undefined`, the executor preserves the
   * pre-MJ-AGENT-02 "lite" surface (budget block + tool existence)
   * for backwards-compatible callers that didn't thread
   * `toolExecution` through DzupAgentConfig.
   */
  policy?: StreamingToolPolicyOptions
}): Promise<StreamingToolExecutionResult> {
  const { toolCall, policy } = params
  const toolName = toolCall.name
  const toolCallId = toolCall.id ?? `call_${Date.now()}`
  const inputMetadataKeys = extractInputMetadataKeys(toolCall.args)

  // Permission policy check (MC-GA03 / mirrors tool-loop.ts ~937-955).
  // Throws TOOL_PERMISSION_DENIED so the streaming bridge can surface
  // an `error` event followed by `done` (stopReason='aborted') —
  // matching the non-streaming path's observable surface exactly.
  if (policy?.toolPermissionPolicy && policy.agentId) {
    if (!policy.toolPermissionPolicy.hasPermission(policy.agentId, toolName)) {
      emitToolError(policy, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: `Tool "${toolName}" is not accessible to agent "${policy.agentId}"`,
        status: 'denied',
      })
      throw new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${toolName}" is not accessible to agent "${policy.agentId}"`,
        context: { agentId: policy.agentId, toolName },
      })
    }
  }

  if (params.budget?.isToolBlocked(toolName)) {
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_PERMISSION_DENIED',
      errorMessage: `Tool "${toolName}" is blocked by guardrails`,
      status: 'denied',
    })
    return {
      message: new ToolMessage({
        content: `[Tool "${toolName}" is blocked by guardrails]`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: '[blocked]',
    }
  }

  // Tool governance access check (mirrors tool-loop.ts ~980-1001).
  // A blocked tool yields `[blocked: <reason>]` in the streaming
  // surface so consumers can render the same denial reason as
  // generate() mode.
  if (policy?.toolGovernance) {
    const access = policy.toolGovernance.checkAccess(toolName, toolCall.args)
    if (!access.allowed) {
      const reason = access.reason ?? 'Tool access denied'
      emitToolError(policy, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: reason,
        status: 'denied',
      })
      return {
        message: new ToolMessage({
          content: `[blocked] ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: `[blocked: ${reason}]`,
      }
    }
    if (access.requiresApproval) {
      const correlationId = policy.runId ?? toolCallId
      try {
        policy.eventBus?.emit({
          type: 'approval:requested',
          runId: correlationId,
          plan: { toolName, args: toolCall.args },
        } as never)
      } catch {
        // Non-fatal: event emission must not abort the run.
      }
      const reason = access.reason ?? 'Approval required'
      return {
        message: new ToolMessage({
          content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: `[approval_pending: ${reason}]`,
        approvalPending: true,
      }
    }
  }

  const tool = params.toolMap.get(toolName)
  if (!tool) {
    return {
      message: new ToolMessage({
        content: `Error: Tool "${toolName}" not found. Available tools: ${[...params.toolMap.keys()].join(', ')}`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: '[not found]',
    }
  }

  // Argument validation (mirrors tool-loop.ts ~1056-1078). Failures
  // surface a `[validation error]` marker so the streaming bridge
  // emits the same downstream signal as the non-streaming executor.
  const validatorCfg = resolveValidatorConfig(policy?.validateToolArgs)
  const { args: validatedArgs, validationError } = maybeValidateArgs(
    toolCall,
    tool,
    validatorCfg,
  )

  if (validationError) {
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: validationError,
      status: 'error',
    })
    return {
      message: new ToolMessage({
        content: validationError,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: '[validation error]',
    }
  }

  const validatedKeys = extractInputMetadataKeys(validatedArgs)

  emitToolCalled(policy, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  })

  // Optional OTel span per tool invocation (mirrors tool-loop.ts ~1106).
  const inputSize = JSON.stringify(validatedArgs).length
  const span = policy?.tracer?.startToolSpan(toolName, { inputSize })

  const startMs = Date.now()
  let errorMsg: string | undefined

  try {
    const result = await invokeWithOptionalTimeout(
      toolName,
      policy?.toolTimeouts?.[toolName],
      () => tool.invoke(validatedArgs),
    )
    const rawResult = typeof result === 'string' ? result : JSON.stringify(result)
    let transformedResult = await params.transformToolResult(
      toolName,
      validatedArgs,
      rawResult,
    )

    // Safety scan (mirrors tool-loop.ts ~1119-1170). Critical
    // violations REPLACE the output with `[blocked: unsafe tool
    // output]` before reaching the model and before the streaming
    // `tool_result` event fires.
    if (policy?.safetyMonitor && policy.scanToolResults !== false) {
      try {
        const violations = policy.safetyMonitor.scanContent(transformedResult, {
          source: 'tool:result',
          toolName,
        })
        const hardBlock = violations.find(
          (v) => v.action === 'block' || v.action === 'kill' || v.severity === 'critical',
        )
        if (hardBlock) {
          const blockedContent = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`
          transformedResult = blockedContent
          const durationMs = Date.now() - startMs
          params.statTracker.record(toolName, durationMs)
          params.onToolLatency?.(toolName, durationMs, 'unsafe-result')
          emitToolError(policy, {
            toolName,
            toolCallId,
            durationMs,
            inputMetadataKeys: validatedKeys,
            errorCode: 'TOOL_EXECUTION_FAILED',
            errorMessage: `Tool result blocked: ${hardBlock.category} — ${hardBlock.message}`,
            status: 'denied',
          })
          if (span) {
            try {
              span.setAttribute('durationMs', durationMs)
              span.setAttribute('outputSize', blockedContent.length)
              span.setAttribute('blocked', true)
              span.end()
            } catch {
              // Tracer failures must not abort the streaming loop
            }
          }
          return {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: '[blocked: unsafe tool output]',
          }
        }
      } catch {
        // Non-fatal: safety scan failure must not abort the run
      }
    }

    const durationMs = Date.now() - startMs
    params.statTracker.record(toolName, durationMs)
    params.onToolLatency?.(toolName, durationMs)

    emitToolResult(policy, {
      toolName,
      toolCallId,
      durationMs,
      inputMetadataKeys: validatedKeys,
      output: transformedResult,
    })
    if (span) {
      try {
        span.setAttribute('durationMs', durationMs)
        span.setAttribute('outputSize', transformedResult.length)
        span.end()
      } catch {
        // Tracer failures must not abort the streaming loop
      }
    }

    const stuckCheck = params.stuckDetector?.recordToolCall(toolName, validatedArgs)
    if (stuckCheck?.stuck) {
      const reason = stuckCheck.reason ?? 'Unknown stuck condition'
      const recovery = `Tool "${toolName}" has been blocked. Try a different approach.`
      params.budget?.blockTool(toolName)
      return {
        message: new ToolMessage({
          content: transformedResult,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: transformedResult,
        stuckReason: reason,
        stuckRecovery: recovery,
        repeatedTool: toolName,
        stuckNudge: new ToolMessage({
          content: `[Agent appears stuck: ${reason}. ${recovery}]`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      }
    }

    return {
      message: new ToolMessage({
        content: transformedResult,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: transformedResult,
    }
  } catch (error: unknown) {
    errorMsg = error instanceof Error ? error.message : String(error)
    const durationMs = Date.now() - startMs
    params.statTracker.record(toolName, durationMs, errorMsg)
    params.onToolLatency?.(toolName, durationMs, errorMsg)

    const lifecycleStatus = statusFromError(error)
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs,
      inputMetadataKeys: validatedKeys,
      errorCode: lifecycleStatus === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_FAILED',
      errorMessage: errorMsg,
      status: lifecycleStatus,
    })
    if (span) {
      try {
        span.setAttribute('durationMs', durationMs)
        policy?.tracer?.endSpanWithError(span, error)
      } catch {
        // Tracer failures must not abort the streaming loop
      }
    }

    const stuckCheck = params.stuckDetector?.recordError(new Error(errorMsg))
    const reason = stuckCheck?.stuck
      ? (stuckCheck.reason ?? 'Unknown stuck condition')
      : undefined
    const recovery = reason ? 'Stopping due to repeated errors.' : undefined

    return {
      message: new ToolMessage({
        content: `Error executing tool "${toolName}": ${errorMsg}`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
      eventResult: `[error: ${errorMsg}]`,
      stuckReason: reason,
      stuckRecovery: recovery,
      repeatedTool: reason ? toolName : undefined,
      shouldStop: reason !== undefined,
    }
  }
}
