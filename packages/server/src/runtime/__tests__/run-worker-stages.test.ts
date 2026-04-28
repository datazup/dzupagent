import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type AgentExecutionSpec,
} from '@dzupagent/core'
import { InMemoryReflectionStore } from '@dzupagent/agent'
import { InMemoryRunQueue, type RunJob } from '../../queue/run-queue.js'
import type { InputGuard } from '../../security/input-guard.js'
import type { StartRunWorkerOptions } from '../run-worker.js'
import {
  dispatchExecutionStage,
  persistTerminalSuccess,
  recordTelemetryStage,
  runAdmissionStage,
  runPostRunLearningStage,
  waitForRunApproval,
} from '../run-worker-stages.js'

function createJob(runId: string, overrides: Partial<RunJob> = {}): RunJob {
  return {
    id: 'job-1',
    runId,
    agentId: 'agent-1',
    input: { message: 'hello' },
    metadata: {},
    priority: 1,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function createAgent(overrides: Partial<AgentExecutionSpec> = {}): AgentExecutionSpec {
  return {
    id: 'agent-1',
    name: 'Agent One',
    instructions: 'test',
    modelTier: 'chat',
    active: true,
    ...overrides,
  }
}

function createWorkerOptions(overrides: Partial<StartRunWorkerOptions> = {}): StartRunWorkerOptions {
  return {
    runQueue: new InMemoryRunQueue({ concurrency: 1 }),
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    runExecutor: async () => ({ output: { ok: true } }),
    ...overrides,
  }
}

describe('run-worker internal stages', () => {
  it('admission rejects denied input before execution dispatch', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const failedEvents: string[] = []
    eventBus.on('agent:failed', event => failedEvents.push(event.errorCode))
    const run = await runStore.create({ agentId: 'agent-1', input: { message: 'reject' } })
    const job = createJob(run.id, { input: { message: 'reject' } })
    const inputGuard: InputGuard = {
      scan: vi.fn().mockResolvedValue({
        allowed: false,
        reason: 'blocked',
        violations: [{ category: 'prompt_injection', severity: 'critical', action: 'block' }],
      }),
    }

    const result = await runAdmissionStage({
      job,
      inputGuard,
      runStore,
      eventBus,
      resolveAgent: async () => createAgent(),
    })

    expect(result.rejected).toBe(true)
    const rejected = await runStore.get(run.id)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.error).toBe('blocked')
    expect(failedEvents).toEqual(['POLICY_DENIED'])
  })

  it('approval stage persists rejected terminal state when approval is denied', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const run = await runStore.create({ agentId: 'agent-1', input: { message: 'needs approval' } })
    const job = createJob(run.id, {
      input: { message: 'needs approval' },
      metadata: { approvalTimeoutMs: 500 },
    })
    setTimeout(() => {
      eventBus.emit({ type: 'approval:rejected', runId: run.id, reason: 'not approved' })
    }, 10)

    const approved = await waitForRunApproval({
      agent: createAgent({ approval: 'required' }),
      job,
      input: job.input,
      runStore,
      eventBus,
    })

    expect(approved).toBe(false)
    const rejected = await runStore.get(run.id)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.error).toBe('not approved')
  })

  it('execution stage loads prior context and normalizes structured executor results', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const agent = createAgent({ metadata: { intent: 'build' } })
    const run = await runStore.create({ agentId: agent.id, input: { message: 'execute' } })
    const job = createJob(run.id, {
      input: { message: 'execute' },
      metadata: { sessionId: 'session-1' },
    })
    const observedMetadata: unknown[] = []
    const workerOptions = createWorkerOptions({
      runStore,
      eventBus,
      contextTransfer: {
        loadForIntent: vi.fn().mockResolvedValue({ fromIntent: 'plan', summary: 'prior', transferredAt: 1, tokenEstimate: 3 }),
        save: vi.fn(),
      },
      runExecutor: async ({ metadata }) => {
        observedMetadata.push(metadata)
        return {
          output: { message: 'done' },
          tokenUsage: { input: 2, output: 4 },
          costCents: 7,
          metadata: {
            halted: true,
            tokenLifecycleReport: { phases: ['draft'] },
          },
          logs: [{ level: 'info' as const, phase: 'tool_call', message: 'tool', data: { toolName: 'search' } }],
        }
      },
    })

    const execution = await dispatchExecutionStage({
      workerOptions,
      job,
      agent,
      input: job.input,
      signal: new AbortController().signal,
    })

    expect(observedMetadata[0]).toMatchObject({
      sessionId: 'session-1',
      priorContext: { fromIntent: 'plan', summary: 'prior', transferredAt: 1, tokenEstimate: 3 },
    })
    expect(execution.halted).toBe(true)
    expect(execution.finalOutput).toEqual({ message: 'done', tokenLifecycle: { phases: ['draft'] } })
    expect(execution.tokenUsage).toEqual({ input: 2, output: 4 })
    expect(execution.additionalLogs).toHaveLength(1)
  })

  it('terminal persistence preserves completed and halted output behavior', async () => {
    const runStore = new InMemoryRunStore()
    const run = await runStore.create({ agentId: 'agent-1', input: { message: 'complete' }, metadata: { kept: true } })
    const job = createJob(run.id, { metadata: { kept: true } })

    await persistTerminalSuccess({
      runStore,
      job,
      startedAt: Date.now(),
      execution: {
        execution: { output: { message: 'done' } },
        output: { message: 'done' },
        finalOutput: { message: 'done', tokenLifecycle: { phases: ['final'] } },
        tokenUsage: { input: 1, output: 2 },
        costCents: 3,
        metadata: { halted: true },
        mergedMetadata: { halted: true },
        additionalLogs: [{ level: 'debug', phase: 'executor', message: 'extra' }],
        halted: true,
      },
    })

    const halted = await runStore.get(run.id)
    expect(halted?.status).toBe('halted')
    expect(halted?.output).toEqual({ message: 'done', tokenLifecycle: { phases: ['final'] } })
    expect(halted?.tokenUsage).toEqual({ input: 1, output: 2 })
    expect(halted?.metadata).toEqual({ kept: true, halted: true })
    const logs = await runStore.getLogs(run.id)
    expect(logs.some(log => log.phase === 'run' && log.message === 'Run completed')).toBe(true)
    expect(logs.some(log => log.phase === 'executor' && log.message === 'extra')).toBe(true)
  })

  it('telemetry stage records quota usage and completion metrics', async () => {
    const runStore = new InMemoryRunStore()
    const quotaRecord = vi.fn()
    const metricIncrement = vi.fn()
    const metricObserve = vi.fn()
    const workerOptions = createWorkerOptions({
      runStore,
      resourceQuota: { recordUsage: quotaRecord },
      metrics: {
        increment: metricIncrement,
        observe: metricObserve,
      },
    })
    const job = createJob('run-telemetry', {
      metadata: { ownerId: 'owner-1', modelTier: 'reasoning' },
    })

    await recordTelemetryStage({
      workerOptions,
      job,
      durationMs: 42,
      tokenUsage: { input: 10, output: 15 },
    })

    expect(quotaRecord).toHaveBeenCalledWith('owner-1', 25)
    expect(metricIncrement).toHaveBeenCalledWith('forge_run_completed_total', { tier: 'reasoning' })
    expect(metricObserve).toHaveBeenCalledWith('forge_run_duration_ms', 42, { tier: 'reasoning' })
  })

  it('post-run learning scores reflection, analyzes outcomes, and saves context', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const reflectionStore = new InMemoryReflectionStore()
    const saveContext = vi.fn()
    const analyze = vi.fn().mockResolvedValue({ score: 0.9, passed: true })
    const run = await runStore.create({ agentId: 'agent-1', input: { message: 'learn' } })
    await runStore.update(run.id, { status: 'completed' })
    const job = createJob(run.id, {
      input: { message: 'learn' },
      metadata: { sessionId: 'session-2', intent: 'review' },
    })
    const workerOptions = createWorkerOptions({
      runStore,
      eventBus,
      reflectionStore,
      reflector: {
        score: () => ({
          overall: 0.75,
          dimensions: {
            completeness: 0.8,
            coherence: 0.7,
            toolSuccess: 0.9,
            conciseness: 0.6,
            reliability: 0.75,
          },
          flags: [],
        }),
      },
      runOutcomeAnalyzer: { analyze },
      contextTransfer: {
        loadForIntent: vi.fn(),
        save: saveContext,
      },
    })

    await runPostRunLearningStage({
      workerOptions,
      job,
      agent: createAgent(),
      input: job.input,
      output: { summary: 'reviewed output' },
      tokenUsage: { input: 3, output: 5 },
      metadata: { decisions: ['keep'], relevantFiles: ['a.ts'], workingState: { ok: true } },
      additionalLogs: [
        { level: 'info', phase: 'tool_call', message: 'tool', data: { toolName: 'read', success: true } },
        { level: 'error', phase: 'agent', message: 'retryable error' },
      ],
      durationMs: 12,
    })

    const scored = await runStore.get(run.id)
    expect(scored?.metadata?.['reflectionScore']).toMatchObject({ overall: 0.75 })
    expect(await reflectionStore.get(run.id)).toMatchObject({
      runId: run.id,
      toolCallCount: 1,
      errorCount: 1,
      qualityScore: 0.75,
    })
    expect(analyze).toHaveBeenCalledWith(run.id, {
      agentId: 'agent-1',
      input: JSON.stringify({ message: 'learn' }),
      output: JSON.stringify({ summary: 'reviewed output' }),
    })
    expect(saveContext).toHaveBeenCalledWith('session-2', expect.objectContaining({
      fromIntent: 'review',
      decisions: ['keep'],
      tokenEstimate: 8,
    }))
  })
})
