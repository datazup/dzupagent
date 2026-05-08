import type { RunContextTransfer } from '@dzupagent/core/llm'
import type { AgentExecutionSpec, RunStore } from '@dzupagent/core/persistence'
import { withForgeContext, type ForgeTraceContext } from '@dzupagent/otel'
import type { RunJob } from '../queue/run-queue.js'
import { resolveSessionId, resolveIntent } from './run-stages-utils.js'
import { isRecord, isStructuredResult } from './utils.js'
import type {
  RunExecutionContext,
  RunExecutorResult,
  StartRunWorkerOptions,
} from './run-worker-types.js'

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
