import type { AgentExecutionSpec, DzupEventBus, RunContextTransfer, RunStore } from '@dzupagent/core'
import type { PersistedIntentContext } from '@dzupagent/core'
import { withForgeContext, type ForgeTraceContext } from '@dzupagent/otel'
import type { RunReflectionStore, ReflectionSummary } from '@dzupagent/agent'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import type { RunJob } from '../queue/run-queue.js'
import type { InputGuard } from '../security/input-guard.js'
import { reportRetrievalFeedback } from './retrieval-feedback-hook.js'
import { isRecord, isStructuredResult } from './utils.js'
import type {
  ReflectionInput,
  RunExecutorResult,
  RunExecutionContext,
  StartRunWorkerOptions,
} from './run-worker.js'

export type AdmissionStageResult =
  | { agent: AgentExecutionSpec; input: unknown; rejected: false }
  | { agent?: AgentExecutionSpec; input: unknown; rejected: true }

export interface ExecutionStageResult {
  execution: unknown | RunExecutorResult
  output: unknown
  finalOutput: unknown
  tokenUsage?: { input: number; output: number }
  costCents?: number
  metadata?: Record<string, unknown>
  mergedMetadata?: Record<string, unknown>
  additionalLogs: NonNullable<RunExecutorResult['logs']>
  halted: boolean
}

export interface TerminalPersistenceResult {
  durationMs: number
}

export async function runAdmissionStage(options: {
  job: RunJob
  inputGuard: InputGuard | null
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
  resolveAgent(agentId: string): Promise<AgentExecutionSpec | null>
}): Promise<AdmissionStageResult> {
  const agent = await options.resolveAgent(options.job.agentId)
  if (!agent) {
    await options.runStore.update(options.job.runId, {
      status: 'failed',
      error: `Agent "${options.job.agentId}" not found`,
      completedAt: new Date(),
    })
    options.eventBus.emit({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'REGISTRY_AGENT_NOT_FOUND',
      message: `Agent "${options.job.agentId}" not found`,
    })
    return { input: options.job.input, rejected: true }
  }

  let input: unknown = options.job.input
  if (!options.inputGuard) {
    return { agent, input, rejected: false }
  }

  const guardResult = await options.inputGuard.scan(options.job.input)
  if (!guardResult.allowed) {
    const reason = guardResult.reason ?? 'Rejected by input guard'
    await options.runStore.update(options.job.runId, {
      status: 'rejected',
      error: reason,
      completedAt: new Date(),
    })
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'security',
      message: `Input guard rejected run: ${reason}`,
      data: {
        violations: guardResult.violations?.map((v) => ({
          category: v.category,
          severity: v.severity,
          action: v.action,
        })),
      },
    })
    options.eventBus.emit({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'POLICY_DENIED',
      message: reason,
    })
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      'rejected',
      { reason, guardedBy: 'input-guard' },
    )
    return { agent, input, rejected: true }
  }

  if (guardResult.redactedInput !== undefined) {
    input = guardResult.redactedInput
    await options.runStore.update(options.job.runId, { input })
    await options.runStore.addLog(options.job.runId, {
      level: 'info',
      phase: 'security',
      message: 'Input guard redacted PII in run input',
    })
  }

  return { agent, input, rejected: false }
}

export async function waitForRunApproval(options: {
  agent: AgentExecutionSpec
  job: RunJob
  input: unknown
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
}): Promise<boolean> {
  if (options.agent.approval !== 'required') {
    return true
  }

  const timeoutMs = typeof options.job.metadata?.['approvalTimeoutMs'] === 'number'
    ? Number(options.job.metadata['approvalTimeoutMs'])
    : 60_000

  await options.runStore.update(options.job.runId, {
    status: 'awaiting_approval',
    plan: { input: options.input, metadata: options.job.metadata },
  })
  await options.runStore.addLog(options.job.runId, {
    level: 'info',
    phase: 'approval',
    message: 'Awaiting approval before execution',
    data: { timeoutMs },
  })
  options.eventBus.emit({ type: 'approval:requested', runId: options.job.runId, plan: { input: options.input } })

  const decision = await waitForApprovalDecision(options.eventBus, options.job.runId, timeoutMs)
  if (!decision.approved) {
    await options.runStore.update(options.job.runId, {
      status: 'rejected',
      error: decision.reason ?? 'Rejected by policy',
      completedAt: new Date(),
    })
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'approval',
      message: `Run rejected before execution: ${decision.reason ?? 'no reason provided'}`,
    })
    options.eventBus.emit({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'APPROVAL_REJECTED',
      message: decision.reason ?? 'Run rejected by approval policy',
    })
    await closeTraceWithTerminalStep(
      options.traceStore,
      options.job.runId,
      'rejected',
      { reason: decision.reason ?? 'Run rejected by approval policy' },
    )
    return false
  }

  await options.runStore.update(options.job.runId, { status: 'running' })
  await options.runStore.addLog(options.job.runId, {
    level: 'info',
    phase: 'approval',
    message: 'Approval granted, proceeding with execution',
  })
  return true
}

