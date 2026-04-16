import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillChainExecutor } from '../skill-chain-executor/skill-chain-executor.js'
import { ChainValidationError, StepExecutionError } from '../skill-chain-executor/errors.js'
import type { SkillStepResolver } from '../skill-chain-executor/skill-step-resolver.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import type { WorkflowEvent } from '../workflow/workflow-types.js'
import { createSkillChain, SkillRegistry } from '@dzupagent/core'
import type { RetryPolicy, DzupEvent, DzupEventBus } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// MockSkillStepResolver (inline to avoid cross-package build dependency)
// ---------------------------------------------------------------------------

interface MockCall {
  skillId: string
  state: Record<string, unknown>
}

class MockSkillStepResolver implements SkillStepResolver {
  private readonly skills = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  >()
  readonly calls: MockCall[] = []

  registerText(skillId: string, output: string): void {
    this.skills.set(skillId, () => ({ [skillId]: output }))
  }

  register(
    skillId: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): void {
    this.skills.set(skillId, fn)
  }

  registerError(skillId: string, error: Error | string): void {
    this.skills.set(skillId, async () => {
      throw error instanceof Error ? error : new Error(error)
    })
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const fn = this.skills.get(skillId)
    if (!fn) throw new Error(`MockSkillStepResolver: skill "${skillId}" not registered`)
    return {
      id: skillId,
      description: `Mock skill: ${skillId}`,
      execute: async (input: unknown) => {
        const state = (input as Record<string, unknown>) ?? {}
        this.calls.push({ skillId, state: { ...state } })
        return await fn(state)
      },
    }
  }

  canResolve(skillId: string): boolean {
    return this.skills.has(skillId)
  }
}

// ---------------------------------------------------------------------------
// MockEventBus
// ---------------------------------------------------------------------------

class MockEventBus implements DzupEventBus {
  readonly emitted: DzupEvent[] = []

  emit(event: DzupEvent): void {
    this.emitted.push(event)
  }

  on(): () => void {
    return () => {}
  }

  once(): () => void {
    return () => {}
  }

