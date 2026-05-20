/**
 * Focused unit tests for `buildRuntimeBootstrap`. Verifies that:
 *   - default executor is wired when none provided
 *   - default executable agent resolver is created from the agent store
 *   - default in-memory event gateway is created from the bus
 *   - explicit overrides are honoured
 */
import { describe, it, expect, vi } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { buildRuntimeBootstrap } from '../runtime-config.js'
import { InMemoryEventGateway, type EventEnvelope } from '../../events/event-gateway.js'
import {
  ControlPlaneExecutableAgentResolver,
  AgentStoreExecutableAgentResolver,
} from '../../services/executable-agent-resolver.js'
import type { ForgeServerConfig } from '../types.js'
import type { RunExecutionContext, RunExecutor } from '../../runtime/run-worker.js'

function baseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('composition/runtime-config', () => {
  it('populates default run executor and resolver when not provided', () => {
    const cfg = baseConfig()
    const { runtimeConfig, effectiveRunExecutor, eventGateway } = buildRuntimeBootstrap(cfg)

    expect(typeof effectiveRunExecutor).toBe('function')
    expect(runtimeConfig.runExecutor).toBe(effectiveRunExecutor)
    expect(runtimeConfig.executableAgentResolver).toBeInstanceOf(
      ControlPlaneExecutableAgentResolver,
    )
    expect(eventGateway).toBeInstanceOf(InMemoryEventGateway)
  })

  it('honours an explicit runExecutor override', () => {
    const explicitExecutor: RunExecutor = async () => ({ output: 'mock' })
    const cfg = baseConfig({ runExecutor: explicitExecutor })
    const { runtimeConfig, effectiveRunExecutor } = buildRuntimeBootstrap(cfg)

    expect(effectiveRunExecutor).toBe(explicitExecutor)
    expect(runtimeConfig.runExecutor).toBe(explicitExecutor)
  })

  it('honours an explicit executableAgentResolver override', () => {
    const resolver = new AgentStoreExecutableAgentResolver(new InMemoryAgentStore())
    const cfg = baseConfig({ executableAgentResolver: resolver })
    const { runtimeConfig } = buildRuntimeBootstrap(cfg)

    expect(runtimeConfig.executableAgentResolver).toBe(resolver)
  })

  it('honours an explicit eventGateway override', () => {
    const eventBus = createEventBus()
    const customGateway = new InMemoryEventGateway(eventBus)
    const cfg = baseConfig({ eventBus, eventGateway: customGateway })
    const { eventGateway } = buildRuntimeBootstrap(cfg)
    expect(eventGateway).toBe(customGateway)
  })

  // SEC-M-01-FOLLOWUP — envelopes emitted via the default executor must
  // reach a tenant-scoped gateway subscriber with `tenantId` populated.
  it('default executor stamps tenantId on envelopes delivered to the gateway', async () => {
    vi.resetModules()
    vi.doMock('@dzupagent/agent/runtime', () => ({
      DzupAgent: class {
        async *stream(): AsyncGenerator<
          { type: string; data: Record<string, unknown> },
          void,
          undefined
        > {
          yield { type: 'tool_call', data: { name: 'read_file', args: {} } }
          yield { type: 'tool_result', data: { name: 'read_file', result: 'ok' } }
          yield { type: 'done', data: { content: 'done', hitIterationLimit: false } }
        }
      },
    }))
    vi.doMock('../../runtime/tool-resolver.js', () => ({
      resolveAgentTools: async () => ({
        tools: [],
        activated: [],
        unresolved: [],
        warnings: [],
        cleanup: async () => {},
      }),
    }))

    const { buildRuntimeBootstrap: bootstrap } = await import('../runtime-config.js')

    const eventBus = createEventBus()
    const cfg = baseConfig({ eventBus })
    const { effectiveRunExecutor, eventGateway } = bootstrap(cfg)

    const delivered: EventEnvelope[] = []
    eventGateway.subscribe({ tenantId: 'tenant-X' }, (env) => {
      delivered.push(env)
    })

    const ctx: RunExecutionContext = {
      runId: 'run-tenant-bootstrap-1',
      agentId: 'agent-tenant-bootstrap-1',
      input: { message: 'hello' },
      metadata: { tenantId: 'tenant-X' },
      agent: {
        id: 'agent-tenant-bootstrap-1',
        name: 'Agent Tenant Bootstrap',
        instructions: 'Be concise',
        modelTier: 'chat',
      },
      runStore: new InMemoryRunStore(),
      eventBus,
      modelRegistry: new ModelRegistry(),
      signal: new AbortController().signal,
    }

    await effectiveRunExecutor(ctx)
    // Drain the gateway's queueMicrotask deliveries.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(delivered.length).toBeGreaterThan(0)
    const types = new Set(delivered.map((env) => env.type))
    expect(types.has('tool:called')).toBe(true)
    expect(types.has('tool:result')).toBe(true)
    expect(types.has('agent:stream_done')).toBe(true)
    for (const env of delivered) {
      expect(env.tenantId).toBe('tenant-X')
    }

    vi.doUnmock('@dzupagent/agent/runtime')
    vi.doUnmock('../../runtime/tool-resolver.js')
  })
})