export async function dispatchExecutionStage(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  agent: AgentExecutionSpec
  input: unknown
  signal: AbortSignal
  forgeTraceContext?: ForgeTraceContext
}): Promise<ExecutionStageResult> {
  const enrichedMetadata = await loadPriorContext({
    contextTransfer: options.workerOptions.contextTransfer,
    runStore: options.workerOptions.runStore,
    job: options.job,
    agent: options.agent,
  })

  const executeRun = () => options.workerOptions.runExecutor({
    runId: options.job.runId,
    agentId: options.job.agentId,
    input: options.input,
    metadata: enrichedMetadata,
    agent: options.agent,
    runStore: options.workerOptions.runStore,
    eventBus: options.workerOptions.eventBus,
    modelRegistry: options.workerOptions.modelRegistry,
    signal: options.signal,
  } satisfies RunExecutionContext)

  const execution = options.forgeTraceContext
    ? await withForgeContext(options.forgeTraceContext, executeRun)
    : await executeRun()

  const output = isStructuredResult(execution) ? execution.output : execution
  const tokenUsage = isStructuredResult(execution) ? execution.tokenUsage : undefined
  const costCents = isStructuredResult(execution) ? execution.costCents : undefined
  const metadata = isStructuredResult(execution) ? execution.metadata : undefined
  const additionalLogs = isStructuredResult(execution) ? execution.logs ?? [] : []
  const compressionLog = isStructuredResult(execution) && execution.compressionLog && execution.compressionLog.length > 0
    ? execution.compressionLog
    : undefined
  const mergedMetadata = metadata || compressionLog
    ? {
        ...(metadata ?? {}),
        ...(compressionLog ? { compressionLog } : {}),
      }
    : undefined
  const halted = metadata != null
    && typeof metadata === 'object'
    && (metadata as Record<string, unknown>)['halted'] === true
  const tokenLifecycleForOutput = isRecord(metadata) && isRecord(metadata['tokenLifecycleReport'])
    ? metadata['tokenLifecycleReport']
    : undefined
  const finalOutput = tokenLifecycleForOutput && isRecord(output)
    ? { ...output, tokenLifecycle: tokenLifecycleForOutput }
    : output

  return {
    execution,
    output,
    finalOutput,
    tokenUsage,
    costCents,
    metadata,
    mergedMetadata,
    additionalLogs,
    halted,
  }
}

export async function persistTerminalSuccess(options: {
  runStore: RunStore
  traceStore?: RunTraceStore
  job: RunJob
  execution: ExecutionStageResult
  startedAt: number
  traceId?: string
}): Promise<TerminalPersistenceResult> {
  const durationMs = Date.now() - options.startedAt
  await options.runStore.update(options.job.runId, {
    status: options.execution.halted ? 'halted' : 'completed',
    output: options.execution.finalOutput,
    ...(options.execution.tokenUsage ? { tokenUsage: options.execution.tokenUsage } : {}),
    ...(typeof options.execution.costCents === 'number' ? { costCents: options.execution.costCents } : {}),
    ...(options.execution.mergedMetadata ? { metadata: { ...(options.job.metadata ?? {}), ...options.execution.mergedMetadata } } : {}),
    completedAt: new Date(),
  })

  if (options.traceStore) {
    await options.traceStore.addStep(options.job.runId, {
      timestamp: Date.now(),
      type: 'output',
      content: options.execution.output,
      metadata: {
        ...(options.execution.tokenUsage ? { tokenUsage: options.execution.tokenUsage } : {}),
        ...(typeof options.execution.costCents === 'number' ? { costCents: options.execution.costCents } : {}),
        durationMs,
      },
      durationMs,
    })
    await options.traceStore.completeTrace(options.job.runId)
  }

  await options.runStore.addLog(options.job.runId, {
    level: 'info',
    phase: 'run',
    message: 'Run completed',
    data: { durationMs, ...(options.traceId ? { traceId: options.traceId } : {}) },
  })
  if (options.execution.additionalLogs.length > 0) {
    await options.runStore.addLogs(options.job.runId, options.execution.additionalLogs.map(log => ({
      level: log.level,
      phase: log.phase,
      message: log.message,
      data: log.data,
    })))
  }

  return { durationMs }
}

