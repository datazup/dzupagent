import { describe, it, expect } from 'vitest'

import {
  defineWorkflow,
  AdapterWorkflowBuilder,
} from '../workflow/adapter-workflow.js'
import type { LoopConfig, AdapterWorkflowEvent } from '../workflow/adapter-workflow.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createCountingAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  let callCount = 0
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      callCount++
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
        result: `call-${callCount}: ${input.prompt}`,
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
      // no-op
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createRegistry(adapters: AgentCLIAdapter[]): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry()
  for (const adapter of adapters) {
    registry.register(adapter)
  }
  return registry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow Loop', () => {
  it('executes loop body until condition returns false', async () => {
    const adapter = createCountingAdapter('test-provider' as AdapterProviderId)
    const registry = createRegistry([adapter])

    const workflow = defineWorkflow({ id: 'loop-test' })
      .loop({
        id: 'counter-loop',
        maxIterations: 10,
        condition: (state) => {
          const iteration = (state['counter-loop_iteration'] as number | undefined) ?? 0
          return iteration < 3
        },
        steps: [
          { id: 'work', prompt: 'Do work iteration' },
        ],
      })
      .build()

    const result = await workflow.run(registry)
    expect(result.success).toBe(true)
    // condition checked at start of each iteration: iterations 0,1,2 pass, iteration 3 fails
    expect(result.stepResults.length).toBe(3)
    expect(result.finalState['counter-loop_iteration']).toBe(3)
  })

  it('respects maxIterations safety bound', async () => {
    const adapter = createCountingAdapter('test-provider' as AdapterProviderId)
    const registry = createRegistry([adapter])

    const workflow = defineWorkflow({ id: 'max-iter-test' })
      .loop({
        id: 'infinite-loop',
        maxIterations: 5,
        condition: () => true, // always true
        steps: [
          { id: 'work', prompt: 'Do work' },
        ],
      })
      .build()

    const result = await workflow.run(registry)
    // Default onMaxIterations is 'continue', so workflow succeeds
    expect(result.success).toBe(true)
    expect(result.stepResults.length).toBe(5)
    expect(result.finalState['infinite-loop_iteration']).toBe(5)
  })

  it('fails when onMaxIterations is "fail" and limit reached', async () => {
    const adapter = createCountingAdapter('test-provider' as AdapterProviderId)
    const registry = createRegistry([adapter])

    const workflow = defineWorkflow({ id: 'fail-loop-test' })
      .loop({
        id: 'bounded-loop',
        maxIterations: 3,
        condition: () => true, // always true
        steps: [
          { id: 'work', prompt: 'Do work' },
        ],
        onMaxIterations: 'fail',
      })
      .build()

    const result = await workflow.run(registry)
    expect(result.success).toBe(false)
  })

  it('tracks iteration count in state', async () => {
    const adapter = createCountingAdapter('test-provider' as AdapterProviderId)
    const registry = createRegistry([adapter])
    const observedIterations: number[] = []

    const workflow = defineWorkflow({ id: 'iter-track-test' })
      .loop({
        id: 'tracked-loop',
        maxIterations: 4,
        condition: (state) => {
          const iter = state['tracked-loop_iteration'] as number | undefined
          if (iter != null) observedIterations.push(iter)
          return (iter ?? 0) < 3
        },
        steps: [
          { id: 'work', prompt: 'Do work' },
        ],
      })
      .build()

    const result = await workflow.run(registry)
    expect(result.success).toBe(true)
    expect(result.finalState['tracked-loop_iteration']).toBe(3)
    // The condition is checked on iterations 1, 2, 3 (after setting iteration count)
    // Iteration 3 causes the condition to return false
    expect(observedIterations).toContain(1)
    expect(observedIterations).toContain(2)
    expect(observedIterations).toContain(3)
  })

  it('.loop() is chainable in builder API', () => {
    const loopConfig: LoopConfig = {
      id: 'my-loop',
      maxIterations: 5,
      condition: () => false,
      steps: [{ id: 'inner', prompt: 'do stuff' }],
    }

    const builder = defineWorkflow({ id: 'chain-test' })
      .step({ id: 'before', prompt: 'Before loop' })
      .loop(loopConfig)
      .step({ id: 'after', prompt: 'After loop' })

    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
    // Should build without errors
    const workflow = builder.build()
    expect(workflow.id).toBe('chain-test')
  })

  it('emits step events for each loop iteration', async () => {
    const adapter = createCountingAdapter('test-provider' as AdapterProviderId)
    const registry = createRegistry([adapter])
    const events: AdapterWorkflowEvent[] = []

    const workflow = defineWorkflow({ id: 'event-loop-test' })
      .loop({
        id: 'evented-loop',
        maxIterations: 2,
        condition: (state) => {
          const iter = state['evented-loop_iteration'] as number | undefined
          return (iter ?? 0) < 2
        },
        steps: [
          { id: 'work', prompt: 'Do work' },
        ],
      })
      .build()

    await workflow.run(registry, {
      onEvent: (e) => events.push(e),
    })

    const stepStarted = events.filter((e) => e.type === 'step:started')
    const stepCompleted = events.filter((e) => e.type === 'step:completed')
    expect(stepStarted.length).toBe(2)
    expect(stepCompleted.length).toBe(2)
  })
})
