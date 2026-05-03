import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RuleCompiler } from '@dzupagent/adapter-rules'
import type { AdapterRule } from '@dzupagent/adapter-rules'

import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import { ADAPTER_TRACE_ENV_OPTION } from '../observability/adapter-tracer.js'
import type { AgentEvent, AgentInput } from '../types.js'
import { withAdapterRuleRuntimePlan } from '../rules.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

/**
 * Minimal concrete BaseCliAdapter used to exercise the run lifecycle. Maps
 * the handful of stream records it cares about into AgentEvents so tests can
 * simulate success, failure, and cancellation paths.
 */
class TestCliAdapter extends BaseCliAdapter {
  constructor() {
    super('claude')
  }
  protected getBinaryName(): string {
    return 'test-bin'
  }
  protected buildArgs(): string[] {
    return []
  }
  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: 'ok',
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    if (record['type'] === 'failed') {
      return {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: 'provider failure',
        timestamp: Date.now(),
      }
    }
    return undefined
  }
}

describe('BaseCliAdapter ArtifactWatcher lifecycle', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts a watcher on run begin and stops it when the run completes', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const input: AgentInput = { prompt: 'hello', workingDirectory: '/tmp/work' }
    const events = await collectEvents(adapter.execute(input))

    expect(events.map((e) => e.type)).toContain('adapter:started')
    expect(factory).toHaveBeenCalledTimes(1)
    const [paths, providerId] = factory.mock.calls[0]!
    expect(providerId).toBe('claude')
    expect(paths).toEqual(
      expect.arrayContaining([expect.stringContaining('.claude')]),
    )
    expect(stop).toHaveBeenCalledTimes(1)
    expect(adapter.getMonitorStatus()).toMatchObject({
      state: 'ready',
      supported: true,
      monitorIntrospection: 'deep',
    })
  })

  it('reports active monitor status while stopping a running watcher', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const adapter = new TestCliAdapter()
    const stop = vi.fn(() => {
      expect(adapter.getMonitorStatus()).toMatchObject({
        state: 'active',
        supported: true,
        watchedPathCount: expect.any(Number),
      })
    })
    const factory = vi.fn(() => ({ stop }))

    adapter.setArtifactWatcherFactory(factory)
    await collectEvents(adapter.execute({ prompt: 'hello', workingDirectory: '/tmp/work' }))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(adapter.getMonitorStatus().state).toBe('ready')
  })

  it('stops the watcher even when the provider run fails', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'failed' }
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.some((e) => e.type === 'adapter:failed')).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the watcher when the spawn throws (unexpected error path)', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('boom')
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when no watcher factory has been wired', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const adapter = new TestCliAdapter()
    // Deliberately do not wire a factory — integration must remain a no-op.

    await expect(collectEvents(adapter.execute({ prompt: 'x' }))).resolves.toBeDefined()
    expect(adapter.getMonitorStatus()).toMatchObject({
      state: 'not_configured',
      supported: true,
      monitorIntrospection: 'deep',
    })
  })

  it('reports failed_to_start when the watcher factory throws', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(() => {
      throw new Error('monitor unavailable')
    })

    await collectEvents(adapter.execute({ prompt: 'x', workingDirectory: '/tmp/work' }))

    expect(adapter.getMonitorStatus()).toMatchObject({
      state: 'failed_to_start',
      supported: true,
      monitorIntrospection: 'deep',
      watchedPathCount: expect.any(Number),
      lastError: 'Artifact watcher factory failed to start',
    })
  })

  it('adds compiled adapter-rule watcher paths to the watcher factory input', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const rules: AdapterRule[] = [
      {
        id: 'claude-artifacts',
        name: 'Claude artifacts',
        scope: 'workspace',
        appliesToProviders: ['claude'],
        effects: [
          { kind: 'watch_path', path: 'artifacts/reviews', artifactKind: 'review' },
          { kind: 'prompt_section', purpose: 'task', content: 'Use review evidence.' },
        ],
      },
    ]
    const plan = new RuleCompiler().compile(rules, {
      providerId: 'claude',
      workspaceDir: '/tmp/work',
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))
    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const input = withAdapterRuleRuntimePlan(
      { prompt: 'hello', workingDirectory: '/tmp/work' },
      plan,
    )
    const events = await collectEvents(adapter.execute(input))

    expect(events.map((event) => event.type)).toContain('adapter:started')
    expect(factory).toHaveBeenCalledTimes(1)
    const [paths] = factory.mock.calls[0]!
    expect(paths).toEqual(
      expect.arrayContaining([
        '/tmp/work/.claude',
        '/tmp/work/.dzupagent',
        '/tmp/work/artifacts/reviews',
      ]),
    )
    expect(paths.filter((path: string) => path === '/tmp/work/.claude')).toHaveLength(1)
  })

  it('passes per-run trace propagation env into the spawned CLI process', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const adapter = new TestCliAdapter()
    const traceparent = '00-aaaa1111bbbb2222cccc3333dddd4444-eeee5555ffff6666-01'

    await collectEvents(adapter.execute({
      prompt: 'hello',
      options: {
        [ADAPTER_TRACE_ENV_OPTION]: { TRACEPARENT: traceparent },
      },
    }))

    expect(mockSpawnAndStreamJsonl).toHaveBeenCalledTimes(1)
    const spawnOptions = mockSpawnAndStreamJsonl.mock.calls[0]![2]
    expect(spawnOptions.env?.['TRACEPARENT']).toBe(traceparent)
  })
})
