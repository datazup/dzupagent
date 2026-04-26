import { describe, it, expect } from 'vitest'

import { defineWorkflow } from '../workflow/adapter-workflow.js'
import type { AdapterStepConfig } from '../workflow/adapter-workflow.js'
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

function createMockAdapter(
  providerId: AdapterProviderId,
  result = `Result from ${providerId}`,
): AgentCLIAdapter {
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
        result,
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 10,
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

describe('Step-Level Timeout', () => {
  it('timeoutMs is accepted in AdapterStepConfig', () => {
    const stepConfig: AdapterStepConfig = {
      id: 'timed-step',
      prompt: 'Do something',
      timeoutMs: 5000,
    }
    expect(stepConfig.timeoutMs).toBe(5000)
  })

  it('step completes normally when within timeout', async () => {
    const adapter = createMockAdapter('test-provider' as AdapterProviderId, 'fast result')
    const registry = createRegistry([adapter])

    const workflow = defineWorkflow({ id: 'timeout-test' })
      .step({
        id: 'fast-step',
        prompt: 'Quick operation',
        timeoutMs: 30_000, // generous timeout
      })
      .build()

    const result = await workflow.run(registry)
    expect(result.success).toBe(true)
    expect(result.stepResults.length).toBe(1)
    expect(result.stepResults[0]!.result).toBe('fast result')
  })

  it('workflow with timeoutMs on multiple steps completes normally', async () => {
    const adapter = createMockAdapter('test-provider' as AdapterProviderId, 'result')
    const registry = createRegistry([adapter])

    const workflow = defineWorkflow({ id: 'multi-timeout-test' })
      .step({ id: 'step1', prompt: 'First', timeoutMs: 10_000 })
      .step({ id: 'step2', prompt: 'Second', timeoutMs: 10_000 })
      .step({ id: 'step3', prompt: 'Third' }) // no timeout
      .build()

    const result = await workflow.run(registry)
    expect(result.success).toBe(true)
    expect(result.stepResults.length).toBe(3)
  })
})
