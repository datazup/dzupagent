import type { ToolMessage, BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  defaultLogger,
  type DzupEventBus,
  type FrameworkLogger,
  type RunJournalEntry,
  type SafetyMonitor,
  type ToolGovernance,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import {
  DEFAULT_GUARDED_MAX_ITERATIONS,
  DEFAULT_UNGUARDED_BUDGET,
  _warnedAgentIds,
} from './run-engine-defaults.js'
export {
  DEFAULT_UNGUARDED_BUDGET,
  DEFAULT_GUARDED_MAX_ITERATIONS,
} from './run-engine-defaults.js'
import { createToolLoopLearningHook } from './tool-loop-learning.js'
import {
  estimateConversationTokensForMessages,
} from './message-utils.js'
import { rehydrateMessagesFromJournal } from './resume-utils.js'
import {
  type StopReason,
  type ToolResultScanFailureMode,
  type ToolLoopTracer,
  type ToolStat,
} from './tool-loop.js'
import {
  type ToolArgValidatorConfig,
} from './tool-arg-validator.js'
import {
  extractInputMetadataKeys,
} from './tool-lifecycle-policy.js'
import {
  applyBudgetGate,
  buildSuccessResult,
  handleInvocationFailure,
  runToolStreamingPhase,
} from './run-engine-streaming-helpers.js'
import { ApprovalSuspendedError } from '../approval/approval-errors.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { injectPromptCacheMarkers } from '@dzupagent/context'
import {
  ContentScanner,
  PromptInjectionBlockedError,
  type PromptInjectionMode,
  type PiiMode,
} from '@dzupagent/security'
import { HumanMessage } from '@langchain/core/messages'
import {
  persistRunStateSnapshot,
  prepareGuardPrelude,
  resolveRunStateRunId,
  setupModelCall,
  processGeneratedRun,
} from './run-engine-generate-helpers.js'

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

export interface PrepareRunStateParams {
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

export interface ExecuteGenerateRunParams {
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
  scanFailureMode?: ToolResultScanFailureMode
  /**
   * RF-15 — prompt-injection scanning on tool results.
   *
   * When set, `ContentScanner` runs against every tool result *after* the
   * `safetyMonitor` pass. On `'block'`, the result is replaced with a
   * sanitised placeholder before reaching the model. On `'warn'`, matched
   * spans are rewritten and a `safety:violation` event is emitted.
   *
   * Independent of `safetyMonitor`: a tool result can be passed by the
   * monitor but still contain prompt-injection markers that this scanner
   * catches. Defaults to `undefined` (no scan), preserving legacy behaviour.
   */
  promptInjectionToolResults?: PromptInjectionMode
  /**
   * PII scanning on tool results — mirrors `promptInjectionToolResults` for PII.
   * When set, `ContentScanner` applies PII detection to every tool result.
   * On `'block'` a finding replaces the result with a redacted placeholder.
   * On `'redact'` PII spans are rewritten before the result reaches the model.
   * Defaults to `undefined` (no scan).
   */
  piiToolResults?: PiiMode
  tracer?: ToolLoopTracer
  agentId?: string
  runId?: string
  eventBus?: DzupEventBus
  signal?: AbortSignal
}

export async function prepareRunState(
  params: PrepareRunStateParams,
): Promise<PreparedRunState> {
  // RF-04 (SEC-08) — when the caller did not supply ANY guardrails, install a
  // default `IterationBudget` so a runaway loop cannot burn unbounded tokens.
  // Empty `guardrails: {}` is treated as an explicit opt-out (caller has made
  // an informed choice) and keeps the legacy unbounded behaviour.
  const hasExplicitGuardrails = params.config.guardrails !== undefined
  const logger: FrameworkLogger = (params.config as { logger?: FrameworkLogger }).logger
    ?? defaultLogger

  const maxIterations = params.options?.maxIterations
    ?? params.config.guardrails?.maxIterations
    ?? params.config.maxIterations
    ?? (hasExplicitGuardrails
      ? DEFAULT_GUARDED_MAX_ITERATIONS
      : DEFAULT_UNGUARDED_BUDGET.maxIterations)

  const budget = hasExplicitGuardrails
    ? new IterationBudget(params.config.guardrails!)
    : new IterationBudget({
        // Combined input + output cap honours `DEFAULT_UNGUARDED_BUDGET.inputTokens`
        // — input spend alone exhausts the budget at parity with the spec; the
        // semantic input/output split is preserved on the constant for callers
        // that introspect it.
        maxTokens: DEFAULT_UNGUARDED_BUDGET.inputTokens,
        maxIterations: DEFAULT_UNGUARDED_BUDGET.maxIterations,
      })

  // Emit a one-shot startup warning per agent id so operators notice the
  // fallback. Repeat `generate()` / `stream()` calls on the same agent stay
  // quiet to avoid log spam.
  if (!hasExplicitGuardrails && !_warnedAgentIds.has(params.config.id)) {
    _warnedAgentIds.add(params.config.id)
    logger.warn(
      'Agent constructed without explicit guardrails — applying default budget. Configure `config.guardrails` for production.',
      {
        agentId: params.config.id,
        defaultBudget: DEFAULT_UNGUARDED_BUDGET,
      },
    )
  }

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

  // OWASP-aligned content scan (audit MC-01 / AG-08 / AG-09).
  //
  // When `config.security.promptInjection` is `'warn'` or `'block'`, every
  // HumanMessage in the prepared transcript is scanned via
  // `@dzupagent/security`. A `'block'` verdict aborts the run with
  // `PromptInjectionBlockedError`; a `'sanitize'` verdict rewrites the
  // matched span(s) before they reach the model.
  finalMessages = await scanHumanMessages(
    finalMessages,
    params.config.security?.promptInjection,
    params.config.security?.pii,
    params.config.eventBus,
    params.config.id,
    params.runId,
  )

  // Inject Anthropic prompt-cache markers for Claude models (RF-13 / AG-12).
  // No-op for non-Claude model IDs and short prompts — safe for all providers.
  if (typeof params.config.model === 'string') {
    finalMessages = injectPromptCacheMarkers(finalMessages, params.config.model)
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

  return omitUndefined({
    maxIterations,
    budget,
    preparedMessages: finalMessages,
    tools,
    toolMap: new Map(tools.map(tool => [tool.name, tool])),
    model,
    stuckDetector,
    memoryFrame,
  })
}

/**
 * Scan every HumanMessage in `messages` for prompt-injection / PII content.
 *
 * - On `promptInjection === 'block'`: any finding raises
 *   {@link PromptInjectionBlockedError}.
 * - On `promptInjection === 'warn'`: matched spans are rewritten to
 *   `[REDACTED-INJECTION]` and the message content replaced.
 * - When `pii !== 'off'`, PII findings on incoming user input are also
 *   sanitized inline (the sanitize verdict from the scanner rewrites
 *   SSN/CC/IBAN/JWT/API-key matches with typed redaction markers).
 *
 * Returns a new message array; the original is left untouched. When no
 * scanning is configured the function is an O(n) pass-through.
 */
async function scanHumanMessages(
  messages: BaseMessage[],
  promptInjection: PromptInjectionMode | undefined,
  pii: PiiMode | undefined,
  eventBus: DzupEventBus | undefined,
  agentId: string,
  runId: string | undefined,
): Promise<BaseMessage[]> {
  const piMode: PromptInjectionMode = promptInjection ?? 'warn'
  const piiMode: PiiMode = pii ?? 'off'
  if (piMode === 'off' && piiMode === 'off') return messages

  const scanner = new ContentScanner({ promptInjection: piMode, pii: piiMode })
  const out: BaseMessage[] = []
  let changed = false
  for (const m of messages) {
    const typed = m as { _getType?: () => string }
    const isHuman = typeof typed._getType === 'function' && typed._getType() === 'human'
    if (!isHuman || typeof m.content !== 'string') {
      out.push(m)
      continue
    }
    const result = await scanner.scan(m.content)
    if (result.verdict === 'allow') {
      out.push(m)
      continue
    }
    eventBus?.emit({
      type: 'agent:context_fallback',
      agentId,
      ...(runId !== undefined ? { runId } : {}),
      reason: result.verdict === 'block' ? 'security:blocked' : 'security:sanitized',
      before: m.content.length,
      after: result.sanitized.length,
    })
    if (result.verdict === 'block') {
      throw new PromptInjectionBlockedError(result.findings)
    }
    changed = true
    out.push(new HumanMessage(result.sanitized))
  }
  return changed ? out : messages
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
  try {
    return await executeGenerateRunInner(params)
  } catch (err) {
    // Durable approval gate -- surface a `suspended` GenerateResult instead
    // of bubbling the error so the outer agent driver can return a clean
    // pause result. Other errors propagate unchanged.
    if (err instanceof ApprovalSuspendedError) {
      // MC-AGT-04 Phase 1 — record a snapshot at the suspension point so
      // resume can pick up from the last known message history.
      if (params.config.runStateStore) {
        const runStateRunId = resolveRunStateRunId(
          params.agentId,
          params.options,
          params.config.toolExecution?.runId,
        )
        const tenantId = params.config.memoryScope?.['tenantId']
        void persistRunStateSnapshot({
          store: params.config.runStateStore,
          runId: runStateRunId,
          agentId: params.agentId,
          ...(tenantId !== undefined ? { tenantId } : {}),
          iteration: 0,
          messages: params.runState.preparedMessages,
          cumulativeUsage: [],
          terminalReason: 'approval_pending',
        })
      }
      return {
        content: '',
        messages: params.runState.preparedMessages,
        usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 0 },
        hitIterationLimit: false,
        stopReason: 'approval_pending',
        toolStats: [],
        suspended: { runId: err.runId, resumeToken: err.resumeToken },
      }
    }
    // MC-AGT-04 Phase 1 — failed runs still get a final snapshot so
    // operators can inspect the last-known state when triaging errors.
    if (params.config.runStateStore) {
      const runStateRunId = resolveRunStateRunId(
        params.agentId,
        params.options,
        params.config.toolExecution?.runId,
      )
      const tenantId = params.config.memoryScope?.['tenantId']
      const reason = err instanceof Error ? err.message : String(err)
      void persistRunStateSnapshot({
        store: params.config.runStateStore,
        runId: runStateRunId,
        agentId: params.agentId,
        ...(tenantId !== undefined ? { tenantId } : {}),
        iteration: 0,
        messages: params.runState.preparedMessages,
        cumulativeUsage: [],
        terminalReason: `error: ${reason}`,
      })
    }
    throw err
  }
}

/**
 * RF-25 (CODE-17) — orchestrator that delegates to three phase helpers
 * in {@link ./run-engine-generate-helpers.js}:
 *
 *   1. {@link prepareGuardPrelude} — accumulator + tool-exec policy resolve.
 *   2. {@link setupModelCall}      — runs the tool loop with full telemetry.
 *   3. {@link processGeneratedRun} — post-run filter, summary, reflection,
 *      and final result assembly.
 *
 * Observable order (event-bus emissions, OTel spans, error rethrows) is
 * preserved across the extraction.
 */
async function executeGenerateRunInner(
  params: ExecuteGenerateRunParams,
): Promise<GenerateResult> {
  const prelude = prepareGuardPrelude(params.config)
  const result = await setupModelCall(params, prelude)
  return processGeneratedRun(params, result, prelude.compressionLog)
}


export async function applyOutputFilter(
  config: DzupAgentConfig,
  content: string,
): Promise<string> {
  if (!config.guardrails?.outputFilter || !content) {
    return content
  }

  const filtered = await config.guardrails.outputFilter(content)
  return filtered === null ? content : filtered
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
  /** Parent run cancellation signal; threaded to the per-tool invocation signal. */
  signal?: AbortSignal
  /**
   * MJ-AGENT-02 — optional public policy bundle. When present, the
   * streaming executor enforces the SAME governance, permission,
   * validation, timeout, safety, and tracing controls as the
   * non-streaming policy-enabled tool execution stage. When `undefined`,
   * the executor preserves the
   * pre-MJ-AGENT-02 "lite" surface (budget block + tool existence)
   * for backwards-compatible callers that didn't thread
   * `toolExecution` through DzupAgentConfig.
   */
  policy?: StreamingToolPolicyOptions
}): Promise<StreamingToolExecutionResult> {
  // RF-19 (CODE-02) — orchestrator. The 397-LOC body has been split into
  // five phase helpers in `./run-engine-streaming-helpers.ts` so each
  // phase can be unit-tested in isolation. Observable behaviour
  // (event-bus emissions, OTel span attributes, abort-signal threading,
  // error rethrows, stuck-detection ordering) is preserved exactly.
  const { toolCall, policy } = params
  const toolName = toolCall.name
  const toolCallId = toolCall.id ?? `call_${Date.now()}`
  const inputMetadataKeys = extractInputMetadataKeys(toolCall.args)

  // Phase 1 — pre-execution gate stack.
  const gate = applyBudgetGate(omitUndefined({
    toolCall,
    toolCallId,
    toolName,
    inputMetadataKeys,
    budget: params.budget,
    toolMap: params.toolMap,
    policy,
  }))
  if (gate.kind === 'short-circuit') {
    if (gate.throwError) throw gate.throwError
    return gate.result
  }

  const startMs = Date.now()

  try {
    // Phase 2 — validate, invoke, scan, emit lifecycle events.
    const phase = await runToolStreamingPhase(omitUndefined({
      toolCall,
      toolCallId,
      toolName,
      inputMetadataKeys,
      tool: gate.tool,
      transformToolResult: params.transformToolResult,
      statTracker: params.statTracker,
      onToolLatency: params.onToolLatency,
      signal: params.signal,
      policy,
      startMs,
    }))
    if (phase.kind === 'short-circuit') return phase.result

    // Phase 3 — assemble success result with stuck-detection nudge.
    return buildSuccessResult(omitUndefined({
      toolName,
      toolCallId,
      transformedResult: phase.transformedResult,
      validatedArgs: phase.validatedArgs,
      stuckDetector: params.stuckDetector,
      budget: params.budget,
    }))
  } catch (error: unknown) {
    // Phase 4 — error path: latency recording, tool:error emission,
    // and stuck-detection over the error message.
    return handleInvocationFailure(omitUndefined({
      error,
      toolName,
      toolCallId,
      inputMetadataKeys,
      startMs,
      statTracker: params.statTracker,
      onToolLatency: params.onToolLatency,
      stuckDetector: params.stuckDetector,
      policy,
    }))
  }
}