export async function recordTelemetryStage(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  durationMs: number
  tokenUsage?: { input: number; output: number }
}): Promise<void> {
  if (options.workerOptions.resourceQuota && options.tokenUsage) {
    const totalTokens = (options.tokenUsage.input ?? 0) + (options.tokenUsage.output ?? 0)
    const keyId = typeof options.job.metadata?.['ownerId'] === 'string'
      ? (options.job.metadata['ownerId'] as string)
      : typeof options.job.metadata?.['tenantId'] === 'string'
        ? (options.job.metadata['tenantId'] as string)
        : undefined
    if (keyId && totalTokens > 0) {
      try {
        options.workerOptions.resourceQuota.recordUsage(keyId, totalTokens)
      } catch (err) {
        await options.workerOptions.runStore.addLog(options.job.runId, {
          level: 'warn',
          phase: 'quota',
          message: 'Failed to record token usage against quota manager',
          data: { error: err instanceof Error ? err.message : String(err) },
        }).catch(() => { /* swallow */ })
      }
    }
  }

  const tierLabel = (options.job.metadata?.['modelTier'] as string) || 'unknown'
  options.workerOptions.metrics?.increment('forge_run_completed_total', { tier: tierLabel })
  options.workerOptions.metrics?.observe('forge_run_duration_ms', options.durationMs, { tier: tierLabel })
}

export async function runPostRunLearningStage(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  agent: AgentExecutionSpec
  input: unknown
  output: unknown
  tokenUsage?: { input: number; output: number }
  metadata?: Record<string, unknown>
  additionalLogs: NonNullable<RunExecutorResult['logs']>
  durationMs: number
}): Promise<void> {
  await scoreRunReflection(options)
  await analyzeRunOutcome(options)
  await saveCrossIntentContext(options)
}

export async function persistCancellation(options: {
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
  job: RunJob
}): Promise<void> {
  const run = await options.runStore.get(options.job.runId)
  if (run && !['completed', 'failed', 'cancelled', 'rejected', 'halted'].includes(run.status)) {
    await options.runStore.update(options.job.runId, {
      status: 'cancelled',
      error: 'Cancelled by user',
      completedAt: new Date(),
    })
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'run',
      message: 'Run cancelled',
    })
    options.eventBus.emit({
      type: 'agent:failed',
      agentId: options.job.agentId,
      runId: options.job.runId,
      errorCode: 'AGENT_ABORTED',
      message: 'Cancelled by user',
    })
    await closeTraceWithTerminalStep(options.traceStore, options.job.runId, 'cancelled', { reason: 'Cancelled by user' })
  }
}

export async function persistFailure(options: {
  runStore: RunStore
  eventBus: DzupEventBus
  traceStore?: RunTraceStore
  job: RunJob
  error: unknown
  traceId?: string
}): Promise<void> {
  const message = options.error instanceof Error ? options.error.message : String(options.error)
  await options.runStore.update(options.job.runId, {
    status: 'failed',
    error: message,
    completedAt: new Date(),
  })
  await options.runStore.addLog(options.job.runId, {
    level: 'error',
    phase: 'run',
    message: 'Run failed',
    data: { error: message, ...(options.traceId ? { traceId: options.traceId } : {}) },
  })
  options.eventBus.emit({
    type: 'agent:failed',
    agentId: options.job.agentId,
    runId: options.job.runId,
    errorCode: 'INTERNAL_ERROR',
    message,
  })
  await closeTraceWithTerminalStep(options.traceStore, options.job.runId, 'failed', { error: message })
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Run cancelled', 'AbortError')
  }
}

