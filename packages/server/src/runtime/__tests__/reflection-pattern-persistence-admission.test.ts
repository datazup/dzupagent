import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type AgentExecutionSpec,
} from '@dzupagent/core'
import { InMemoryReflectionStore } from '@dzupagent/agent'
import {
  ReflectionAnalyzer,
  type ReflectionSummary,
  type RunReflectionStore,
} from '@dzupagent/agent/reflection'
import { InMemoryRunQueue, type RunJob } from '../../queue/run-queue.js'
import type { StartRunWorkerOptions } from '../run-worker.js'
import { runPostRunLearningStage } from '../run-worker-stages.js'

type LearningLogs = Parameters<typeof runPostRunLearningStage>[0]['additionalLogs']

const REFLECTION_SCORE = {
  overall: 0.75,
  dimensions: {
    completeness: 0.8,
    coherence: 0.7,
    toolSuccess: 0.9,
    conciseness: 0.6,
    reliability: 0.75,
  },
  flags: [],
}

function createAgent(): AgentExecutionSpec {
  return {
    id: 'reflection-agent',
    name: 'Reflection Agent',
    instructions: 'test',
    modelTier: 'chat',
    active: true,
  }
}

function createWorkerOptions(
  runStore: InMemoryRunStore,
  reflectionStore?: RunReflectionStore,
): StartRunWorkerOptions {
  return {
    runQueue: new InMemoryRunQueue({ concurrency: 1 }),
    runStore,
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    runExecutor: async () => ({ output: { ok: true } }),
    reflector: { score: () => REFLECTION_SCORE },
    ...(reflectionStore !== undefined ? { reflectionStore } : {}),
  }
}

async function persistFromLogs(
  logs: LearningLogs,
  options: {
    metadata?: Record<string, unknown>
    reflectionStore?: RunReflectionStore
    input?: unknown
    output?: unknown
  } = {},
): Promise<{
  summary: ReflectionSummary | undefined
  runStore: InMemoryRunStore
  reflectionStore: RunReflectionStore
  runId: string
}> {
  const runStore = new InMemoryRunStore()
  const reflectionStore = options.reflectionStore ?? new InMemoryReflectionStore()
  const input = options.input ?? { message: 'learn' }
  const run = await runStore.create({
    agentId: 'reflection-agent',
    input,
    metadata: options.metadata ?? {},
  })
  const job: RunJob = {
    id: `job:${run.id}`,
    runId: run.id,
    agentId: 'reflection-agent',
    input,
    metadata: options.metadata ?? {},
    priority: 1,
    attempts: 0,
    createdAt: new Date(),
  }

  await runPostRunLearningStage({
    workerOptions: createWorkerOptions(runStore, reflectionStore),
    job,
    agent: createAgent(),
    input,
    output: options.output ?? { status: 'done' },
    additionalLogs: logs,
    durationMs: 37,
  })

  return {
    summary: await reflectionStore.get(run.id),
    runStore,
    reflectionStore,
    runId: run.id,
  }
}

function success(toolName: string, durationMs = 1): LearningLogs[number] {
  return {
    level: 'info',
    phase: 'tool_call',
    message: 'tool completed',
    data: { toolName, success: true, durationMs },
  }
}

function failure(toolName: string, message: string): LearningLogs[number] {
  return {
    level: 'error',
    phase: 'tool_call',
    message,
    data: { toolName, success: false, diagnostic: message },
  }
}

function patternTypes(summary: ReflectionSummary | undefined): string[] {
  return summary?.patterns.map((pattern) => pattern.type) ?? []
}

