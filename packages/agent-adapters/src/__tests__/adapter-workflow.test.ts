import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

import {
  defineWorkflow,
  AdapterWorkflowBuilder,
  AdapterWorkflow,
} from '../workflow/adapter-workflow.js'
import type { AdapterWorkflowEvent } from '../workflow/adapter-workflow.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
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
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: 'resumed',
        result,
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

/**
 * Creates a mock adapter whose result echoes the resolved prompt,
 * so tests can verify template resolution.
 */
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
        result: input.prompt, // echo the resolved prompt
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      // no-op
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

/**
 * Creates a mock adapter that always fails.
 */
function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMsg = 'Adapter failure',
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
        type: 'adapter:failed',
        providerId,
        error: errorMsg,
        code: 'TEST_FAILURE',
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

function createRegistry(adapters: AgentCLIAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const adapter of adapters) {
    registry.register(adapter)
  }
  return registry
}

// ---------------------------------------------------------------------------
// Tests: defineWorkflow / AdapterWorkflowBuilder
// ---------------------------------------------------------------------------

describe('AdapterWorkflowBuilder', () => {
  it('creates builder with config via defineWorkflow', () => {
    const builder = defineWorkflow({ id: 'test-wf' })
    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
  })

  it('chains .step() calls', () => {
    const builder = defineWorkflow({ id: 'test' })
      .step({ id: 'a', prompt: 'Step A' })
      .step({ id: 'b', prompt: 'Step B' })

    // Builder should be chainable
    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
  })

  it('.parallel() adds parallel node', () => {
    const builder = defineWorkflow({ id: 'test' })
      .parallel([
        { id: 'p1', prompt: 'Parallel 1' },
        { id: 'p2', prompt: 'Parallel 2' },
      ])

    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
  })

  it('.branch() adds conditional node', () => {
    const builder = defineWorkflow({ id: 'test' })
      .branch(
        (state) => (state['flag'] ? 'yes' : 'no'),
        {
          yes: [{ id: 'y1', prompt: 'Yes path' }],
          no: [{ id: 'n1', prompt: 'No path' }],
        },
      )

    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
  })

  it('.transform() adds state transform', () => {
    const builder = defineWorkflow({ id: 'test' })
      .transform('combine', (state) => ({ ...state, combined: true }))

    expect(builder).toBeInstanceOf(AdapterWorkflowBuilder)
  })

  it('.build() returns AdapterWorkflow', () => {
    const workflow = defineWorkflow({ id: 'test' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    expect(workflow).toBeInstanceOf(AdapterWorkflow)
    expect(workflow.id).toBe('test')
  })
})

// ---------------------------------------------------------------------------
// Tests: AdapterWorkflow.run()
// ---------------------------------------------------------------------------

describe('AdapterWorkflow.run()', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    registry = createRegistry([createMockAdapter('claude')])
  })

  it('executes sequential steps', async () => {
    const workflow = defineWorkflow({ id: 'seq' })
      .step({ id: 'step1', prompt: 'First' })
      .step({ id: 'step2', prompt: 'Second' })
      .build()

    const result = await workflow.run(registry)

    expect(result.success).toBe(true)
    expect(result.workflowId).toBe('seq')
    expect(result.stepResults).toHaveLength(2)
    expect(result.stepResults[0]!.stepId).toBe('step1')
    expect(result.stepResults[1]!.stepId).toBe('step2')
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('resolves {{prev}} template variable', async () => {
    const echoRegistry = createRegistry([createEchoAdapter('claude')])

    const workflow = defineWorkflow({ id: 'template' })
      .step({ id: 'first', prompt: 'Hello World' })
      .step({ id: 'second', prompt: 'Previous: {{prev}}' })
      .build()

    const result = await workflow.run(echoRegistry)

    expect(result.success).toBe(true)
    // The echo adapter returns the resolved prompt, so step2 should have resolved {{prev}}
    expect(result.stepResults[1]!.result).toBe('Previous: Hello World')
  })

  it('resolves {{state.key}} template variable', async () => {
    const echoRegistry = createRegistry([createEchoAdapter('claude')])

    const workflow = defineWorkflow({ id: 'state-template' })
      .step({ id: 'first', prompt: 'Hello' })
      .step({ id: 'second', prompt: 'From state: {{state.first}}' })
      .build()

    const result = await workflow.run(echoRegistry)

    expect(result.success).toBe(true)
    // Step 'first' result is 'Hello', stored under state.first
    expect(result.stepResults[1]!.result).toBe('From state: Hello')
  })

  it('executes parallel steps', async () => {
    const claudeAdapter = createMockAdapter('claude', 'Claude result')
    const codexAdapter = createMockAdapter('codex', 'Codex result')
    const parallelRegistry = createRegistry([claudeAdapter, codexAdapter])

    const workflow = defineWorkflow({ id: 'par' })
      .parallel([
        { id: 'task_a', prompt: 'Task A' },
        { id: 'task_b', prompt: 'Task B' },
      ])
      .build()

    const result = await workflow.run(parallelRegistry)

    expect(result.success).toBe(true)
    expect(result.stepResults.length).toBeGreaterThanOrEqual(2)
    // Both step results should be present in final state
    expect(result.finalState['task_a']).toBeDefined()
    expect(result.finalState['task_b']).toBeDefined()
  })

  it('evaluates branch conditions and follows selected path', async () => {
    const echoRegistry = createRegistry([createEchoAdapter('claude')])

    const workflow = defineWorkflow({ id: 'branch' })
      .branch(
        (state) => (state['mode'] === 'fast' ? 'quick' : 'thorough'),
        {
          quick: [{ id: 'fast-step', prompt: 'Quick analysis' }],
          thorough: [{ id: 'deep-step', prompt: 'Deep analysis' }],
        },
      )
      .build()

    const result = await workflow.run(echoRegistry, {
      initialState: { mode: 'fast' },
    })

    expect(result.success).toBe(true)
    expect(result.stepResults.some((s) => s.stepId === 'fast-step')).toBe(true)
    expect(result.stepResults.some((s) => s.stepId === 'deep-step')).toBe(false)
  })

  it('transform step modifies state', async () => {
    const echoRegistry = createRegistry([createEchoAdapter('claude')])

    const workflow = defineWorkflow({ id: 'xform' })
      .step({ id: 'step1', prompt: 'Hello' })
      .transform('enrich', (state) => ({
        ...state,
        enriched: `Enriched: ${String(state['step1'])}`,
      }))
      .step({ id: 'step2', prompt: '{{state.enriched}}' })
      .build()

    const result = await workflow.run(echoRegistry)

    expect(result.success).toBe(true)
    expect(result.finalState['enriched']).toBe('Enriched: Hello')
    expect(result.stepResults[1]!.result).toBe('Enriched: Hello')
  })

  it('retries on failure when maxRetries > 0', async () => {
    let callCount = 0
    const flakyAdapter: AgentCLIAdapter = {
      providerId: 'claude',
      async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
        callCount++
        if (callCount < 3) {
          // Fail the first 2 attempts by not emitting completed
          yield {
            type: 'adapter:started',
            providerId: 'claude',
            sessionId: 'sess',
            timestamp: Date.now(),
          }
          yield {
            type: 'adapter:failed',
            providerId: 'claude',
            error: 'Transient failure',
            code: 'TRANSIENT',
            timestamp: Date.now(),
          }
        } else {
          yield {
            type: 'adapter:started',
            providerId: 'claude',
            sessionId: 'sess',
            timestamp: Date.now(),
          }
          yield {
            type: 'adapter:completed',
            providerId: 'claude',
            sessionId: 'sess',
            result: 'Success on retry',
            durationMs: 5,
            timestamp: Date.now(),
          }
        }
      },
      async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId: 'claude' as const, sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    }

    const retryRegistry = createRegistry([flakyAdapter])

    const workflow = defineWorkflow({ id: 'retry' })
      .step({ id: 'flaky', prompt: 'Do it', maxRetries: 3 })
      .build()

    const result = await workflow.run(retryRegistry)

    expect(result.success).toBe(true)
    expect(result.stepResults[0]!.retries).toBeGreaterThan(0)
  })

  it('emits workflow events', async () => {
    const events: AdapterWorkflowEvent[] = []

    const workflow = defineWorkflow({ id: 'events-test' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    await workflow.run(registry, {
      onEvent: (e) => events.push(e),
    })

    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('workflow:started')
    expect(eventTypes).toContain('step:started')
    expect(eventTypes).toContain('step:completed')
    expect(eventTypes).toContain('workflow:completed')
  })

  it('returns AdapterWorkflowResult with stepResults', async () => {
    const workflow = defineWorkflow({ id: 'result-test' })
      .step({ id: 'a', prompt: 'Hello' })
      .build()

    const result = await workflow.run(registry)

    expect(result.workflowId).toBe('result-test')
    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(1)
    expect(result.stepResults[0]!.providerId).toBe('claude')
    expect(result.stepResults[0]!.success).toBe(true)
    expect(result.stepResults[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.finalState).toBeDefined()
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('respects abort signal', async () => {
    const ac = new AbortController()
    ac.abort() // Already aborted

    const workflow = defineWorkflow({ id: 'abort-test' })
      .step({ id: 'a', prompt: 'Should not run' })
      .build()

    const result = await workflow.run(registry, { signal: ac.signal })

    expect(result.success).toBe(false)
  })

  it('failed workflow reports error', async () => {
    const failRegistry = createRegistry([createFailingAdapter('claude')])

    const workflow = defineWorkflow({ id: 'fail-test' })
      .step({ id: 'a', prompt: 'Will fail' })
      .build()

    const result = await workflow.run(failRegistry)

    expect(result.success).toBe(false)
    expect(result.stepResults.some((s) => !s.success)).toBe(true)
  })

  it('uses initialState for template resolution', async () => {
    const echoRegistry = createRegistry([createEchoAdapter('claude')])

    const workflow = defineWorkflow({ id: 'init-state' })
      .step({ id: 'step1', prompt: 'Context: {{state.context}}' })
      .build()

    const result = await workflow.run(echoRegistry, {
      initialState: { context: 'bug in login' },
    })

    expect(result.success).toBe(true)
    expect(result.stepResults[0]!.result).toBe('Context: bug in login')
  })
})