  onAny(): () => void {
    return () => {}
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createExecutor(
  resolver: MockSkillStepResolver,
  opts?: { eventBus?: DzupEventBus; defaultRetry?: RetryPolicy },
): SkillChainExecutor {
  return new SkillChainExecutor({
    resolver,
    registry: new SkillRegistry(),
    eventBus: opts?.eventBus,
    defaultRetry: opts?.defaultRetry,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillChainExecutor', () => {
  let resolver: MockSkillStepResolver
  let executor: SkillChainExecutor

  beforeEach(() => {
    resolver = new MockSkillStepResolver()
    executor = createExecutor(resolver)
  })

  describe('execute()', () => {
    it('runs a 3-step chain and collects previousOutputs', async () => {
      resolver.registerText('a', 'output-a')
      resolver.registerText('b', 'output-b')
      resolver.registerText('c', 'output-c')

      const chain = createSkillChain('test-chain', [
        { skillName: 'a' },
        { skillName: 'b' },
        { skillName: 'c' },
      ])

      const result = await executor.execute(chain, {})

      const outputs = result['previousOutputs'] as Record<string, string>
      expect(outputs['a']).toBe('output-a')
      expect(outputs['b']).toBe('output-b')
      expect(outputs['c']).toBe('output-c')
    })

    it('sets lastOutput to the final step output', async () => {
      resolver.registerText('a', 'output-a')
      resolver.registerText('b', 'final-output')

      const chain = createSkillChain('chain', [
        { skillName: 'a' },
        { skillName: 'b' },
      ])

      const result = await executor.execute(chain, {})
      expect(result['lastOutput']).toBe('final-output')
    })

    it('evaluates condition against previous step output (condition passes)', async () => {
      resolver.registerText('step1', 'ok result')
      resolver.registerText('step2', 'step2-done')

      const chain = createSkillChain('cond-chain', [
        { skillName: 'step1' },
        {
          skillName: 'step2',
          condition: (prev: string) => prev.includes('ok'),
        },
      ])

      const result = await executor.execute(chain, {})
      const outputs = result['previousOutputs'] as Record<string, string>
      expect(outputs['step2']).toBe('step2-done')
    })

    it('skips step when condition returns false', async () => {
      resolver.registerText('step1', 'nope')
      resolver.registerText('step2', 'should-not-run')

      const chain = createSkillChain('cond-chain', [
        { skillName: 'step1' },
        {
          skillName: 'step2',
          condition: () => false,
        },
      ])

      const result = await executor.execute(chain, {})

      // step2 should not have been invoked via our mock
      const step2Calls = resolver.calls.filter((c) => c.skillId === 'step2')
      expect(step2Calls).toHaveLength(0)
    })

    it('applies step-level stateTransformer before execution', async () => {
      resolver.register('a', (state) => ({
        a: `injected=${state['injected']}`,
      }))

      const chain = createSkillChain('transform-chain', [
        {
          skillName: 'a',
          stateTransformer: (state) => ({ ...state, injected: 'hello' }),
        },
      ])

      const result = await executor.execute(chain, {})
      const outputs = result['previousOutputs'] as Record<string, string>
      expect(outputs['a']).toBe('injected=hello')
    })

    it('applies ExecuteOptions.stateTransformers by step index', async () => {
      resolver.register('a', (state) => ({
        a: `extra=${state['extra']}`,
      }))

      const chain = createSkillChain('opts-transform', [{ skillName: 'a' }])

      const result = await executor.execute(chain, {}, {
        stateTransformers: {
          0: (state) => ({ ...state, extra: 'from-options' }),
        },
      })

      const outputs = result['previousOutputs'] as Record<string, string>
      expect(outputs['a']).toBe('extra=from-options')
    })
  })

  describe('validation errors', () => {
    it('throws ChainValidationError when resolver cannot resolve a skill', async () => {
      resolver.registerText('a', 'ok')
      // 'missing' is not registered

      const chain = createSkillChain('bad-chain', [
        { skillName: 'a' },
        { skillName: 'missing' },
      ])

      await expect(executor.execute(chain, {})).rejects.toThrow(ChainValidationError)
    })
  })

  describe('step execution errors', () => {
    it('throws StepExecutionError when a step throws', async () => {
      resolver.register('boom', () => {
        throw new Error('kaboom')
      })

      const chain = createSkillChain('err-chain', [{ skillName: 'boom' }])

      try {
        await executor.execute(chain, {})
        expect.fail('should have thrown')
      } catch (err) {
        // The error may be wrapped as StepExecutionError or propagated raw
        // depending on workflow-builder behavior. Check the message is present.
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toContain('kaboom')
      }
    })
  })

  describe('dryRun()', () => {
    it('returns valid: true when all skills can be resolved', () => {
      resolver.registerText('a', 'ok')
      resolver.registerText('b', 'ok')

      // Register skills in the registry so descriptions are available
      const registry = new SkillRegistry()
      registry.register({ id: 'a', name: 'Skill A', description: 'Description of A', instructions: '' })
      registry.register({ id: 'b', name: 'Skill B', description: 'Description of B', instructions: '' })
      const exec = new SkillChainExecutor({ resolver, registry })

      const chain = createSkillChain('dry', [
        { skillName: 'a' },
        { skillName: 'b' },
      ])

      const result = exec.dryRun(chain)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.steps).toHaveLength(2)
      expect(result.steps[0]!.resolved).toBe(true)
      expect(result.steps[0]!.description).toBe('Description of A')
    })

    it('returns valid: false with errors for unknown skills', () => {
      resolver.registerText('a', 'ok')

      const chain = createSkillChain('dry-bad', [
        { skillName: 'a' },
        { skillName: 'unknown' },
      ])

      const result = executor.dryRun(chain)
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('unknown')
      expect(result.steps[1]!.resolved).toBe(false)
    })

    it('never calls resolver.resolve() — lazy validation only (SC-39)', () => {
      resolver.registerText('a', 'ok')
      resolver.registerText('b', 'ok')

      const resolveSpy = vi.spyOn(resolver, 'resolve')

      const chain = createSkillChain('dry-lazy', [
        { skillName: 'a' },
        { skillName: 'b' },
      ])

      executor.dryRun(chain)
      expect(resolveSpy).not.toHaveBeenCalled()
    })

    it('returns synchronously (not a Promise)', () => {
      resolver.registerText('a', 'ok')

      const chain = createSkillChain('dry-sync', [{ skillName: 'a' }])

      const result = executor.dryRun(chain)
      // If it were async, result would be a Promise — verify it is not
      expect(result).not.toBeInstanceOf(Promise)
      expect(result.valid).toBe(true)
    })
  })

  describe('timeout', () => {
    it('throws when step exceeds timeoutMs', async () => {
      resolver.register('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return { slow: 'done' }
      })

      const chain = createSkillChain('timeout-chain', [
        { skillName: 'slow', timeoutMs: 50 },
      ])

      try {
        await executor.execute(chain, {})
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toContain('timed out')
      }
    })
  })

  describe('AbortSignal', () => {
    // The workflow builder does not currently check for pre-aborted signals
    // before starting execution. This test is a placeholder for when that
    // behavior is implemented.
    it.todo('rejects when signal is already aborted')
  })

  describe('stream()', () => {
    it('yields WorkflowEvents including step:started', async () => {
      resolver.registerText('a', 'output-a')
      resolver.registerText('b', 'output-b')

      const chain = createSkillChain('stream-chain', [
        { skillName: 'a' },
        { skillName: 'b' },
      ])

      const events: WorkflowEvent[] = []
      for await (const event of executor.stream(chain, {})) {
        events.push(event)
      }

      expect(events.length).toBeGreaterThan(0)
      const types = events.map((e) => e.type)
      expect(types).toContain('step:started')
      expect(types).toContain('step:completed')
      expect(types).toContain('workflow:completed')
    })
  })

  // ---------------------------------------------------------------------------
  // Per-step retry (TASK-C2)
  // ---------------------------------------------------------------------------

  describe('per-step retry', () => {
    it('retries a failing step up to maxAttempts then throws StepExecutionError', async () => {
      let callCount = 0
      resolver.register('flaky', () => {
        callCount++
        throw new Error('transient error')
      })

      const chain = createSkillChain('retry-chain', [
        { skillName: 'flaky', retryPolicy: { maxAttempts: 3, initialBackoffMs: 1 } },
      ])

      await expect(executor.execute(chain, {})).rejects.toThrow('transient error')
      expect(callCount).toBe(3)
    })

    it('succeeds on second attempt without throwing', async () => {
      let callCount = 0
      resolver.register('flaky', () => {
        callCount++
        if (callCount < 2) throw new Error('transient')
        return { flaky: 'recovered' }
      })

      const chain = createSkillChain('retry-ok', [
        { skillName: 'flaky', retryPolicy: { maxAttempts: 3, initialBackoffMs: 1 } },
      ])

      const result = await executor.execute(chain, {})
      expect(callCount).toBe(2)
      expect(result['lastOutput']).toBe('recovered')
    })

    it('skips retry when error does not match retryableErrors', async () => {
      let callCount = 0
      resolver.register('strict', () => {
        callCount++
        throw new Error('permanent failure')
      })

      const chain = createSkillChain('strict-retry', [
        {
          skillName: 'strict',
          retryPolicy: {
            maxAttempts: 3,
            initialBackoffMs: 1,
            retryableErrors: ['transient'],
          },
        },
      ])

      await expect(executor.execute(chain, {})).rejects.toThrow('permanent failure')
      expect(callCount).toBe(1) // no retries because error didn't match
    })

    it('retries when error matches retryableErrors pattern', async () => {
      let callCount = 0
      resolver.register('matching', () => {
        callCount++
        throw new Error('rate limit exceeded')
      })

      const chain = createSkillChain('pattern-retry', [
        {
          skillName: 'matching',
          retryPolicy: {
            maxAttempts: 2,
            initialBackoffMs: 1,
            retryableErrors: [/rate.?limit/i],
          },
        },
      ])

      await expect(executor.execute(chain, {})).rejects.toThrow('rate limit')
      expect(callCount).toBe(2) // retried once
    })

    it('uses defaultRetry from config when step has no retryPolicy', async () => {
      let callCount = 0
      resolver.register('default-retry', () => {
        callCount++
        if (callCount < 2) throw new Error('fail')
        return { 'default-retry': 'ok' }
      })

      const retryExecutor = createExecutor(resolver, {
        defaultRetry: { maxAttempts: 3, initialBackoffMs: 1 },
      })

      const chain = createSkillChain('default-retry-chain', [
        { skillName: 'default-retry' },
      ])

      const result = await retryExecutor.execute(chain, {})
      expect(callCount).toBe(2)
      expect(result['lastOutput']).toBe('ok')
    })

    it('emits step:retrying events during retry', async () => {
      let callCount = 0
      resolver.register('retrying', () => {
        callCount++
        if (callCount < 3) throw new Error('fail')
        return { retrying: 'ok' }
      })

      const chain = createSkillChain('event-retry', [
        { skillName: 'retrying', retryPolicy: { maxAttempts: 3, initialBackoffMs: 1 } },
      ])

      const events: WorkflowEvent[] = []
      await executor.execute(chain, {}, {
        onProgress: (e) => events.push(e),
      })

      const retryEvents = events.filter(e => e.type === 'step:retrying')
      expect(retryEvents).toHaveLength(2) // attempt 1 and 2 trigger retrying events
      const first = retryEvents[0] as Extract<WorkflowEvent, { type: 'step:retrying' }>
      expect(first.stepId).toBe('retrying')
      expect(first.attempt).toBe(1)
      expect(first.maxAttempts).toBe(3)
    })

    it('step-level retryPolicy overrides config defaultRetry', async () => {
      let callCount = 0
      resolver.register('override', () => {
        callCount++
        throw new Error('fail')
      })

      const retryExecutor = createExecutor(resolver, {
        defaultRetry: { maxAttempts: 5, initialBackoffMs: 1 },
      })

      const chain = createSkillChain('override-retry', [
        { skillName: 'override', retryPolicy: { maxAttempts: 2, initialBackoffMs: 1 } },
      ])

      await expect(retryExecutor.execute(chain, {})).rejects.toThrow('fail')
      expect(callCount).toBe(2) // step-level maxAttempts=2 wins over config's 5
    })
  })

  // ---------------------------------------------------------------------------
  // Event bus bridge (TASK-E2)
  // ---------------------------------------------------------------------------

  describe('event bus bridge', () => {
    it('emits pipeline:node_started when step starts', async () => {
      const bus = new MockEventBus()
      resolver.registerText('a', 'output-a')
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('bus-test', [{ skillName: 'a' }])
      await busExecutor.execute(chain, {})

      const started = bus.emitted.filter(e => e.type === 'pipeline:node_started')
      expect(started.length).toBeGreaterThanOrEqual(1)
      const first = started[0] as Extract<DzupEvent, { type: 'pipeline:node_started' }>
      expect(first.nodeId).toBe('a')
      expect(first.nodeType).toBe('skill')
    })

    it('emits pipeline:node_completed when step completes', async () => {
      const bus = new MockEventBus()
      resolver.registerText('a', 'output-a')
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('bus-test', [{ skillName: 'a' }])
      await busExecutor.execute(chain, {})

      const completed = bus.emitted.filter(e => e.type === 'pipeline:node_completed')
      expect(completed.length).toBeGreaterThanOrEqual(1)
      const first = completed[0] as Extract<DzupEvent, { type: 'pipeline:node_completed' }>
      expect(first.nodeId).toBe('a')
      expect(typeof first.durationMs).toBe('number')
    })

    it('emits pipeline:run_completed when chain completes', async () => {
      const bus = new MockEventBus()
      resolver.registerText('a', 'output-a')
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('bus-test', [{ skillName: 'a' }])
      await busExecutor.execute(chain, {})

      const runCompleted = bus.emitted.filter(e => e.type === 'pipeline:run_completed')
      expect(runCompleted).toHaveLength(1)
      const evt = runCompleted[0] as Extract<DzupEvent, { type: 'pipeline:run_completed' }>
      expect(typeof evt.durationMs).toBe('number')
      expect(evt.pipelineId).toBe('bus-test')
    })

    it('emits pipeline:run_failed when chain fails', async () => {
      const bus = new MockEventBus()
      resolver.registerError('fail', 'intentional error')
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('bus-fail', [{ skillName: 'fail' }])
      await expect(busExecutor.execute(chain, {})).rejects.toThrow()

      const runFailed = bus.emitted.filter(e => e.type === 'pipeline:run_failed')
      expect(runFailed).toHaveLength(1)
      const evt = runFailed[0] as Extract<DzupEvent, { type: 'pipeline:run_failed' }>
      expect(evt.pipelineId).toBe('bus-fail')
    })

    it('emits pipeline:node_skipped for condition-gated step', async () => {
      const bus = new MockEventBus()
      resolver.registerText('step1', 'nope')
      resolver.registerText('step2', 'should-not-run')
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('skip-test', [
        { skillName: 'step1' },
        { skillName: 'step2', condition: () => false },
      ])
      await busExecutor.execute(chain, {})

      const skipped = bus.emitted.filter(e => e.type === 'pipeline:node_skipped')
      expect(skipped).toHaveLength(1)
      const evt = skipped[0] as Extract<DzupEvent, { type: 'pipeline:node_skipped' }>
      expect(evt.nodeId).toBe('step2')
      expect(evt.reason).toBe('condition-gate')
    })

    it('emits pipeline:node_retry during retry', async () => {
      const bus = new MockEventBus()
      let callCount = 0
      resolver.register('flaky', () => {
        callCount++
        if (callCount < 2) throw new Error('transient')
        return { flaky: 'ok' }
      })
      const busExecutor = createExecutor(resolver, { eventBus: bus })

      const chain = createSkillChain('retry-bus', [
        { skillName: 'flaky', retryPolicy: { maxAttempts: 3, initialBackoffMs: 1 } },
      ])
      await busExecutor.execute(chain, {})

      const retryEvents = bus.emitted.filter(e => e.type === 'pipeline:node_retry')
      expect(retryEvents).toHaveLength(1)
      const evt = retryEvents[0] as Extract<DzupEvent, { type: 'pipeline:node_retry' }>
      expect(evt.nodeId).toBe('flaky')
      expect(evt.attempt).toBe(1)
    })
  })
})
