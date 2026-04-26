/**
 * Focused unit tests for `buildRuntimeBootstrap`. Verifies that:
 *   - default executor is wired when none provided
 *   - default executable agent resolver is created from the agent store
 *   - default in-memory event gateway is created from the bus
 *   - explicit overrides are honoured
 */
import { describe, it, expect } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { buildRuntimeBootstrap } from '../runtime-config.js'
import { InMemoryEventGateway } from '../../events/event-gateway.js'
import {
  ControlPlaneExecutableAgentResolver,
  AgentStoreExecutableAgentResolver,
} from '../../services/executable-agent-resolver.js'
import type { ForgeServerConfig } from '../types.js'
import type { RunExecutor } from '../../runtime/run-worker.js'

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
})
