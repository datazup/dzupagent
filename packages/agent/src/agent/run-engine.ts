import type { BaseMessage } from '@langchain/core/messages'
import type { DzupEventBus } from '@dzupagent/core/events'
import { defaultLogger, type FrameworkLogger } from '@dzupagent/core/utils'
import type {
  DzupAgentConfig,
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
  type ToolStat,
} from './tool-loop.js'
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
import {
  injectPromptCacheMarkers,
  injectPromptCacheMarkersForModel,
} from '@dzupagent/context'
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
import type {
  StreamingToolExecutionResult,
  ToolStatTracker,
} from './streaming-tool-types.js'
import type {
  ExecuteStreamingToolCallParams,
  ExecuteGenerateRunParams,
  PreparedRunState,
  PrepareRunStateParams,
} from './run-engine/types.js'

export type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from './streaming-tool-types.js'
export type * from './run-engine/types.js'

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

  // Inject Anthropic prompt-cache markers for Claude models (RF-13 / AG-12 / REC-H-10).
  // No-op for non-Claude model IDs and short prompts — safe for all providers.
  // When `config.model` is a `BaseChatModel` instance (rather than a string id)
  // we still want caching to apply, so derive the id from the resolved model.
  if (typeof params.config.model === 'string') {
    finalMessages = injectPromptCacheMarkers(finalMessages, params.config.model)
  } else {
    finalMessages = injectPromptCacheMarkersForModel(finalMessages, params.resolvedModel)
  }

  const tierFilteredTools = params.getTools()
  // REC-M-06 — Apply `toolPermissionPolicy` at tool-issuance time so the
  // model is never told that a forbidden tool is available. Without this gate
  // the policy was only enforced at execution time (inside the tool executor),
  // which meant the model could be prompted with a tool, choose it, and then
  // receive a denial — causing a confusing mid-run failure instead of a clean
  // upfront exclusion.
  //
  // The gate is opt-in: when `toolExecution.permissionPolicy` is absent (the
  // common case), the behaviour is identical to the pre-fix path. When the
  // policy is present and an `agentId` is resolvable, any tool that the policy
  // denies is stripped from the list before the model sees it. The executor's
  // existing pre-flight and issuance-time checks are preserved as a TOCTOU
  // safety net (policy may mutate between issuance and invocation).
  const issuancePolicy = params.config.toolExecution?.permissionPolicy
  const issuanceAgentId = params.config.id
  const tools = issuancePolicy && issuanceAgentId
    ? tierFilteredTools.filter((tool) => issuancePolicy.hasPermission(issuanceAgentId, tool.name))
    : tierFilteredTools
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

export async function executeStreamingToolCall(
  params: ExecuteStreamingToolCallParams,
): Promise<StreamingToolExecutionResult> {
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
