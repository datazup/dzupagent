/**
 * Session W: Token lifecycle report in run output.
 *
 * The run-worker is responsible for merging `metadata.tokenLifecycleReport`
 * (persisted by dzip-agent-run-executor) into `run.output.tokenLifecycle`
 * when the executor's output is a plain object. Scalar outputs (strings,
 * numbers) pass through unchanged — we don't retrofit structure onto them.
 *
 * Coverage:
 *   1. tokenLifecycle is merged into output when metadata has the report
 *   2. tokenLifecycle is NOT merged when metadata has no report
 *   3. tokenLifecycle is NOT merged when output is a scalar (e.g. string)
 */
import { describe, it, expect } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type RunStatus,
} from '@dzupagent/core'
import { waitForCondition } from '@dzupagent/test-utils'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'

async function waitForTerminal(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<RunStatus> {
  const terminal: readonly RunStatus[] = ['completed', 'halted', 'failed', 'rejected', 'cancelled']
  let observed: RunStatus | undefined
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      if (run && terminal.includes(run.status)) {
        observed = run.status
        return true
      }
      return false
    },
    { timeoutMs, intervalMs: 20, description: `waiting for terminal on ${runId}` },
  )
  return observed!
}

interface SetupOpts {
  runExecutor: Parameters<typeof startRunWorker>[0]['runExecutor']
}

async function setup(opts: SetupOpts) {
  const runStore = new InMemoryRunStore()
  const agentStore = new InMemoryAgentStore()
  const eventBus = createEventBus()
  const runQueue = new InMemoryRunQueue({ concurrency: 1 })
  const modelRegistry = new ModelRegistry()

  await agentStore.save({
    id: 'w-agent',
    name: 'W Agent',
    instructions: 'test',
    modelTier: 'chat',
    active: true,
  })

  startRunWorker({
    runQueue,
    runStore,
    agentStore,
    eventBus,
    modelRegistry,
    runExecutor: opts.runExecutor,
  })

  return { runStore, agentStore, eventBus, runQueue, modelRegistry }
}

describe('Session W — tokenLifecycle in run output', () => {
  it('merges tokenLifecycle into output when executor metadata has tokenLifecycleReport', async () => {
    const report = {
      used: 1500,
      available: 4000,
      pct: 0.375,
      status: 'warn' as const,
      phases: [
        { phase: 'system-prompt', tokens: 500, timestamp: 1700000000000 },
        { phase: 'user-input', tokens: 1000, timestamp: 1700000001000 },
      ],
      recommendation: 'Consider compressing history',
    }
    const { runStore, runQueue } = await setup({
      runExecutor: async () => ({
        output: { message: 'hello' },
        metadata: { tokenLifecycleReport: report },
      }),
    })

    const run = await runStore.create({ agentId: 'w-agent', input: { message: 'hi' } })
    await runQueue.enqueue({ runId: run.id, agentId: 'w-agent', input: { message: 'hi' }, priority: 1 })

    const status = await waitForTerminal(runStore, run.id)
    expect(status).toBe('completed')

    const final = await runStore.get(run.id)
    expect(final?.output).toBeDefined()
    const output = final!.output as Record<string, unknown>
    expect(output['message']).toBe('hello')
    expect(output['tokenLifecycle']).toEqual(report)

    await runQueue.stop(false)
  })

  it('does NOT add tokenLifecycle to output when metadata has no tokenLifecycleReport', async () => {
    const { runStore, runQueue } = await setup({
      runExecutor: async () => ({
        output: { message: 'no report' },
        metadata: { streamMode: true },
      }),
    })

    const run = await runStore.create({ agentId: 'w-agent', input: { message: 'hi' } })
    await runQueue.enqueue({ runId: run.id, agentId: 'w-agent', input: { message: 'hi' }, priority: 1 })

    const status = await waitForTerminal(runStore, run.id)
    expect(status).toBe('completed')

    const final = await runStore.get(run.id)
    const output = final!.output as Record<string, unknown>
    expect(output['message']).toBe('no report')
    expect(output).not.toHaveProperty('tokenLifecycle')

    await runQueue.stop(false)
  })

  it('does NOT add tokenLifecycle when output is not a plain object (e.g. string)', async () => {
    const report = {
      used: 100,
      available: 1000,
      pct: 0.1,
      status: 'ok' as const,
      phases: [],
    }
    const { runStore, runQueue } = await setup({
      runExecutor: async () => ({
        output: 'plain string output',
        metadata: { tokenLifecycleReport: report },
      }),
    })

    const run = await runStore.create({ agentId: 'w-agent', input: { message: 'hi' } })
    await runQueue.enqueue({ runId: run.id, agentId: 'w-agent', input: { message: 'hi' }, priority: 1 })

    const status = await waitForTerminal(runStore, run.id)
    expect(status).toBe('completed')

    const final = await runStore.get(run.id)
    // Scalar output survives unchanged — no wrapper object is synthesized.
    expect(final?.output).toBe('plain string output')

    // But the report is still persisted in metadata for the /context and
    // /token-report endpoints to read.
    expect((final?.metadata as Record<string, unknown>)?.['tokenLifecycleReport']).toEqual(report)

    await runQueue.stop(false)
  })
})
