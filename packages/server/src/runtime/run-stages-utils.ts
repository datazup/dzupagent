import type { AgentExecutionSpec } from '@dzupagent/core/persistence'
import type { RunTraceStore } from '../persistence/run-trace-store.js'

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

export function resolveSessionId(job: { runId: string; metadata?: Record<string, unknown> }): string {
  const fromMeta = job.metadata?.['sessionId']
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : job.runId
}

export function resolveIntent(
  job: { metadata?: Record<string, unknown> },
  agent: AgentExecutionSpec,
): string | undefined {
  const fromJob = job.metadata?.['intent']
  if (typeof fromJob === 'string' && fromJob.length > 0) return fromJob

  const fromAgent = agent.metadata?.['intent']
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent

  return undefined
}