export async function closeTraceWithTerminalStep(
  traceStore: RunTraceStore | undefined,
  runId: string,
  status: 'failed' | 'cancelled' | 'rejected',
  details?: Record<string, unknown>,
): Promise<void> {
  if (!traceStore) return
  await traceStore.addStep(runId, {
    timestamp: Date.now(),
    type: 'system',
    content: { status },
    metadata: details,
  })
  await traceStore.completeTrace(runId)
}

async function waitForApprovalDecision(
  eventBus: DzupEventBus,
  runId: string,
  timeoutMs: number,
): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const unsubGrant = eventBus.on('approval:granted', (event) => {
      if (event.runId !== runId) return
      unsubGrant()
      unsubReject()
      clearTimeout(timer)
      resolve({ approved: true })
    })

    const unsubReject = eventBus.on('approval:rejected', (event) => {
      if (event.runId !== runId) return
      unsubGrant()
      unsubReject()
      clearTimeout(timer)
      resolve({ approved: false, reason: event.reason })
    })

    const timer = setTimeout(() => {
      unsubGrant()
      unsubReject()
      resolve({ approved: false, reason: `Approval timed out after ${timeoutMs}ms` })
    }, timeoutMs)
  })
}

async function loadPriorContext(options: {
  contextTransfer?: RunContextTransfer
  runStore: RunStore
  job: RunJob
  agent: AgentExecutionSpec
}): Promise<Record<string, unknown> | undefined> {
  let enrichedMetadata = options.job.metadata
  if (!options.contextTransfer) return enrichedMetadata

  try {
    const sessionId = resolveSessionId(options.job)
    const currentIntent = resolveIntent(options.job, options.agent)
    if (currentIntent && currentIntent !== 'unknown') {
      const priorContext = await options.contextTransfer.loadForIntent(sessionId, currentIntent)
      if (priorContext) {
        enrichedMetadata = { ...(options.job.metadata ?? {}), priorContext }
        await options.runStore.addLog(options.job.runId, {
          level: 'info',
          phase: 'context-transfer',
          message: `Loaded prior context from intent "${priorContext.fromIntent}"`,
          data: { fromIntent: priorContext.fromIntent, tokenEstimate: priorContext.tokenEstimate },
        })
      }
    }
  } catch (_err) {
    await options.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'context-transfer',
      message: 'Failed to load prior context',
      data: { error: _err instanceof Error ? _err.message : String(_err) },
    }).catch(() => { /* swallow nested failure */ })
  }

  return enrichedMetadata
}

async function scoreRunReflection(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  agent: AgentExecutionSpec
  input: unknown
  output: unknown
  tokenUsage?: { input: number; output: number }
  additionalLogs: NonNullable<RunExecutorResult['logs']>
  durationMs: number
}): Promise<void> {
  if (!options.workerOptions.reflector) return

  try {
    const errorCount = options.additionalLogs.filter(l => l.level === 'error').length
    const retryCount = options.additionalLogs.filter(l =>
      l.phase === 'retry' || l.message.toLowerCase().includes('retry'),
    ).length
    const toolCalls = options.additionalLogs
      .filter(l => l.phase === 'tool_call' && l.data && typeof l.data === 'object')
      .map(l => {
        const d = l.data as Record<string, unknown>
        return {
          name: typeof d['toolName'] === 'string' ? d['toolName'] : 'unknown',
          success: d['success'] !== false,
          durationMs: typeof d['durationMs'] === 'number' ? d['durationMs'] : undefined,
        }
      })

    const reflectionInput: ReflectionInput = {
      input: options.job.input,
      output: options.output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: options.tokenUsage,
      durationMs: options.durationMs,
      errorCount,
      retryCount,
    }

    const reflectionScore = options.workerOptions.reflector.score(reflectionInput)
    const existingRun = await options.workerOptions.runStore.get(options.job.runId)
    const existingMeta = (existingRun?.metadata ?? {}) as Record<string, unknown>
    await options.workerOptions.runStore.update(options.job.runId, {
      metadata: { ...existingMeta, reflectionScore },
    })

    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: 'info',
      phase: 'reflection',
      message: `Run quality score: ${reflectionScore.overall.toFixed(3)}`,
      data: {
        overall: reflectionScore.overall,
        dimensions: reflectionScore.dimensions,
        flags: reflectionScore.flags,
      },
    })

    await persistReflectionSummary({
      reflectionStore: options.workerOptions.reflectionStore,
      runStore: options.workerOptions.runStore,
      runId: options.job.runId,
      additionalLogs: options.additionalLogs,
      errorCount,
      durationMs: options.durationMs,
      qualityScore: reflectionScore.overall,
    })

    if (options.workerOptions.retrievalFeedback) {
      reportRetrievalFeedback(
        options.workerOptions.retrievalFeedback,
        (options.job.metadata ?? {}) as Record<string, unknown>,
        reflectionScore,
      )
    }

    await maybeEscalateModelTier({
      workerOptions: options.workerOptions,
      job: options.job,
      agent: options.agent,
      score: reflectionScore.overall,
    })
  } catch (_reflErr) {
    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'reflection',
      message: 'Failed to compute reflection score',
      data: { error: _reflErr instanceof Error ? _reflErr.message : String(_reflErr) },
    }).catch(() => { /* swallow nested failure */ })
  }
}

