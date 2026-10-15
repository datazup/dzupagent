/**
 * DZUPAGENT-ERR-H-81 — a caller cancellation reported as a YIELDED
 * `adapter:failed` (AGENT_ABORTED / ADAPTER_ABORTED, as `emitFailedOnAbort`
 * adapters do) must not be billed as a provider outage: no further attempts,
 * no circuit-breaker failure, no `provider:failed`, and the run surfaces
 * AGENT_ABORTED. A registry timeout still records a failure and falls back.
 */
import { describe, expect, it, vi } from 'vitest'
import { ForgeError, createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'

import { AdapterHealthMonitor } from '../registry/health-monitor.js'
import { AdapterRegistryCore } from '../registry/registry-core.js'
import { AdapterRegistryRouter } from '../registry/registry-router.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'
import { stubCapabilities } from './adapter-capability-stub.js'

const fixedRouter: TaskRoutingStrategy = {
  name: 'fixed',
  route(_task, available) {
    return {
      provider: available[0] ?? 'auto',
      reason: 'fixed',
      confidence: 1,
      fallbackProviders: available.slice(1),
    }
  },
}

const task: TaskDescriptor = { prompt: 'p', tags: [], approvedFallbackProviders: ['claude', 'codex'] }

function makeAdapter(
  providerId: AdapterProviderId,
  run: (input: AgentInput) => AsyncGenerator<AgentEvent, void, undefined>,
): AgentCLIAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    getCapabilities: () => stubCapabilities(),
    providerId,
    execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      adapter.calls += 1
      return run(input)
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
  return adapter
}

/** Waits for its attempt signal to abort, then yields the given failure code (emitFailedOnAbort shape). */
function abortReportingAdapter(
  providerId: AdapterProviderId,
  code: string,
  onStart?: () => void,
) {
  return makeAdapter(providerId, async function* (input) {
    yield { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() }
    onStart?.()
    if (!input.signal?.aborted) {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    yield { type: 'adapter:failed', providerId, error: 'aborted', code, timestamp: Date.now() }
  })
}

function successAdapter(providerId: AdapterProviderId) {
  return makeAdapter(providerId, async function* () {
    yield { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() }
    yield {
      type: 'adapter:completed',
      providerId,
      sessionId: 's',
      result: 'ok',
      durationMs: 1,
      timestamp: Date.now(),
    }
  })
}

function build(adapters: AgentCLIAdapter[], defaultTimeoutMs?: number) {
  const health = new AdapterHealthMonitor({ failureThreshold: 1 })
  const recordFailure = vi.spyOn(health, 'recordFailure')
  const core = new AdapterRegistryCore(health)
  const bus = createEventBus()
  const emitted: DzupEvent[] = []
  bus.onAny((event) => {
    emitted.push(event)
  })
  core.setEventBus(bus)
  for (const adapter of adapters) core.register(adapter)
  const router = new AdapterRegistryRouter(core, health, defaultTimeoutMs)
  router.setStrategy(fixedRouter)
  return { router, health, recordFailure, emitted }
}

async function drain(gen: AsyncGenerator<AgentEvent, void, undefined>) {
  const events: AgentEvent[] = []
  let error: unknown
  try {
    for await (const event of gen) events.push(event)
  } catch (caught) {
    error = caught
  }
  return { events, error }
}

describe('registry fallback on caller abort (DZUPAGENT-ERR-H-81)', () => {
  for (const code of ['AGENT_ABORTED', 'ADAPTER_ABORTED']) {
    it(`a caller abort reported as a yielded ${code} stops the chain without circuit-breaker bookkeeping`, async () => {
      const caller = new AbortController()
      const claude = abortReportingAdapter('claude', code, () => caller.abort())
      const codex = successAdapter('codex')
      const { router, health, recordFailure, emitted } = build([claude, codex])

      const { events, error } = await drain(
        router.executeWithFallback({ prompt: 'p', signal: caller.signal }, task),
      )

      expect(ForgeError.is(error)).toBe(true)
      expect((error as ForgeError).code).toBe('AGENT_ABORTED')
      expect(codex.calls).toBe(0)
      expect(events.some((e) => e.type === 'adapter:completed')).toBe(false)
      expect(recordFailure).not.toHaveBeenCalled()
      expect(health.getCircuitState('claude')).toBe('closed')
      expect(emitted.some((e) => e.type === 'provider:failed')).toBe(false)
      expect(emitted.some((e) => e.type === 'agent:failed')).toBe(false)
    })
  }

  it('a failure observed after the caller aborted is not recorded even with a generic code', async () => {
    const caller = new AbortController()
    const claude = abortReportingAdapter('claude', 'ADAPTER_EXECUTION_FAILED', () => caller.abort())
    const codex = successAdapter('codex')
    const { router, recordFailure, emitted } = build([claude, codex])

    const { error } = await drain(
      router.executeWithFallback({ prompt: 'p', signal: caller.signal }, task),
    )

    expect((error as ForgeError).code).toBe('AGENT_ABORTED')
    expect(codex.calls).toBe(0)
    expect(recordFailure).not.toHaveBeenCalled()
    expect(emitted.some((e) => e.type === 'provider:failed')).toBe(false)
  })

  it('a registry timeout still records a failure and falls back to the next provider', async () => {
    const claude = abortReportingAdapter('claude', 'AGENT_ABORTED')
    const codex = successAdapter('codex')
    const { router, health, recordFailure, emitted } = build([claude, codex], 20)

    const { events, error } = await drain(router.executeWithFallback({ prompt: 'p' }, task))

    expect(error).toBeUndefined()
    expect(codex.calls).toBe(1)
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(true)
    expect(recordFailure).toHaveBeenCalledWith('claude')
    expect(health.getCircuitState('claude')).toBe('open')
    expect(emitted.some((e) => e.type === 'provider:failed')).toBe(true)
  })

  it('an ordinary provider failure without an abort still falls back', async () => {
    const claude = makeAdapter('claude', async function* () {
      yield { type: 'adapter:failed', providerId: 'claude', error: 'bad', code: 'ADAPTER_EXECUTION_FAILED', timestamp: Date.now() }
    })
    const codex = successAdapter('codex')
    const { router, recordFailure } = build([claude, codex])

    const { error } = await drain(router.executeWithFallback({ prompt: 'p' }, task))

    expect(error).toBeUndefined()
    expect(codex.calls).toBe(1)
    expect(recordFailure).toHaveBeenCalledWith('claude')
  })
})
