import { describe, it, expect } from 'vitest'

import { defineWorkflow } from '../workflow/adapter-workflow.js'
import type { AdapterWorkflowEvent } from '../workflow/adapter-workflow.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}`,
        result: 'done',
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createRegistry(): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry()
  registry.register(createMockAdapter('claude'))
  return registry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow Versioning', () => {
  it('defineWorkflow accepts version', () => {
    const workflow = defineWorkflow({ id: 'v-test', version: '2.3.0' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const definition = workflow.toPipelineDefinition()
    expect(definition.version).toBe('2.3.0')
  })

  it('default version is 1.0.0', () => {
    const workflow = defineWorkflow({ id: 'default-v' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const definition = workflow.toPipelineDefinition()
    expect(definition.version).toBe('1.0.0')
  })

  it('version is included in workflow result', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'v-result', version: '3.1.0' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    expect(result.version).toBe('3.1.0')
  })

  it('default version is included in workflow result', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'v-default-result' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    expect(result.version).toBe('1.0.0')
  })

  it('version is included in workflow events', async () => {
    const registry = createRegistry()
    const events: AdapterWorkflowEvent[] = []

    const workflow = defineWorkflow({ id: 'v-events', version: '2.0.0' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    await workflow.run(registry, {
      onEvent: (e) => events.push(e),
    })

    const startedEvent = events.find((e) => e.type === 'workflow:started')
    expect(startedEvent).toBeDefined()
    expect(startedEvent).toMatchObject({
      type: 'workflow:started',
      workflowId: 'v-events',
      version: '2.0.0',
    })

    const completedEvent = events.find((e) => e.type === 'workflow:completed')
    expect(completedEvent).toBeDefined()
    expect(completedEvent).toMatchObject({
      type: 'workflow:completed',
      workflowId: 'v-events',
      version: '2.0.0',
    })
  })

  it('version is included in description config', () => {
    const workflow = defineWorkflow({
      id: 'full-config',
      version: '1.2.3',
      description: 'A test workflow',
    })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const definition = workflow.toPipelineDefinition()
    expect(definition.version).toBe('1.2.3')
    expect(definition.description).toBe('A test workflow')
  })
})