async function persistReflectionSummary(options: {
  reflectionStore?: RunReflectionStore
  runStore: RunStore
  runId: string
  additionalLogs: NonNullable<RunExecutorResult['logs']>
  errorCount: number
  durationMs: number
  qualityScore: number
}): Promise<void> {
  if (!options.reflectionStore) return

  try {
    const toolCallLogs = options.additionalLogs.filter(
      l => l.phase === 'tool_call' && l.data && typeof l.data === 'object',
    )
    const summary: ReflectionSummary = {
      runId: options.runId,
      completedAt: new Date(),
      durationMs: options.durationMs,
      totalSteps: options.additionalLogs.length,
      toolCallCount: toolCallLogs.length,
      errorCount: options.errorCount,
      patterns: [],
      qualityScore: options.qualityScore,
    }
    await options.reflectionStore.save(summary)
  } catch (_saveErr) {
    await options.runStore.addLog(options.runId, {
      level: 'warn',
      phase: 'reflection',
      message: 'Failed to persist reflection summary',
      data: { error: _saveErr instanceof Error ? _saveErr.message : String(_saveErr) },
    }).catch(() => { /* swallow nested failure */ })
  }
}

async function maybeEscalateModelTier(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  agent: AgentExecutionSpec
  score: number
}): Promise<void> {
  if (!options.workerOptions.escalationPolicy) return

  const currentTier = (options.job.metadata?.['modelTier'] as string) ?? 'chat'
  const intent = resolveIntent(options.job, options.agent)
  const escalationKey = `${options.job.agentId}:${intent ?? 'default'}`
  const escalation = options.workerOptions.escalationPolicy.recordScore(
    escalationKey,
    options.score,
    currentTier,
  )

  if (escalation.shouldEscalate && options.workerOptions.agentStore.save) {
    try {
      const agentDef = await options.workerOptions.agentStore.get(options.job.agentId)
      if (agentDef) {
        await options.workerOptions.agentStore.save({
          ...agentDef,
          metadata: {
            ...agentDef.metadata,
            modelTier: escalation.toTier,
          },
        })
      }
      options.workerOptions.eventBus.emit({
        type: 'registry:agent_updated',
        agentId: options.job.agentId,
        fields: ['metadata.modelTier'],
      })
      await options.workerOptions.runStore.addLog(options.job.runId, {
        level: 'info',
        phase: 'escalation',
        message: `Model tier escalated: ${escalation.fromTier} -> ${escalation.toTier} (${escalation.reason})`,
        data: {
          fromTier: escalation.fromTier,
          toTier: escalation.toTier,
          consecutiveLowScores: escalation.consecutiveLowScores,
          escalationKey,
        },
      })
    } catch (escalationError) {
      await options.workerOptions.runStore.addLog(options.job.runId, {
        level: 'warn',
        phase: 'escalation',
        message: 'Model tier escalation failed',
        data: { error: escalationError instanceof Error ? escalationError.message : String(escalationError) },
      }).catch(() => { /* swallow nested failure */ })
    }
  }
}

