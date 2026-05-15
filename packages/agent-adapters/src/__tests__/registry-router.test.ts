import { describe, expect, it } from 'vitest'
import { ForgeError } from '@dzupagent/core'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'

import { AdapterHealthMonitor } from '../registry/health-monitor.js'
import { AdapterRegistryCore } from '../registry/registry-core.js'
import { AdapterRegistryRouter } from '../registry/registry-router.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'
import { collectEvents } from './test-helpers.js'
import {
  POLICY_ACTIVE_OPTION_KEY,
  POLICY_CONFORMANCE_MODE_OPTION_KEY,
} from '../pipeline/policy-enforcement-pipeline.js'

function makeAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[] = [],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const e of events) yield e
    },
    async *resumeSession(_s: string, _i: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function makeCapturingAdapter(
  providerId: AdapterProviderId,
  onInput: (input: AgentInput) => void,
  events: AgentEvent[] = [],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      onInput(input)
      for (const e of events) yield e
    },
    async *resumeSession(_s: string, _i: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

const successEvents = (providerId: AdapterProviderId): AgentEvent[] => [
  { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() },
  {
    type: 'adapter:completed',
    providerId,
    sessionId: 's',
    result: 'ok',
    durationMs: 1,
    timestamp: Date.now(),
  },
]

const failEvents = (providerId: AdapterProviderId): AgentEvent[] => [
  { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() },
  {
    type: 'adapter:failed',
    providerId,
    error: 'bad',
    code: 'ADAPTER_EXECUTION_FAILED',
    timestamp: Date.now(),
  },
]

const task: TaskDescriptor = { prompt: 'p', tags: [] }
const input: AgentInput = { prompt: 'p' }

const fixedRouter: TaskRoutingStrategy = {
  name: 'fixed',
  route(_t: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
    return {
      provider: available[0] ?? 'claude',
      reason: 'fixed',
      confidence: 1,
      fallbackProviders: available.slice(1),
    }
  },
}

function buildRouter(...adapters: AgentCLIAdapter[]): AdapterRegistryRouter {
  const health = new AdapterHealthMonitor()
  const core = new AdapterRegistryCore(health)
  for (const a of adapters) core.register(a)
  const router = new AdapterRegistryRouter(core, health, undefined)
  router.setStrategy(fixedRouter)
  return router
}

function buildRouterWithBus(...adapters: AgentCLIAdapter[]): {
  router: AdapterRegistryRouter
  emitted: DzupEvent[]
} {
  const health = new AdapterHealthMonitor()
  const core = new AdapterRegistryCore(health)
  const bus = createEventBus()
  const emitted: DzupEvent[] = []
  bus.onAny((event) => emitted.push(event))
  core.setEventBus(bus)
  for (const adapter of adapters) core.register(adapter)
  const router = new AdapterRegistryRouter(core, health, undefined)
  router.setStrategy(fixedRouter)
  return { router, emitted }
}

describe('AdapterRegistryRouter', () => {
  it('getForTask throws ALL_ADAPTERS_EXHAUSTED when no healthy adapters exist', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)
    const router = new AdapterRegistryRouter(core, health, undefined)
    expect(() => router.getForTask(task)).toThrow(ForgeError)
  })

  it('executeWithFallback returns success on first adapter and emits routing progress', async () => {
    const router = buildRouter(makeAdapter('claude', successEvents('claude')))
    const events = await collectEvents(router.executeWithFallback(input, task))

    const progress = events.filter((e) => e.type === 'adapter:progress')
    expect(progress.length).toBeGreaterThanOrEqual(2) // routing + primary
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'claude')).toBe(true)
  })

  it('falls back to next provider when primary emits failure event', async () => {
    const router = buildRouter(
      makeAdapter('claude', failEvents('claude')),
      makeAdapter('codex', successEvents('codex')),
    )
    const events = await collectEvents(router.executeWithFallback(input, task))

    expect(events.some((e) => e.type === 'adapter:failed' && e.providerId === 'claude')).toBe(true)
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(true)
  })

  it('records circuit-breaker failures so unhealthy adapters are skipped on next call', async () => {
    const health = new AdapterHealthMonitor({ failureThreshold: 1 })
    const core = new AdapterRegistryCore(health)
    core.register(makeAdapter('claude', failEvents('claude')))
    core.register(makeAdapter('codex', successEvents('codex')))
    const router = new AdapterRegistryRouter(core, health, undefined)
    router.setStrategy(fixedRouter)

    await collectEvents(router.executeWithFallback(input, task))
    expect(health.getCircuitState('claude')).toBe('open')

    // Second call: claude is already open, codex should be primary
    const events = await collectEvents(router.executeWithFallback(input, task))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed?.providerId).toBe('codex')
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when every adapter fails', async () => {
    const router = buildRouter(
      makeAdapter('claude', failEvents('claude')),
      makeAdapter('codex', failEvents('codex')),
    )
    await expect(collectEvents(router.executeWithFallback(input, task))).rejects.toThrow(
      'All adapters failed',
    )
  })

  it('re-projects policy per fallback attempt provider', async () => {
    const captured: Partial<Record<AdapterProviderId, AgentInput>> = {}
    const router = buildRouter(
      makeCapturingAdapter('goose', (i) => { captured.goose = i }, failEvents('goose')),
      makeCapturingAdapter('codex', (i) => { captured.codex = i }, successEvents('codex')),
    )
    const policyInput: AgentInput = {
      prompt: 'p',
      policyContext: {
        activePolicy: { sandboxMode: 'workspace-write', maxTurns: 3 },
        conformanceMode: 'strict',
      },
    }

    const events = await collectEvents(router.executeWithFallback(policyInput, task))
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(true)
    expect(captured.goose?.options?.['permissionMode']).toBe('workspace')
    expect(captured.goose?.options?.['sandboxMode']).toBe('workspace-write')
    expect(captured.goose?.policyContext).toBeUndefined()
    expect(captured.codex?.options?.['approvalPolicy']).toBeUndefined()
    expect(captured.codex?.options?.['sandboxMode']).toBe('workspace-write')
    expect(captured.codex?.policyContext).toBeUndefined()
  })

  it('supports legacy option-key policy metadata for compatibility', async () => {
    const captured: Partial<Record<AdapterProviderId, AgentInput>> = {}
    const router = buildRouter(
      makeCapturingAdapter('goose', (i) => { captured.goose = i }, successEvents('goose')),
    )
    const legacyPolicyInput: AgentInput = {
      prompt: 'p',
      options: {
        [POLICY_ACTIVE_OPTION_KEY]: { sandboxMode: 'workspace-write', maxTurns: 3 },
        [POLICY_CONFORMANCE_MODE_OPTION_KEY]: 'strict',
      },
    }

    const events = await collectEvents(router.executeWithFallback(legacyPolicyInput, task))
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'goose')).toBe(true)
    expect(captured.goose?.options?.['permissionMode']).toBe('workspace')
    expect(captured.goose?.options?.['sandboxMode']).toBe('workspace-write')
  })

  it('continues fallback when strict policy conformance blocks a provider', async () => {
    const router = buildRouter(
      makeAdapter('openai', successEvents('openai')),
      makeAdapter('codex', successEvents('codex')),
    )
    const policyInput: AgentInput = {
      prompt: 'p',
      options: {
        [POLICY_ACTIVE_OPTION_KEY]: { sandboxMode: 'workspace-write' },
        [POLICY_CONFORMANCE_MODE_OPTION_KEY]: 'strict',
      },
    }

    const events = await collectEvents(router.executeWithFallback(policyInput, task))
    expect(events.some((e) => e.type === 'adapter:failed' && e.providerId === 'openai')).toBe(true)
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(true)
  })

  it('warn-only policy violations continue and emit structured telemetry', async () => {
    const { router, emitted } = buildRouterWithBus(makeAdapter('openai', successEvents('openai')))
    const policyInput: AgentInput = {
      prompt: 'p',
      policyContext: {
        activePolicy: { blockedTools: ['bash'] },
        conformanceMode: 'warn-only',
      },
    }

    const events = await collectEvents(router.executeWithFallback(policyInput, task))
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'openai')).toBe(true)
    const warning = events.find((e) => (
      e.type === 'adapter:progress' &&
      e.phase === 'policy:conformance_warning'
    ))
    expect(warning).toMatchObject({
      type: 'adapter:progress',
      providerId: 'openai',
      details: expect.objectContaining({
        kind: 'policy_conformance_violation',
        providerId: 'openai',
        field: 'blockedTools',
        fallbackBehavior: 'continue_primary_attempt',
      }),
    })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'policy:conformance_violation',
        providerId: 'openai',
        field: 'blockedTools',
        conformanceMode: 'warn-only',
        fallbackBehavior: 'continue_primary_attempt',
      }),
    ]))
  })

  it('does not leak policy projection across runs', async () => {
    const capturedInputs: AgentInput[] = []
    const router = buildRouter(
      makeCapturingAdapter('codex', (i) => { capturedInputs.push(i) }, successEvents('codex')),
    )

    const withPolicy: AgentInput = {
      prompt: 'p',
      policyContext: {
        activePolicy: { sandboxMode: 'workspace-write', maxTurns: 2 },
        conformanceMode: 'strict',
      },
    }
    const plain: AgentInput = { prompt: 'p' }

    await collectEvents(router.executeWithFallback(withPolicy, task))
    await collectEvents(router.executeWithFallback(plain, task))

    expect(capturedInputs).toHaveLength(2)
    expect(capturedInputs[0]?.options?.['sandboxMode']).toBe('workspace-write')
    expect(capturedInputs[1]?.options?.['sandboxMode']).toBeUndefined()
    expect(capturedInputs[1]?.policyContext).toBeUndefined()
  })
})
