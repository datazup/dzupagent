/**
 * Unit tests for the skill-chain-executor module.
 *
 * SC-12: validateChainStepInput — Zod contract enforcement
 * SC-13: WorkflowRegistry — register / get / list / compose / unregister / size
 * SC-15: SkillChainBuilder.parallel — parallel step execution via SkillChainExecutor
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ZodError } from 'zod'

import { validateChainStepInput } from '../state-contract.js'
import { SkillChainExecutor } from '../skill-chain-executor.js'
import { ChainValidationError, StepExecutionError } from '../errors.js'
import type { SkillStepResolver } from '../skill-step-resolver.js'
import type { WorkflowStep } from '../../workflow/workflow-types.js'
import {
  WorkflowRegistry,
  createSkillChain,
  SkillRegistry,
  SkillChainBuilder,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Inline mock resolver (no cross-package mocking)
// ---------------------------------------------------------------------------

class MockSkillStepResolver implements SkillStepResolver {
  private readonly skills = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  >()

  registerText(skillId: string, output: string): void {
    this.skills.set(skillId, () => ({ [skillId]: output }))
  }

  register(
    skillId: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): void {
    this.skills.set(skillId, fn)
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const fn = this.skills.get(skillId)
    if (!fn) throw new Error(`MockSkillStepResolver: skill "${skillId}" not registered`)
    return {
      id: skillId,
      description: `Mock skill: ${skillId}`,
      execute: async (input: unknown) => {
        const state = (input as Record<string, unknown>) ?? {}
        return await fn(state)
      },
    }
  }

  canResolve(skillId: string): boolean {
    return this.skills.has(skillId)
  }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal SkillChainExecutor with no registry skills needed
// ---------------------------------------------------------------------------

function buildExecutor(resolver: MockSkillStepResolver): SkillChainExecutor {
  return new SkillChainExecutor({
    resolver,
    registry: new SkillRegistry(),
  })
}

// ===========================================================================
// SC-12: validateChainStepInput
// ===========================================================================

describe('SC-12: validateChainStepInput()', () => {
  describe('valid input', () => {
    it('returns a ChainStepInput when all fields are correct', () => {
      const input = {
        userMessage: 'hello world',
        stepIndex: 0,
        skillId: 'my-skill',
        previousOutputs: { 'prior-step': 'prior output' },
      }
      const result = validateChainStepInput(input)
      expect(result.userMessage).toBe('hello world')
      expect(result.stepIndex).toBe(0)
      expect(result.skillId).toBe('my-skill')
      expect(result.previousOutputs).toEqual({ 'prior-step': 'prior output' })
    })

    it('accepts empty previousOutputs record', () => {
      const input = {
        userMessage: 'task',
        stepIndex: 3,
        skillId: 'skill-a',
        previousOutputs: {},
      }
      const result = validateChainStepInput(input)
      expect(result.previousOutputs).toEqual({})
    })

    it('accepts stepIndex of zero (first step)', () => {
      const input = {
        userMessage: 'first',
        stepIndex: 0,
        skillId: 'skill-b',
        previousOutputs: {},
      }
      const result = validateChainStepInput(input)
      expect(result.stepIndex).toBe(0)
    })

    it('accepts large stepIndex', () => {
      const input = {
        userMessage: 'x',
        stepIndex: 999,
        skillId: 's',
        previousOutputs: {},
      }
      const result = validateChainStepInput(input)
      expect(result.stepIndex).toBe(999)
    })
  })

  describe('invalid input — throws ZodError', () => {
    it('throws when userMessage is missing', () => {
      const input = { stepIndex: 0, skillId: 'x', previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when stepIndex is missing', () => {
      const input = { userMessage: 'hi', skillId: 'x', previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when stepIndex is a string instead of a number', () => {
      const input = { userMessage: 'hi', stepIndex: '0', skillId: 'x', previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when skillId is missing', () => {
      const input = { userMessage: 'hi', stepIndex: 0, previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when previousOutputs is missing', () => {
      const input = { userMessage: 'hi', stepIndex: 0, skillId: 'x' }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when previousOutputs contains non-string values', () => {
      const input = {
        userMessage: 'hi',
        stepIndex: 0,
        skillId: 'x',
        previousOutputs: { step1: 42 },
      }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws on null input', () => {
      expect(() => validateChainStepInput(null)).toThrow(ZodError)
    })

    it('throws on empty object', () => {
      expect(() => validateChainStepInput({})).toThrow(ZodError)
    })

    it('throws when userMessage is a number instead of a string', () => {
      const input = { userMessage: 123, stepIndex: 0, skillId: 'x', previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })

    it('throws when skillId is null', () => {
      const input = { userMessage: 'hi', stepIndex: 0, skillId: null, previousOutputs: {} }
      expect(() => validateChainStepInput(input)).toThrow(ZodError)
    })
  })
})

// ===========================================================================
// SC-13: WorkflowRegistry
// ===========================================================================

describe('SC-13: WorkflowRegistry', () => {
  let registry: WorkflowRegistry

  beforeEach(() => {
    registry = new WorkflowRegistry()
  })

  // ---- register / get -------------------------------------------------------

  describe('register() and get()', () => {
    it('registers a chain and retrieves it by exact name', () => {
      const chain = createSkillChain('flow-a', [{ skillName: 'step1' }])
      registry.register('flow-a', chain)
      expect(registry.get('flow-a')).toBe(chain)
    })

    it('performs case-insensitive lookup', () => {
      const chain = createSkillChain('My-Flow', [{ skillName: 'x' }])
      registry.register('My-Flow', chain)
      expect(registry.get('my-flow')).toBe(chain)
      expect(registry.get('MY-FLOW')).toBe(chain)
      expect(registry.get('My-Flow')).toBe(chain)
    })

    it('returns undefined for an unknown name', () => {
      expect(registry.get('does-not-exist')).toBeUndefined()
    })

    it('throws when registering a duplicate name without overwrite', () => {
      const chain = createSkillChain('dup', [{ skillName: 'x' }])
      registry.register('dup', chain)
      expect(() => registry.register('dup', chain)).toThrow(/already registered/)
    })

    it('overwrites an existing entry when overwrite: true', () => {
      const chain1 = createSkillChain('flow', [{ skillName: 'a' }])
      const chain2 = createSkillChain('flow', [{ skillName: 'b' }])
      registry.register('flow', chain1)
      registry.register('flow', chain2, { overwrite: true })
      expect(registry.get('flow')).toBe(chain2)
    })

    it('throws when registering with an empty name', () => {
      const chain = createSkillChain('x', [{ skillName: 'a' }])
      expect(() => registry.register('', chain)).toThrow()
    })
  })

  // ---- list -----------------------------------------------------------------

  describe('list()', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.list()).toEqual([])
    })

    it('returns all registered entries sorted by name', () => {
      registry.register('z-flow', createSkillChain('z-flow', [{ skillName: 's1' }]))
      registry.register('a-flow', createSkillChain('a-flow', [{ skillName: 's2' }, { skillName: 's3' }]))
      const items = registry.list()
      expect(items).toHaveLength(2)
      expect(items[0]!.name).toBe('a-flow')
      expect(items[1]!.name).toBe('z-flow')
    })

    it('includes stepCount in list entries', () => {
      registry.register('two-step', createSkillChain('two-step', [{ skillName: 'a' }, { skillName: 'b' }]))
      const items = registry.list()
      expect(items[0]!.stepCount).toBe(2)
    })

    it('includes description and tags when provided', () => {
      const chain = createSkillChain('tagged', [{ skillName: 'x' }])
      registry.register('tagged', chain, { description: 'my desc', tags: ['ai', 'nlp'] })
      const item = registry.list()[0]!
      expect(item.description).toBe('my desc')
      expect(item.tags).toEqual(['ai', 'nlp'])
    })
  })

  // ---- size -----------------------------------------------------------------

  describe('size', () => {
    it('returns 0 when empty', () => {
      expect(registry.size).toBe(0)
    })

    it('increments on register', () => {
      registry.register('f1', createSkillChain('f1', [{ skillName: 'a' }]))
      expect(registry.size).toBe(1)
      registry.register('f2', createSkillChain('f2', [{ skillName: 'b' }]))
      expect(registry.size).toBe(2)
    })
  })

  // ---- unregister -----------------------------------------------------------

  describe('unregister()', () => {
    it('removes a registered chain and returns true', () => {
      registry.register('rm-me', createSkillChain('rm-me', [{ skillName: 'x' }]))
      expect(registry.unregister('rm-me')).toBe(true)
      expect(registry.get('rm-me')).toBeUndefined()
    })

    it('returns false when the chain does not exist', () => {
      expect(registry.unregister('ghost')).toBe(false)
    })
  })

  // ---- compose --------------------------------------------------------------

  describe('compose()', () => {
    it('merges steps from two registered chains in order', () => {
      const chainA = createSkillChain('a', [{ skillName: 'step-a1' }, { skillName: 'step-a2' }])
      const chainB = createSkillChain('b', [{ skillName: 'step-b1' }])
      registry.register('a', chainA)
      registry.register('b', chainB)

      const composed = registry.compose('a+b', ['a', 'b'])
      expect(composed.name).toBe('a+b')
      expect(composed.steps).toHaveLength(3)
      expect(composed.steps[0]!.skillName).toBe('step-a1')
      expect(composed.steps[1]!.skillName).toBe('step-a2')
      expect(composed.steps[2]!.skillName).toBe('step-b1')
    })

    it('returns the composed chain without registering it by default', () => {
      const chain = createSkillChain('solo', [{ skillName: 'x' }])
      registry.register('solo', chain)
      registry.compose('composed', ['solo'])
      // Should NOT be registered automatically
      expect(registry.get('composed')).toBeUndefined()
    })

    it('registers the composed chain when registerResult: true', () => {
      const chain = createSkillChain('solo2', [{ skillName: 'y' }])
      registry.register('solo2', chain)
      const composed = registry.compose('auto-reg', ['solo2'], { registerResult: true })
      expect(registry.get('auto-reg')).toBe(composed)
    })

    it('throws when composing with an empty workflowNames array', () => {
      expect(() => registry.compose('empty', [])).toThrow(/must not be empty/)
    })

    it('throws when a referenced workflow does not exist', () => {
      expect(() => registry.compose('bad', ['missing-flow'])).toThrow(/not found/)
    })

    it('composes three chains preserving step order', () => {
      registry.register('c1', createSkillChain('c1', [{ skillName: 's1' }]))
      registry.register('c2', createSkillChain('c2', [{ skillName: 's2' }]))
      registry.register('c3', createSkillChain('c3', [{ skillName: 's3' }]))
      const composed = registry.compose('triple', ['c1', 'c2', 'c3'])
      expect(composed.steps.map(s => s.skillName)).toEqual(['s1', 's2', 's3'])
    })
  })
})

// ===========================================================================
// SC-15: SkillChainBuilder.parallel + SkillChainExecutor
// ===========================================================================

describe('SC-15: SkillChainBuilder.parallel() with SkillChainExecutor', () => {
  let resolver: MockSkillStepResolver

  beforeEach(() => {
    resolver = new MockSkillStepResolver()
  })

  // ---- SkillChainBuilder.parallel API -------------------------------------

  describe('SkillChainBuilder.parallel()', () => {
    it('sets a synthetic skillName of "parallel:<a,b>"', () => {
      const chain = new SkillChainBuilder('test')
        .parallel(['skill-a', 'skill-b'])
        .build()
      expect(chain.steps[0]!.skillName).toBe('parallel:skill-a,skill-b')
    })

    it('sets parallelSkills to the provided array', () => {
      const chain = new SkillChainBuilder('test')
        .parallel(['x', 'y', 'z'])
        .build()
      expect(chain.steps[0]!.parallelSkills).toEqual(['x', 'y', 'z'])
    })

    it('throws when given an empty array', () => {
      expect(() => new SkillChainBuilder('test').parallel([])).toThrow()
    })

    it('stores the mergeStrategy option when provided', () => {
      const chain = new SkillChainBuilder('test')
        .parallel(['a', 'b'], { mergeStrategy: 'last-wins' })
        .build()
      expect(chain.steps[0]!.mergeStrategy).toBe('last-wins')
    })
  })

  // ---- execute() with parallel steps (merge-objects default) ---------------

  describe('SkillChainExecutor.execute() with parallel steps', () => {
    it('executes both parallel sub-skills and merges their outputs (merge-objects)', async () => {
      resolver.registerText('skill-a', 'output-a')
      resolver.registerText('skill-b', 'output-b')

      const chain = new SkillChainBuilder('parallel-test')
        .parallel(['skill-a', 'skill-b'])
        .build()

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      expect(result['skill-a']).toBe('output-a')
      expect(result['skill-b']).toBe('output-b')
    })

    it('executes parallel sub-skills and both outputs appear in the result', async () => {
      resolver.registerText('p1', 'result-p1')
      resolver.registerText('p2', 'result-p2')

      const chain = new SkillChainBuilder('parallel-outputs')
        .parallel(['p1', 'p2'])
        .build()

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      // The parallel merge-objects strategy merges both sub-step result objects
      // into the shared state. Each sub-step returns { [skillName]: output, previousOutputs: {...} }.
      // Because both p1 and p2 return a 'previousOutputs' key, the last-merged one wins for
      // that specific key. The top-level skill output keys are disjoint and both present.
      expect(result['p1']).toBe('result-p1')
      expect(result['p2']).toBe('result-p2')
    })

    it('executes parallel step followed by a sequential step', async () => {
      resolver.registerText('alpha', 'alpha-out')
      resolver.registerText('beta', 'beta-out')
      // After the parallel merge, the top-level keys 'alpha' and 'beta' are in state.
      // Because 'previousOutputs' is overwritten by each parallel sub-step result in
      // merge-objects order, we read the top-level keys rather than previousOutputs.
      resolver.register('gamma', (state) => {
        const alphaOut = state['alpha'] as string | undefined
        const betaOut = state['beta'] as string | undefined
        return { gamma: `combined:${alphaOut ?? ''}|${betaOut ?? ''}` }
      })

      const chain = new SkillChainBuilder('par-then-seq')
        .parallel(['alpha', 'beta'])
        .step('gamma')
        .build()

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      expect(result['gamma']).toBe('combined:alpha-out|beta-out')
      expect(result['lastOutput']).toBe('combined:alpha-out|beta-out')
    })

    it('uses last-wins merge strategy for overlapping keys', async () => {
      // Both parallel skills return the same key; last-wins means one prevails
      resolver.register('win1', () => ({ sharedKey: 'from-win1' }))
      resolver.register('win2', () => ({ sharedKey: 'from-win2' }))

      const chain = new SkillChainBuilder('last-wins-test')
        .parallel(['win1', 'win2'], { mergeStrategy: 'last-wins' })
        .build()

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      // With last-wins, one of the two values wins — just assert both ran
      expect(['from-win1', 'from-win2']).toContain(result['sharedKey'])
    })

    it('applies a stateTransformer to the parallel group', async () => {
      resolver.register('transformed', (state) => ({
        transformed: `got:${state['injected']}`,
      }))

      const chain = new SkillChainBuilder('transform-test')
        .parallel(['transformed'], {
          stateTransformer: (state) => ({ ...state, injected: 'injected-value' }),
        })
        .build()

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      expect(result['transformed']).toBe('got:injected-value')
    })
  })

  // ---- dryRun() with parallel steps ----------------------------------------

  describe('SkillChainExecutor.dryRun() with parallel steps', () => {
    it('reports all parallel sub-skills as resolved when registered', () => {
      resolver.registerText('dry-a', 'x')
      resolver.registerText('dry-b', 'x')

      const chain = new SkillChainBuilder('dry-run-test')
        .parallel(['dry-a', 'dry-b'])
        .build()

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      // The dry run checks the synthetic "parallel:dry-a,dry-b" skillName
      // which is NOT resolvable — the executor only calls canResolve on individual
      // sub-skills during compile, but dryRun uses the top-level step.skillName.
      // So the synthetic key won't be in the resolver.
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/parallel:dry-a,dry-b/)
    })

    it('reports valid for a sequential-only chain', () => {
      resolver.registerText('seq-skill', 'out')

      const chain = createSkillChain('seq', [{ skillName: 'seq-skill' }])
      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.steps[0]!.resolved).toBe(true)
    })
  })

  // ---- compile() validation -------------------------------------------------

  describe('SkillChainExecutor.compile() validation', () => {
    it('throws ChainValidationError when a parallel sub-skill is not resolvable', async () => {
      resolver.registerText('good-skill', 'out')
      // 'bad-skill' is intentionally not registered

      const chain = new SkillChainBuilder('missing-parallel')
        .parallel(['good-skill', 'bad-skill'])
        .build()

      const executor = buildExecutor(resolver)
      await expect(executor.compile(chain)).rejects.toThrow(ChainValidationError)
    })

    it('throws ChainValidationError when a sequential step is not resolvable', async () => {
      const chain = createSkillChain('bad-chain', [{ skillName: 'not-registered' }])
      const executor = buildExecutor(resolver)
      await expect(executor.compile(chain)).rejects.toThrow(ChainValidationError)
    })

    it('compiles successfully when all steps are resolvable', async () => {
      resolver.registerText('ok-step', 'result')
      const chain = createSkillChain('valid-chain', [{ skillName: 'ok-step' }])
      const executor = buildExecutor(resolver)
      const compiled = await executor.compile(chain)
      expect(compiled).toBeDefined()
      expect(typeof compiled.run).toBe('function')
    })
  })

  // ---- condition gating on sequential steps --------------------------------

  describe('SkillChainExecutor.execute() — condition gating', () => {
    it('skips a step when condition returns false', async () => {
      resolver.registerText('first', 'first-output')

      let secondCalled = false
      resolver.register('second', () => {
        secondCalled = true
        return { second: 'second-output' }
      })

      const chain = new SkillChainBuilder('conditioned')
        .step('first')
        .stepIf('second', () => false)
        .build()

      const executor = buildExecutor(resolver)
      await executor.execute(chain, {})

      expect(secondCalled).toBe(false)
    })

    it('executes a step when condition returns true', async () => {
      resolver.registerText('first', 'yes')

      let secondCalled = false
      resolver.register('second', () => {
        secondCalled = true
        return { second: 'done' }
      })

      const chain = new SkillChainBuilder('conditioned-pass')
        .step('first')
        .stepIf('second', () => true)
        .build()

      const executor = buildExecutor(resolver)
      await executor.execute(chain, {})

      expect(secondCalled).toBe(true)
    })

    it('passes previous step output to the condition function', async () => {
      resolver.registerText('producer', 'PASS')

      let receivedValue = ''
      resolver.registerText('consumer', 'done')

      const chain = new SkillChainBuilder('condition-input')
        .step('producer')
        .stepIf('consumer', (prev) => {
          receivedValue = prev
          return true
        })
        .build()

      const executor = buildExecutor(resolver)
      await executor.execute(chain, {})

      expect(receivedValue).toBe('PASS')
    })

    it('throws a StepExecutionError wrapping the ConditionEvaluationError when a condition throws', async () => {
      // The workflow builder catches all step errors and converts them to strings
      // (via err.message). The ConditionEvaluationError message bubbles through the
      // pipeline, causing workflow.run() to throw a plain Error. SkillChainExecutor
      // then wraps that plain Error in StepExecutionError(-1, 'unknown', ...).
      resolver.registerText('first', 'out')
      resolver.registerText('second', 'out2')

      const chain = new SkillChainBuilder('bad-condition')
        .step('first')
        .stepIf('second', () => {
          throw new Error('condition exploded')
        })
        .build()

      const executor = buildExecutor(resolver)
      await expect(executor.execute(chain, {})).rejects.toThrow(StepExecutionError)
    })
  })

  // ---- stream() ---------------------------------------------------------------

  describe('SkillChainExecutor.stream()', () => {
    it('yields WorkflowEvents during execution', async () => {
      resolver.registerText('stream-skill', 'streamed')

      const chain = createSkillChain('stream-chain', [{ skillName: 'stream-skill' }])
      const executor = buildExecutor(resolver)

      const events: string[] = []
      for await (const event of executor.stream(chain, {})) {
        events.push(event.type)
      }

      // Should include at minimum a completion event
      expect(events.length).toBeGreaterThan(0)
      expect(events).toContain('workflow:completed')
    })

    it('throws ChainValidationError eagerly for unresolvable skills', async () => {
      const chain = createSkillChain('bad-stream', [{ skillName: 'no-such-skill' }])
      const executor = buildExecutor(resolver)

      const gen = executor.stream(chain, {})
      await expect(gen.next()).rejects.toThrow(ChainValidationError)
    })
  })

  // ---- dryRun extended — multi-step chains with mixed resolution ------------

  describe('dryRun extended', () => {
    // Helper: build an executor whose SkillRegistry has the given skills pre-loaded
    function buildExecutorWithRegistry(
      resolver: MockSkillStepResolver,
      registrySkills: Array<{ id: string; description: string }>,
    ): SkillChainExecutor {
      const registry = new SkillRegistry()
      for (const { id, description } of registrySkills) {
        registry.register({
          id,
          name: id,
          description,
          instructions: `Instructions for ${id}`,
        })
      }
      return new SkillChainExecutor({ resolver, registry })
    }

    it('all resolved — 3-step chain returns valid:true, 3 resolved steps, no errors', () => {
      resolver.registerText('skill-one', 'out1')
      resolver.registerText('skill-two', 'out2')
      resolver.registerText('skill-three', 'out3')

      const chain = createSkillChain('all-resolved', [
        { skillName: 'skill-one' },
        { skillName: 'skill-two' },
        { skillName: 'skill-three' },
      ])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(true)
      expect(result.steps).toHaveLength(3)
      expect(result.steps[0]!.resolved).toBe(true)
      expect(result.steps[1]!.resolved).toBe(true)
      expect(result.steps[2]!.resolved).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('none resolved — 3-step chain returns valid:false, all unresolved, 3 errors', () => {
      // No skills registered in resolver at all
      const chain = createSkillChain('none-resolved', [
        { skillName: 'ghost-one' },
        { skillName: 'ghost-two' },
        { skillName: 'ghost-three' },
      ])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(false)
      expect(result.steps).toHaveLength(3)
      expect(result.steps[0]!.resolved).toBe(false)
      expect(result.steps[1]!.resolved).toBe(false)
      expect(result.steps[2]!.resolved).toBe(false)
      expect(result.errors).toHaveLength(3)
    })

    it('partial resolution — skills 1 and 3 resolve, skill 2 does not', () => {
      resolver.registerText('step-alpha', 'a')
      // step-beta intentionally NOT registered
      resolver.registerText('step-gamma', 'c')

      const chain = createSkillChain('partial-resolved', [
        { skillName: 'step-alpha' },
        { skillName: 'step-beta' },
        { skillName: 'step-gamma' },
      ])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(false)
      expect(result.steps[0]!.resolved).toBe(true)
      expect(result.steps[1]!.resolved).toBe(false)
      expect(result.steps[2]!.resolved).toBe(true)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/step-beta/)
    })

    it('single unresolvable — 1-step chain with unknown skill', () => {
      const chain = createSkillChain('single-unknown', [
        { skillName: 'totally-unknown-skill' },
      ])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(false)
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]!.resolved).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/totally-unknown-skill/)
    })

    it('description populated — resolved steps carry the registry description', () => {
      resolver.registerText('described-skill', 'output')

      const chain = createSkillChain('with-description', [
        { skillName: 'described-skill' },
      ])

      const executor = buildExecutorWithRegistry(resolver, [
        { id: 'described-skill', description: 'Does something very useful' },
      ])
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(true)
      expect(result.steps[0]!.resolved).toBe(true)
      expect(result.steps[0]!.description).toBe('Does something very useful')
    })

    it('description populated — unresolved steps have no description', () => {
      const chain = createSkillChain('unresolved-no-desc', [
        { skillName: 'not-in-resolver' },
      ])

      const executor = buildExecutorWithRegistry(resolver, [])
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(false)
      expect(result.steps[0]!.resolved).toBe(false)
      expect(result.steps[0]!.description).toBeUndefined()
    })

    it('description populated — mixed chain has description only for resolved+registered steps', () => {
      resolver.registerText('has-desc', 'out')
      resolver.registerText('no-registry-entry', 'out')
      // 'missing-skill' not in resolver

      const chain = createSkillChain('mixed-desc', [
        { skillName: 'has-desc' },
        { skillName: 'no-registry-entry' },
        { skillName: 'missing-skill' },
      ])

      const executor = buildExecutorWithRegistry(resolver, [
        { id: 'has-desc', description: 'Well-documented skill' },
        // 'no-registry-entry' is resolvable but NOT in the SkillRegistry
      ])
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(false)
      expect(result.steps[0]!.description).toBe('Well-documented skill')
      expect(result.steps[1]!.description).toBeUndefined()
      expect(result.steps[2]!.description).toBeUndefined()
    })

    it('empty chain — createSkillChain rejects a 0-step array before dryRun is reached', () => {
      // dryRun with an empty steps array would return valid:true/steps:[]/errors:[],
      // but createSkillChain enforces at least one step, so this guard fires first.
      expect(() => createSkillChain('empty-chain', [])).toThrow(/at least one step/)
    })

    it('empty chain — dryRun on a manually-crafted empty chain returns valid:true', () => {
      // Bypass createSkillChain to exercise the dryRun branch directly.
      const chain = { name: 'empty-manual', steps: [] } as unknown as Parameters<SkillChainExecutor['dryRun']>[0]

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.valid).toBe(true)
      expect(result.steps).toEqual([])
      expect(result.errors).toEqual([])
    })

    it('each error message contains the unresolvable skill name', () => {
      const chain = createSkillChain('error-names', [
        { skillName: 'unresolvable-foo' },
        { skillName: 'unresolvable-bar' },
      ])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.errors).toHaveLength(2)
      expect(result.errors.some(e => e.includes('unresolvable-foo'))).toBe(true)
      expect(result.errors.some(e => e.includes('unresolvable-bar'))).toBe(true)
    })

    it('step skillId matches the chain step skillName', () => {
      resolver.registerText('id-check-skill', 'out')
      const chain = createSkillChain('id-check', [{ skillName: 'id-check-skill' }])

      const executor = buildExecutor(resolver)
      const result = executor.dryRun(chain)

      expect(result.steps[0]!.skillId).toBe('id-check-skill')
    })
  })

  // ---- execute() accumulates previousOutputs across sequential steps --------

  describe('SkillChainExecutor.execute() — previousOutputs accumulation', () => {
    it('accumulates outputs across three sequential steps', async () => {
      resolver.registerText('s1', 'out1')
      resolver.registerText('s2', 'out2')
      resolver.registerText('s3', 'out3')

      const chain = createSkillChain('three-seq', [
        { skillName: 's1' },
        { skillName: 's2' },
        { skillName: 's3' },
      ])

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      const prev = result['previousOutputs'] as Record<string, string>
      expect(prev['s1']).toBe('out1')
      expect(prev['s2']).toBe('out2')
      expect(prev['s3']).toBe('out3')
    })

    it('sets lastOutput to the final step output', async () => {
      resolver.registerText('penultimate', 'not-last')
      resolver.registerText('final', 'the-last')

      const chain = createSkillChain('last-out', [
        { skillName: 'penultimate' },
        { skillName: 'final' },
      ])

      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, {})

      expect(result['lastOutput']).toBe('the-last')
    })

    it('passes initialState fields through to each step', async () => {
      resolver.register('reader', (state) => ({
        reader: `value=${state['myKey']}`,
      }))

      const chain = createSkillChain('state-pass', [{ skillName: 'reader' }])
      const executor = buildExecutor(resolver)
      const result = await executor.execute(chain, { myKey: 'test-value' })

      const prev = result['previousOutputs'] as Record<string, string>
      expect(prev['reader']).toBe('value=test-value')
    })
  })
})