async function analyzeRunOutcome(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  output: unknown
}): Promise<void> {
  if (!options.workerOptions.runOutcomeAnalyzer) return

  try {
    const outputText = typeof options.output === 'string'
      ? options.output
      : options.output && typeof options.output === 'object' && 'message' in options.output && typeof (options.output as { message?: unknown }).message === 'string'
        ? (options.output as { message: string }).message
        : JSON.stringify(options.output ?? '')
    const inputText = typeof options.job.input === 'string'
      ? options.job.input
      : JSON.stringify(options.job.input ?? '')
    const analysis = await options.workerOptions.runOutcomeAnalyzer.analyze(options.job.runId, {
      agentId: options.job.agentId,
      input: inputText,
      output: outputText,
    })
    const summary = (analysis && typeof analysis === 'object')
      ? analysis as { score?: unknown; passed?: unknown }
      : null
    const score = typeof summary?.score === 'number' ? summary.score : undefined
    const passed = typeof summary?.passed === 'boolean' ? summary.passed : undefined
    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: 'info',
      phase: 'run-outcome',
      message: score !== undefined
        ? `Run outcome scored: ${score.toFixed(3)} (${passed ? 'pass' : 'fail'})`
        : 'Run outcome analyzer completed',
      data: {
        ...(score !== undefined ? { score } : {}),
        ...(passed !== undefined ? { passed } : {}),
      },
    }).catch(() => { /* swallow nested failure */ })
  } catch (_analyzerErr) {
    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'run-outcome',
      message: 'Run outcome analyzer failed',
      data: { error: _analyzerErr instanceof Error ? _analyzerErr.message : String(_analyzerErr) },
    }).catch(() => { /* swallow nested failure */ })
  }
}

async function saveCrossIntentContext(options: {
  workerOptions: StartRunWorkerOptions
  job: RunJob
  agent: AgentExecutionSpec
  output: unknown
  tokenUsage?: { input: number; output: number }
  metadata?: Record<string, unknown>
}): Promise<void> {
  if (!options.workerOptions.contextTransfer) return

  try {
    const sessionId = resolveSessionId(options.job)
    const intent = resolveIntent(options.job, options.agent)
    if (intent && intent !== 'unknown') {
      const outputSummary = typeof options.output === 'string'
        ? options.output.slice(0, 500)
        : typeof options.output === 'object' && options.output !== null && 'summary' in options.output
          ? String((options.output as Record<string, unknown>).summary).slice(0, 500)
          : 'Run completed'

      const relevantFiles: string[] =
        (options.metadata?.['relevantFiles'] as string[] | undefined)
        ?? (options.job.metadata?.['relevantFiles'] as string[] | undefined)
        ?? []

      const workingState: Record<string, unknown> =
        (options.metadata?.['workingState'] as Record<string, unknown> | undefined)
        ?? (options.job.metadata?.['workingState'] as Record<string, unknown> | undefined)
        ?? {}

      const persistedContext: PersistedIntentContext = {
        fromIntent: intent,
        summary: outputSummary,
        decisions: (options.metadata?.['decisions'] as string[] | undefined) ?? [],
        relevantFiles,
        workingState,
        transferredAt: Date.now(),
        tokenEstimate: (options.tokenUsage?.input ?? 0) + (options.tokenUsage?.output ?? 0),
      }

      await options.workerOptions.contextTransfer.save(sessionId, persistedContext)
      await options.workerOptions.runStore.addLog(options.job.runId, {
        level: 'info',
        phase: 'context-transfer',
        message: `Saved context for intent "${intent}"`,
        data: { tokenEstimate: persistedContext.tokenEstimate },
      })
    }
  } catch (_err) {
    await options.workerOptions.runStore.addLog(options.job.runId, {
      level: 'warn',
      phase: 'context-transfer',
      message: 'Failed to save context after run',
      data: { error: _err instanceof Error ? _err.message : String(_err) },
    }).catch(() => { /* swallow nested failure */ })
  }
}

function resolveSessionId(job: { runId: string; metadata?: Record<string, unknown> }): string {
  const fromMeta = job.metadata?.['sessionId']
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : job.runId
}

function resolveIntent(
  job: { metadata?: Record<string, unknown> },
  agent: AgentExecutionSpec,
): string | undefined {
  const fromJob = job.metadata?.['intent']
  if (typeof fromJob === 'string' && fromJob.length > 0) return fromJob

  const fromAgent = agent.metadata?.['intent']
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent

  return undefined
}
