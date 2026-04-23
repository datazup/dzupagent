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

function createEchoAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
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
        result: input.prompt,
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
  registry.register(createEchoAdapter('claude'))
  return registry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow Conditional Skip', () => {
  it('skipIf skips step when condition is true', async () => {
    const registry = createRegistry()
    const events: AdapterWorkflowEvent[] = []

    const workflow = defineWorkflow({ id: 'skip-test' })
      .step({ id: 'first', prompt: 'Hello' })
      .step({
        id: 'skipped',
        prompt: 'Should not run',
        skipIf: () => true,
      })
      .step({ id: 'last', prompt: 'After skip' })
      .build()

    const result = await workflow.run(registry, {
      onEvent: (e) => events.push(e),
    })

    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(3)

    const skippedStep = result.stepResults.find((s) => s.stepId === 'skipped')
    expect(skippedStep).toBeDefined()
    expect(skippedStep!.result).toBe('')
    expect(skippedStep!.durationMs).toBe(0)
    expect(skippedStep!.success).toBe(true)

    // Verify skip event was emitted
    const skipEvents = events.filter((e) => e.type === 'step:skipped')
    expect(skipEvents).toHaveLength(1)
    expect(skipEvents[0]).toMatchObject({
      type: 'step:skipped',
      workflowId: 'skip-test',
      stepId: 'skipped',
    })
  })

  it('skipIf allows step when condition is false', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'no-skip-test' })
      .step({
        id: 'not-skipped',
        prompt: 'I should run',
        skipIf: () => false,
      })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(1)
    expect(result.stepResults[0]!.result).toBe('I should run')
  })

  it('skipDefault provides result for skipped steps', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'skip-default-test' })
      .step({
        id: 'skipped-with-default',
        prompt: 'Should not run',
        skipIf: () => true,
        skipDefault: 'fallback value',
      })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    const skippedStep = result.stepResults.find((s) => s.stepId === 'skipped-with-default')
    expect(skippedStep!.result).toBe('fallback value')
  })

  it('skipped step result propagates to downstream steps', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'skip-propagate-test' })
      .step({
        id: 'skipped',
        prompt: 'Should not run',
        skipIf: () => true,
        skipDefault: 'default-result',
      })
      .step({ id: 'downstream', prompt: 'Got: {{state.skipped}}' })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    // The downstream step should see the skipDefault value in state
    expect(result.finalState['skipped']).toBe('default-result')
    expect(result.stepResults[1]!.result).toBe('Got: default-result')
  })

  it('skipIf receives current workflow state', async () => {
    const registry = createRegistry()

    const workflow = defineWorkflow({ id: 'skip-state-test' })
      .step({ id: 'first', prompt: 'Hello' })
      .step({
        id: 'conditional',
        prompt: 'Should be skipped',
        skipIf: (state) => state['first'] === 'Hello',
        skipDefault: 'was skipped',
      })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    expect(result.stepResults[1]!.result).toBe('was skipped')
  })
})