describe('reflection pattern persistence admission', () => {
  it('persists a repeated-tool pattern from qualifying ordered evidence', async () => {
    const { summary } = await persistFromLogs([success('search'), success('search')])

    expect(patternTypes(summary)).toContain('repeated_tool')
  })

  it('does not fabricate a repeated-tool pattern below the analyzer threshold', async () => {
    const { summary } = await persistFromLogs([success('search')])

    expect(patternTypes(summary)).not.toContain('repeated_tool')
  })

  it('persists an error loop without retaining raw failure text', async () => {
    const sensitiveError = 'SECRET diagnostic at https://private.invalid/path'
    const { summary } = await persistFromLogs([
      failure('read', sensitiveError),
      failure('write', sensitiveError),
    ])

    expect(patternTypes(summary)).toContain('error_loop')
    expect(JSON.stringify(summary?.patterns)).not.toContain(sensitiveError)
  })

  it('detects a finite slow step and never retains non-finite durations', async () => {
    const { summary } = await persistFromLogs([
      success('quick-a', 1),
      success('quick-b', 1),
      success('slow', 10),
      success('not-a-number', Number.NaN),
      success('infinite', Number.POSITIVE_INFINITY),
    ])

    expect(patternTypes(summary)).toContain('slow_step')
    expect(JSON.stringify(summary?.patterns)).not.toMatch(/NaN|Infinity/)
  })

  it('persists a successful strategy after three ordered successes', async () => {
    const { summary } = await persistFromLogs([
      success('read'),
      success('transform'),
      success('write'),
    ])

    expect(patternTypes(summary)).toContain('successful_strategy')
  })

  it('does not group interleaved tool identities before analysis', async () => {
    const { summary } = await persistFromLogs([
      success('search'),
      success('read'),
      success('search'),
    ])

    expect(patternTypes(summary)).not.toContain('repeated_tool')
  })

  it('keeps persisted run identity, ownership, score, and legacy counts authoritative', async () => {
    const { summary, runId } = await persistFromLogs([
      success('read'),
      { level: 'error', phase: 'agent', message: 'non-tool error' },
    ], {
      metadata: { tenantId: 'tenant-7', ownerId: 'owner-9' },
    })

    expect(summary).toMatchObject({
      runId,
      tenantId: 'tenant-7',
      ownerId: 'owner-9',
      durationMs: 37,
      totalSteps: 2,
      toolCallCount: 1,
      errorCount: 1,
      qualityScore: 0.75,
    })
  })

  it('analyzes patterns under the exact persisted job run ID', async () => {
    const analyze = vi.spyOn(ReflectionAnalyzer.prototype, 'analyze')
    try {
      const { runId } = await persistFromLogs([success('read'), success('read')])

      expect(analyze).toHaveBeenCalledWith(runId, expect.any(Array))
    } finally {
      analyze.mockRestore()
    }
  })

  it('does not invoke the analyzer when no reflection store is configured', async () => {
    const analyze = vi.spyOn(ReflectionAnalyzer.prototype, 'analyze')
    const runStore = new InMemoryRunStore()
    const run = await runStore.create({ agentId: 'reflection-agent', input: {} })
    const job: RunJob = {
      id: `job:${run.id}`,
      runId: run.id,
      agentId: 'reflection-agent',
      input: {},
      metadata: {},
      priority: 1,
      attempts: 0,
      createdAt: new Date(),
    }

    try {
      await runPostRunLearningStage({
        workerOptions: createWorkerOptions(runStore),
        job,
        agent: createAgent(),
        input: {},
        output: {},
        additionalLogs: [success('read'), success('read')],
        durationMs: 4,
      })
      expect(analyze).not.toHaveBeenCalled()
    } finally {
      analyze.mockRestore()
    }
  })

  it('keeps analyzer rejection non-fatal and records a bounded warning', async () => {
    const analyze = vi.spyOn(ReflectionAnalyzer.prototype, 'analyze')
      .mockImplementationOnce(() => {
        throw new Error('analyzer unavailable')
      })

    try {
      const { runStore, runId } = await persistFromLogs([success('read')])
      const logs = await runStore.getLogs(runId)

      expect(logs).toContainEqual(expect.objectContaining({
        level: 'warn',
        phase: 'reflection',
        message: 'Failed to persist reflection summary',
      }))
    } finally {
      analyze.mockRestore()
    }
  })

  it('keeps reflection-store rejection non-fatal and records a bounded warning', async () => {
    const reflectionStore = {
      save: vi.fn(async () => {
        throw new Error('reflection store unavailable')
      }),
      get: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      getPatterns: vi.fn(async () => []),
    } as unknown as RunReflectionStore

    const { runStore, runId } = await persistFromLogs([success('read')], {
      reflectionStore,
    })
    const logs = await runStore.getLogs(runId)

    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      phase: 'reflection',
      message: 'Failed to persist reflection summary',
    }))
  })

  it('retains only sanitized identity and never raw input, output, message, or data', async () => {
    const sensitive = 'SENSITIVE-PROMPT-OUTPUT-ARGUMENT-987'
    const rawToolIdentity = 'read file\n../../private?token=raw'
    const logs: LearningLogs = [
      {
        level: 'info',
        phase: 'tool_call',
        message: sensitive,
        data: {
          toolName: rawToolIdentity,
          success: true,
          durationMs: 1,
          arguments: sensitive,
          output: sensitive,
          diagnostic: sensitive,
        },
      },
      {
        level: 'info',
        phase: 'tool_call',
        message: sensitive,
        data: {
          toolName: rawToolIdentity,
          success: true,
          durationMs: 1,
          arguments: sensitive,
          output: sensitive,
          diagnostic: sensitive,
        },
      },
    ]
    const { summary } = await persistFromLogs(logs, {
      input: { prompt: sensitive },
      output: { result: sensitive },
    })
    const serialized = JSON.stringify(summary)

    expect(patternTypes(summary)).toContain('repeated_tool')
    expect(serialized).not.toContain(sensitive)
    expect(serialized).not.toContain(rawToolIdentity)
  })
})
