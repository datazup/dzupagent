/**
 * Tests for token lifecycle wiring in the DzupAgent run executor.
 *
 * Covers Session K: per-run TokenLifecycleManager registration in a shared
 * `Map<runId, TokenLifecycleLike>`, deregistration on completion/error, and
 * persistence of the final report into run metadata.
 *
 * The DzupAgent class and tool resolver are mocked so the tests run without a
 * real LLM. Tests exercise both the success path (when `stream()` completes
 * cleanly) and the fallback path (when `stream()` throws).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import type { RunExecutionContext } from '../runtime/run-worker.js'
import type { TokenLifecycleLike } from '../routes/run-context.js'

// Mutable test knobs — the mocked DzupAgent reads these.
let shouldAgentThrow = false
let streamedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@dzupagent/agent', () => ({
  DzupAgent: class {
    async *stream(): AsyncGenerator<
      { type: string; data: Record<string, unknown> },
      void,
      undefined
    > {
      if (shouldAgentThrow) {
        throw new Error('mock agent failure')
      }
      for (const event of streamedEvents) {
        yield event
      }
    }
  },
}))

vi.mock('../runtime/tool-resolver.js', () => ({
  resolveAgentTools: async () => ({
    tools: [],
    activated: [],
    unresolved: [],
    warnings: [],
    cleanup: async () => {},
  }),
}))

import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'

async function makeContext(
  overrides?: Partial<RunExecutionContext>,
): Promise<RunExecutionContext> {
  const runStore = overrides?.runStore ?? new InMemoryRunStore()
  // Pre-create a run so metadata updates land on a real record.
  const run = await runStore.create({
    agentId: 'agent-lifecycle-1',
    input: { message: 'hello' },
    metadata: { seededKey: 'seededValue' },
  })
  return {
    runId: run.id,
    agentId: 'agent-lifecycle-1',
    input: { message: 'hello' },
    metadata: {},
    agent: {
      id: 'agent-lifecycle-1',
      name: 'Agent Lifecycle',
      instructions: 'Be concise',
      modelTier: 'chat',
    },
    runStore,
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('dzip-agent-run-executor token lifecycle wiring', () => {
  beforeEach(() => {
    shouldAgentThrow = false
    streamedEvents = [
      { type: 'done', data: { content: 'final output', hitIterationLimit: false } },
    ]
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('runs without a registry (backward compat no-op)', async () => {
    const executor = createDzupAgentRunExecutor()
    const ctx = await makeContext()

    const result = await executor(ctx)

    expect(result.output).toEqual({ message: 'final output' })
  })

  it('registers the manager in the registry during execution', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    const setSpy = vi.spyOn(registry, 'set')

    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    await executor(ctx)

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith(ctx.runId, expect.any(Object))
    // The registered entry must satisfy the TokenLifecycleLike contract.
    const registered = setSpy.mock.calls[0]?.[1] as TokenLifecycleLike
    expect(typeof registered.usedTokens).toBe('number')
    expect(typeof registered.remainingTokens).toBe('number')
    expect(registered.status).toMatch(/^(ok|warn|critical|exhausted)$/)
    expect(registered.report).toBeDefined()
  })

  it('deregisters the manager from the registry after a successful run', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    await executor(ctx)

    expect(registry.has(ctx.runId)).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('deregisters the manager even when DzupAgent fails and fallback is used', async () => {
    shouldAgentThrow = true
    const registry = new Map<string, TokenLifecycleLike>()

    const executor = createDzupAgentRunExecutor({
      tokenLifecycleRegistry: registry,
      fallback: async () => ({
        output: { message: 'fallback-done' },
        tokenUsage: { input: 1, output: 2 },
      }),
    })
    const ctx = await makeContext()

    const result = await executor(ctx)

    expect(result.output).toEqual({ message: 'fallback-done' })
    expect(result.metadata?.['fallbackUsed']).toBe(true)
    expect(registry.has(ctx.runId)).toBe(false)
  })

  it('deregisters the manager when execution fails and no fallback is provided', async () => {
    shouldAgentThrow = true
    const registry = new Map<string, TokenLifecycleLike>()
    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    await expect(executor(ctx)).rejects.toThrow('mock agent failure')
    expect(registry.has(ctx.runId)).toBe(false)
  })

  it('tracks prompt tokens up-front so lifecycle is meaningful on fallback path', async () => {
    shouldAgentThrow = true
    const registry = new Map<string, TokenLifecycleLike>()
    const captured: TokenLifecycleLike[] = []
    const realSet = registry.set.bind(registry)
    vi.spyOn(registry, 'set').mockImplementation((runId, value) => {
      captured.push(value)
      return realSet(runId, value)
    })

    const executor = createDzupAgentRunExecutor({
      tokenLifecycleRegistry: registry,
      fallback: async () => ({ output: { message: 'ok' } }),
    })
    const ctx = await makeContext({ input: { message: 'a much longer prompt value' } })

    await executor(ctx)

    expect(captured).toHaveLength(1)
    // Prompt phase should have been charged before the agent blew up.
    expect(captured[0]!.usedTokens).toBeGreaterThan(0)
    const phases = captured[0]!.report.phases.map((p) => p.phase)
    expect(phases).toContain('prompt')
  })

  it('persists tokenLifecycleReport in run metadata on successful completion', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    await executor(ctx)

    const run = await ctx.runStore.get(ctx.runId)
    expect(run).not.toBeNull()
    const meta = run!.metadata as Record<string, unknown>
    // Sibling metadata must be preserved across the shallow update.
    expect(meta['seededKey']).toBe('seededValue')
    const report = meta['tokenLifecycleReport'] as Record<string, unknown>
    expect(report).toBeDefined()
    expect(typeof report['used']).toBe('number')
    expect(typeof report['available']).toBe('number')
    expect(report['status']).toMatch(/^(ok|warn|critical|exhausted)$/)
    expect(Array.isArray(report['phases'])).toBe(true)
  })

  it('persists tokenLifecycleReport on the fallback path as well', async () => {
    shouldAgentThrow = true
    const registry = new Map<string, TokenLifecycleLike>()
    const executor = createDzupAgentRunExecutor({
      tokenLifecycleRegistry: registry,
      fallback: async () => ({ output: { message: 'fallback' } }),
    })
    const ctx = await makeContext()

    await executor(ctx)

    const run = await ctx.runStore.get(ctx.runId)
    const meta = run!.metadata as Record<string, unknown>
    expect(meta['tokenLifecycleReport']).toBeDefined()
  })

  it('respects contextWindowTokens and reservedOutputTokens overrides', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    let captured: TokenLifecycleLike | undefined
    const realSet = registry.set.bind(registry)
    vi.spyOn(registry, 'set').mockImplementation((runId, value) => {
      captured = value
      return realSet(runId, value)
    })

    const executor = createDzupAgentRunExecutor({
      tokenLifecycleRegistry: registry,
      contextWindowTokens: 1_000,
      reservedOutputTokens: 100,
    })
    const ctx = await makeContext()

    await executor(ctx)

    expect(captured).toBeDefined()
    // available = total - reserved = 1000 - 100 = 900
    expect(captured!.report.available).toBe(900)
  })

  it('makes manager state observable through the registry during a run', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    let observedDuringRun: TokenLifecycleLike | undefined

    // Insert a stream event whose handler is synchronous — we check the
    // registry after the event loop is complete but before the executor
    // returns via a custom fallback (which shouldn't fire for successful runs).
    streamedEvents = [
      { type: 'text', data: { content: 'hi' } },
      { type: 'done', data: { content: 'hi', hitIterationLimit: false } },
    ]

    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    // Snapshot the manager immediately after registration by spying set().
    const realSet = registry.set.bind(registry)
    vi.spyOn(registry, 'set').mockImplementation((runId, value) => {
      observedDuringRun = value
      return realSet(runId, value)
    })

    await executor(ctx)

    expect(observedDuringRun).toBeDefined()
    // By the time the run finishes, the manager has recorded phases.
    expect(observedDuringRun!.report.phases.length).toBeGreaterThan(0)
  })

  it('tracks tool-result phase when a tool emits a result event', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    let captured: TokenLifecycleLike | undefined
    const realSet = registry.set.bind(registry)
    vi.spyOn(registry, 'set').mockImplementation((runId, value) => {
      captured = value
      return realSet(runId, value)
    })

    streamedEvents = [
      { type: 'tool_call', data: { name: 'read_file', args: { path: '/tmp/x' } } },
      { type: 'tool_result', data: { name: 'read_file', result: 'the quick brown fox jumps over the lazy dog' } },
      { type: 'done', data: { content: 'ok', hitIterationLimit: false } },
    ]

    const executor = createDzupAgentRunExecutor({ tokenLifecycleRegistry: registry })
    const ctx = await makeContext()

    await executor(ctx)

    expect(captured).toBeDefined()
    const phases = captured!.report.phases.map((p) => p.phase)
    expect(phases).toContain('tool-result')
    // prompt + tool-result + output should all show up.
    expect(phases).toContain('prompt')
    expect(phases).toContain('output')
  })
})
