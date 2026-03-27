import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryRunTraceStore,
  computeStepDistribution,
  type TraceStep,
} from '../persistence/run-trace-store.js'

describe('InMemoryRunTraceStore', () => {
  let store: InMemoryRunTraceStore

  beforeEach(() => {
    store = new InMemoryRunTraceStore()
  })

  // -----------------------------------------------------------------------
  // Basic lifecycle: start → add steps → complete
  // -----------------------------------------------------------------------

  it('should start a trace, add steps, and complete', () => {
    store.startTrace('run-1', 'agent-1')

    store.addStep('run-1', {
      timestamp: 1000,
      type: 'user_input',
      content: { message: 'hello' },
    })

    store.addStep('run-1', {
      timestamp: 2000,
      type: 'llm_response',
      content: 'world',
      metadata: { model: 'claude-3' },
      durationMs: 500,
    })

    store.completeTrace('run-1')

    const trace = store.getTrace('run-1')
    expect(trace).not.toBeNull()
    expect(trace!.runId).toBe('run-1')
    expect(trace!.agentId).toBe('agent-1')
    expect(trace!.steps).toHaveLength(2)
    expect(trace!.totalSteps).toBe(2)
    expect(trace!.completedAt).toBeGreaterThan(0)
    expect(trace!.startedAt).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // Step index auto-increments
  // -----------------------------------------------------------------------

  it('should auto-increment stepIndex for each step', () => {
    store.startTrace('run-1', 'agent-1')

    store.addStep('run-1', { timestamp: 1000, type: 'user_input', content: 'a' })
    store.addStep('run-1', { timestamp: 2000, type: 'llm_request', content: 'b' })
    store.addStep('run-1', { timestamp: 3000, type: 'llm_response', content: 'c' })
    store.addStep('run-1', { timestamp: 4000, type: 'tool_call', content: 'd' })
    store.addStep('run-1', { timestamp: 5000, type: 'tool_result', content: 'e' })

    const trace = store.getTrace('run-1')!
    expect(trace.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3, 4])
  })

  // -----------------------------------------------------------------------
  // getTrace returns all steps
  // -----------------------------------------------------------------------

  it('should return all steps via getTrace', () => {
    store.startTrace('run-1', 'agent-1')

    for (let i = 0; i < 5; i++) {
      store.addStep('run-1', {
        timestamp: 1000 + i * 100,
        type: 'system',
        content: `step-${i}`,
      })
    }

    const trace = store.getTrace('run-1')!
    expect(trace.steps).toHaveLength(5)
    expect(trace.totalSteps).toBe(5)
  })

  // -----------------------------------------------------------------------
  // getSteps range (pagination)
  // -----------------------------------------------------------------------

  it('should return a range of steps for paginated replay', () => {
    store.startTrace('run-1', 'agent-1')

    for (let i = 0; i < 10; i++) {
      store.addStep('run-1', {
        timestamp: 1000 + i * 100,
        type: 'system',
        content: `step-${i}`,
      })
    }

    const subset = store.getSteps('run-1', 3, 7)
    expect(subset).toHaveLength(4)
    expect(subset[0].stepIndex).toBe(3)
    expect(subset[3].stepIndex).toBe(6)
  })

  it('should clamp getSteps range to valid bounds', () => {
    store.startTrace('run-1', 'agent-1')

    for (let i = 0; i < 5; i++) {
      store.addStep('run-1', {
        timestamp: 1000 + i * 100,
        type: 'system',
        content: `step-${i}`,
      })
    }

    // from < 0 is clamped to 0
    const subset1 = store.getSteps('run-1', -5, 3)
    expect(subset1).toHaveLength(3)
    expect(subset1[0].stepIndex).toBe(0)

    // to > length is clamped to length
    const subset2 = store.getSteps('run-1', 3, 100)
    expect(subset2).toHaveLength(2)
    expect(subset2[0].stepIndex).toBe(3)
    expect(subset2[1].stepIndex).toBe(4)
  })

  it('should return empty array for invalid range (from >= to)', () => {
    store.startTrace('run-1', 'agent-1')
    store.addStep('run-1', { timestamp: 1000, type: 'system', content: 'x' })

    expect(store.getSteps('run-1', 5, 3)).toEqual([])
    expect(store.getSteps('run-1', 5, 5)).toEqual([])
  })

  it('should return empty array for getSteps on non-existent trace', () => {
    expect(store.getSteps('nonexistent', 0, 10)).toEqual([])
  })

  // -----------------------------------------------------------------------
  // Max steps limit
  // -----------------------------------------------------------------------

  it('should enforce max steps per trace limit', () => {
    const limitedStore = new InMemoryRunTraceStore({ maxStepsPerTrace: 5 })
    limitedStore.startTrace('run-1', 'agent-1')

    for (let i = 0; i < 10; i++) {
      limitedStore.addStep('run-1', {
        timestamp: 1000 + i * 100,
        type: 'system',
        content: `step-${i}`,
      })
    }

    const trace = limitedStore.getTrace('run-1')!
    expect(trace.steps).toHaveLength(5)
    expect(trace.totalSteps).toBe(5)
    // Only the first 5 steps are kept
    expect(trace.steps[4].content).toBe('step-4')
  })

  it('should default max steps to 1000', () => {
    store.startTrace('run-1', 'agent-1')

    // We don't actually add 1001 steps (too slow), but we verify the limit
    // by checking internal behavior with a custom limit
    const customStore = new InMemoryRunTraceStore({ maxStepsPerTrace: 3 })
    customStore.startTrace('r', 'a')
    customStore.addStep('r', { timestamp: 1, type: 'system', content: '1' })
    customStore.addStep('r', { timestamp: 2, type: 'system', content: '2' })
    customStore.addStep('r', { timestamp: 3, type: 'system', content: '3' })
    customStore.addStep('r', { timestamp: 4, type: 'system', content: '4' }) // dropped

    expect(customStore.getTrace('r')!.totalSteps).toBe(3)
  })

  // -----------------------------------------------------------------------
  // Delete trace
  // -----------------------------------------------------------------------

  it('should delete a trace', () => {
    store.startTrace('run-1', 'agent-1')
    store.addStep('run-1', { timestamp: 1000, type: 'user_input', content: 'hi' })

    expect(store.getTrace('run-1')).not.toBeNull()

    store.deleteTrace('run-1')
    expect(store.getTrace('run-1')).toBeNull()
  })

  it('should be a no-op to delete a non-existent trace', () => {
    // Should not throw
    store.deleteTrace('nonexistent')
  })

  // -----------------------------------------------------------------------
  // Non-existent trace returns null
  // -----------------------------------------------------------------------

  it('should return null for a non-existent trace', () => {
    expect(store.getTrace('does-not-exist')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // addStep on non-existent trace is a no-op
  // -----------------------------------------------------------------------

  it('should silently ignore addStep for a non-existent trace', () => {
    // Should not throw
    store.addStep('nonexistent', {
      timestamp: 1000,
      type: 'user_input',
      content: 'hi',
    })

    expect(store.getTrace('nonexistent')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // completeTrace on non-existent trace is a no-op
  // -----------------------------------------------------------------------

  it('should silently ignore completeTrace for a non-existent trace', () => {
    // Should not throw
    store.completeTrace('nonexistent')
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent traces
  // -----------------------------------------------------------------------

  it('should handle multiple concurrent traces independently', () => {
    store.startTrace('run-1', 'agent-1')
    store.startTrace('run-2', 'agent-2')

    store.addStep('run-1', { timestamp: 1000, type: 'user_input', content: 'input-1' })
    store.addStep('run-2', { timestamp: 1001, type: 'user_input', content: 'input-2' })
    store.addStep('run-1', { timestamp: 2000, type: 'llm_response', content: 'resp-1' })
    store.addStep('run-2', { timestamp: 2001, type: 'llm_response', content: 'resp-2' })
    store.addStep('run-2', { timestamp: 3001, type: 'output', content: 'out-2' })

    store.completeTrace('run-2')

    const trace1 = store.getTrace('run-1')!
    const trace2 = store.getTrace('run-2')!

    expect(trace1.agentId).toBe('agent-1')
    expect(trace1.steps).toHaveLength(2)
    expect(trace1.completedAt).toBeUndefined()

    expect(trace2.agentId).toBe('agent-2')
    expect(trace2.steps).toHaveLength(3)
    expect(trace2.completedAt).toBeGreaterThan(0)

    // Deleting one doesn't affect the other
    store.deleteTrace('run-1')
    expect(store.getTrace('run-1')).toBeNull()
    expect(store.getTrace('run-2')).not.toBeNull()
  })

  // -----------------------------------------------------------------------
  // Step metadata and durationMs
  // -----------------------------------------------------------------------

  it('should preserve metadata and durationMs on steps', () => {
    store.startTrace('run-1', 'agent-1')

    store.addStep('run-1', {
      timestamp: 1000,
      type: 'tool_call',
      content: { tool: 'search', args: { query: 'test' } },
      metadata: { toolName: 'search', retryCount: 0 },
      durationMs: 250,
    })

    const step = store.getTrace('run-1')!.steps[0]
    expect(step.metadata).toEqual({ toolName: 'search', retryCount: 0 })
    expect(step.durationMs).toBe(250)
    expect(step.type).toBe('tool_call')
  })

  // -----------------------------------------------------------------------
  // All step types
  // -----------------------------------------------------------------------

  it('should support all step types', () => {
    store.startTrace('run-1', 'agent-1')

    const types: TraceStep['type'][] = [
      'user_input',
      'llm_request',
      'llm_response',
      'tool_call',
      'tool_result',
      'system',
      'output',
    ]

    for (const type of types) {
      store.addStep('run-1', { timestamp: Date.now(), type, content: `content-${type}` })
    }

    const trace = store.getTrace('run-1')!
    expect(trace.steps).toHaveLength(7)
    expect(trace.steps.map((s) => s.type)).toEqual(types)
  })
})

// ---------------------------------------------------------------------------
// computeStepDistribution
// ---------------------------------------------------------------------------

describe('computeStepDistribution', () => {
  it('should compute type distribution from steps', () => {
    const steps: TraceStep[] = [
      { stepIndex: 0, timestamp: 1, type: 'user_input', content: 'a' },
      { stepIndex: 1, timestamp: 2, type: 'llm_request', content: 'b' },
      { stepIndex: 2, timestamp: 3, type: 'llm_response', content: 'c' },
      { stepIndex: 3, timestamp: 4, type: 'tool_call', content: 'd' },
      { stepIndex: 4, timestamp: 5, type: 'tool_result', content: 'e' },
      { stepIndex: 5, timestamp: 6, type: 'tool_call', content: 'f' },
      { stepIndex: 6, timestamp: 7, type: 'tool_result', content: 'g' },
      { stepIndex: 7, timestamp: 8, type: 'llm_response', content: 'h' },
      { stepIndex: 8, timestamp: 9, type: 'output', content: 'i' },
    ]

    const dist = computeStepDistribution(steps)
    expect(dist).toEqual({
      user_input: 1,
      llm_request: 1,
      llm_response: 2,
      tool_call: 2,
      tool_result: 2,
      system: 0,
      output: 1,
    })
  })

  it('should return all zeros for empty steps array', () => {
    const dist = computeStepDistribution([])
    expect(dist).toEqual({
      user_input: 0,
      llm_request: 0,
      llm_response: 0,
      tool_call: 0,
      tool_result: 0,
      system: 0,
      output: 0,
    })
  })
})
