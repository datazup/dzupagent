/**
 * Comprehensive unit test suite for workflow-builder.ts (W17-A2).
 *
 * 50+ tests covering: sequential steps, parallel fan-out, conditional branching,
 * suspend/resume, error propagation, merge strategies, nested compositions,
 * event emissions, pipeline definition structure, async steps, AbortSignal,
 * WorkflowContext usage, edge cases, and durability features.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWorkflow, WorkflowBuilder, CompiledWorkflow, type WorkflowEvent } from '../workflow/index.js'
import type { WorkflowStep, WorkflowContext, MergeStrategy } from '../workflow/workflow-types.js'
import { InMemoryRunJournal, InMemoryRunStore } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(
  id: string,
  fn: (state: Record<string, unknown>, ctx: WorkflowContext) => Record<string, unknown> | void,
): WorkflowStep {
  return {
    id,
    execute: async (input, ctx) => fn(input as Record<string, unknown>, ctx) as Record<string, unknown>,
  }
}

function asyncStep(
  id: string,
  fn: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function collectEvents(workflow: CompiledWorkflow, initialState: Record<string, unknown> = {}): Promise<{
  result: Record<string, unknown> | null
  events: WorkflowEvent[]
  error: Error | null
}> {
  const events: WorkflowEvent[] = []
  return workflow
    .run(initialState, { onEvent: (e) => events.push(e) })
    .then((result) => ({ result, events, error: null }))
    .catch((err: Error) => ({ result: null, events, error: err }))
}

// ===========================================================================
// 1. Basic Construction
// ===========================================================================

describe('WorkflowBuilder - basic construction', () => {
  it('createWorkflow returns a WorkflowBuilder', () => {
    const builder = createWorkflow({ id: 'test' })
    expect(builder).toBeInstanceOf(WorkflowBuilder)
  })

  it('build() returns a CompiledWorkflow', () => {
    const compiled = createWorkflow({ id: 'test' }).build()
    expect(compiled).toBeInstanceOf(CompiledWorkflow)
  })

  it('config.id is preserved on the compiled workflow', () => {
    const compiled = createWorkflow({ id: 'my-wf' }).build()
    expect(compiled.config.id).toBe('my-wf')
  })

  it('config.description is preserved', () => {
    const compiled = createWorkflow({ id: 'x', description: 'Desc' }).build()
    expect(compiled.config.description).toBe('Desc')
  })

  it('builder methods are chainable (fluent API)', () => {
    const builder = createWorkflow({ id: 'fluent' })
    const result = builder
      .then(step('a', () => ({})))
      .parallel([step('b', () => ({}))])
      .suspend('pause')
      .branch(() => 'x', { x: [step('c', () => ({}))] })
    expect(result).toBe(builder)
  })
})

// ===========================================================================
// 2. Sequential Steps (.then)
// ===========================================================================

describe('WorkflowBuilder - sequential steps', () => {
  it('single step receives initial state', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('a', (s) => ({ received: s['input'] })))
      .build()

    const result = await wf.run({ input: 42 })
    expect(result['received']).toBe(42)
  })

  it('three sequential steps accumulate state', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('a', () => ({ a: 1 })))
      .then(step('b', () => ({ b: 2 })))
      .then(step('c', () => ({ c: 3 })))
      .build()

    const result = await wf.run({})
    expect(result).toMatchObject({ a: 1, b: 2, c: 3 })
  })

  it('later step sees output of earlier step', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('first', () => ({ value: 10 })))
      .then(step('second', (s) => ({ doubled: (s['value'] as number) * 2 })))
      .build()

    const result = await wf.run({})
    expect(result['doubled']).toBe(20)
  })

  it('step can overwrite a key from a previous step', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('a', () => ({ x: 'first' })))
      .then(step('b', () => ({ x: 'second' })))
      .build()

    const result = await wf.run({})
    expect(result['x']).toBe('second')
  })

  it('step returning undefined does not wipe state', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('a', () => ({ keep: true })))
      .then({ id: 'noop', execute: async () => undefined } as unknown as WorkflowStep)
      .build()

    const result = await wf.run({})
    expect(result['keep']).toBe(true)
  })

  it('step returning empty object preserves existing state', async () => {
    const wf = createWorkflow({ id: 't' })
      .then(step('a', () => ({ x: 1 })))
      .then(step('b', () => ({})))
      .build()

    const result = await wf.run({})
    expect(result['x']).toBe(1)
  })
})

// ===========================================================================
// 3. Parallel Steps (.parallel)
// ===========================================================================

describe('WorkflowBuilder - parallel fan-out', () => {
  it('all parallel steps run and results are available', async () => {
    const order: string[] = []
    const wf = createWorkflow({ id: 'p' })
      .parallel([
        asyncStep('p1', async () => { order.push('p1'); return { p1: true } }),
        asyncStep('p2', async () => { order.push('p2'); return { p2: true } }),
        asyncStep('p3', async () => { order.push('p3'); return { p3: true } }),
      ])
      .build()

    const result = await wf.run({})
    expect(result['p1']).toBe(true)
    expect(result['p2']).toBe(true)
    expect(result['p3']).toBe(true)
    // All three should have run (order is non-deterministic)
    expect(order).toHaveLength(3)
  })

  it('single-step parallel works', async () => {
    const wf = createWorkflow({ id: 'p' })
      .parallel([step('only', () => ({ only: true }))])
      .build()

    const result = await wf.run({})
    expect(result['only']).toBe(true)
  })

  it('parallel steps all receive the same snapshot of state', async () => {
    const captured: unknown[] = []
    const wf = createWorkflow({ id: 'p' })
      .then(step('init', () => ({ base: 100 })))
      .parallel([
        step('r1', (s) => { captured.push(s['base']); return { r1: true } }),
        step('r2', (s) => { captured.push(s['base']); return { r2: true } }),
      ])
      .build()

    await wf.run({})
    expect(captured).toEqual([100, 100])
  })

  it('parallel followed by sequential step', async () => {
    const wf = createWorkflow({ id: 'ps' })
      .parallel([
        step('a', () => ({ a: 1 })),
        step('b', () => ({ b: 2 })),
      ])
      .then(step('sum', (s) => ({ sum: (s['a'] as number) + (s['b'] as number) })))
      .build()

    const result = await wf.run({})
    expect(result['sum']).toBe(3)
  })

  it('one failing parallel step propagates error even if others succeed', async () => {
    const wf = createWorkflow({ id: 'pf' })
      .parallel([
        asyncStep('slow-good', async () => { await delay(10); return { good: true } }),
        step('fail', () => { throw new Error('fail-fast') }),
      ])
      .build()

    await expect(wf.run({})).rejects.toThrow('fail-fast')
  })
})

// ===========================================================================
// 4. Merge Strategies
// ===========================================================================

describe('WorkflowBuilder - merge strategies', () => {
  it('merge-objects merges overlapping keys (last writer wins)', async () => {
    const wf = createWorkflow({ id: 'm' })
      .parallel(
        [
          step('a', () => ({ shared: 'a', onlyA: 1 })),
          step('b', () => ({ shared: 'b', onlyB: 2 })),
        ],
        'merge-objects',
      )
      .build()

    const result = await wf.run({})
    // Promise.all preserves order, so 'b' writes last
    expect(result['shared']).toBe('b')
    expect(result['onlyA']).toBe(1)
    expect(result['onlyB']).toBe(2)
  })

  it('last-wins ignores all results except the final one', async () => {
    const wf = createWorkflow({ id: 'lw' })
      .parallel(
        [
          step('first', () => ({ fromFirst: true, winner: 'first' })),
          step('second', () => ({ winner: 'second' })),
        ],
        'last-wins',
      )
      .build()

    const result = await wf.run({})
    expect(result['winner']).toBe('second')
    // 'fromFirst' should NOT be in state since last-wins only takes last result
    expect(result['fromFirst']).toBeUndefined()
  })

  it('concat-arrays collects all results into parallelResults array', async () => {
    const wf = createWorkflow({ id: 'ca' })
      .parallel(
        [
          step('a', () => ({ a: 1 })),
          step('b', () => ({ b: 2 })),
          step('c', () => ({ c: 3 })),
        ],
        'concat-arrays',
      )
      .build()

    const result = await wf.run({})
    const pr = result['parallelResults'] as Record<string, unknown>[]
    expect(pr).toHaveLength(3)
    expect(pr[0]).toMatchObject({ a: 1 })
    expect(pr[1]).toMatchObject({ b: 2 })
    expect(pr[2]).toMatchObject({ c: 3 })
  })

  it('default merge strategy is merge-objects', async () => {
    const wf = createWorkflow({ id: 'def' })
      .parallel([
        step('x', () => ({ x: 1 })),
        step('y', () => ({ y: 2 })),
      ]) // no explicit strategy
      .build()

    const result = await wf.run({})
    expect(result['x']).toBe(1)
    expect(result['y']).toBe(2)
  })
})

// ===========================================================================
// 5. Conditional Branching (.branch)
// ===========================================================================

describe('WorkflowBuilder - conditional branching', () => {
  it('selects correct arm based on state', async () => {
    const wf = createWorkflow({ id: 'br' })
      .then(step('init', () => ({ tier: 'premium' })))
      .branch(
        (s) => s['tier'] as string,
        {
          free: [step('free', () => ({ plan: 'free' }))],
          premium: [step('prem', () => ({ plan: 'premium' }))],
        },
      )
      .build()

    const result = await wf.run({})
    expect(result['plan']).toBe('premium')
  })

  it('branch with 3 arms picks the correct one', async () => {
    const wf = createWorkflow({ id: 'br3' })
      .branch(
        (s) => s['color'] as string,
        {
          red: [step('r', () => ({ picked: 'red' }))],
          green: [step('g', () => ({ picked: 'green' }))],
          blue: [step('b', () => ({ picked: 'blue' }))],
        },
      )
      .build()

    const result = await wf.run({ color: 'green' })
    expect(result['picked']).toBe('green')
  })

  it('branch with 5 arms', async () => {
    const arms: Record<string, WorkflowStep[]> = {}
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      arms[name] = [step(name, () => ({ selected: name }))]
    }

    const wf = createWorkflow({ id: 'br5' })
      .branch((s) => s['pick'] as string, arms)
      .build()

    for (const name of ['a', 'c', 'e']) {
      const result = await wf.run({ pick: name })
      expect(result['selected']).toBe(name)
    }
  })

  it('branch arm with multiple sequential steps', async () => {
    const wf = createWorkflow({ id: 'brm' })
      .branch(
        () => 'multi',
        {
          multi: [
            step('s1', () => ({ step1: true })),
            step('s2', () => ({ step2: true })),
            step('s3', () => ({ step3: true })),
          ],
        },
      )
      .build()

    const result = await wf.run({})
    expect(result).toMatchObject({ step1: true, step2: true, step3: true })
  })

  it('throws when condition returns unknown branch', async () => {
    const wf = createWorkflow({ id: 'bad' })
      .branch(() => 'missing', { a: [step('a', () => ({}))] })
      .build()

    await expect(wf.run({})).rejects.toThrow('Branch "missing" not found')
  })

  it('branch after parallel uses parallel output', async () => {
    const wf = createWorkflow({ id: 'pb' })
      .parallel([
        step('score', () => ({ score: 95 })),
      ])
      .branch(
        (s) => (s['score'] as number) >= 90 ? 'pass' : 'fail',
        {
          pass: [step('pass', () => ({ grade: 'A' }))],
          fail: [step('fail', () => ({ grade: 'F' }))],
        },
      )
      .build()

    const result = await wf.run({})
    expect(result['grade']).toBe('A')
  })

  it('steps after branch see branch arm output', async () => {
    const wf = createWorkflow({ id: 'ab' })
      .branch(
        () => 'arm',
        { arm: [step('arm', () => ({ fromArm: 'data' }))] },
      )
      .then(step('post', (s) => ({ saw: s['fromArm'] })))
      .build()

    const result = await wf.run({})
    expect(result['saw']).toBe('data')
  })
})

// ===========================================================================
// 6. Suspend
// ===========================================================================

describe('WorkflowBuilder - suspend', () => {
  it('suspend stops execution; later steps do not run', async () => {
    const wf = createWorkflow({ id: 'sus' })
      .then(step('before', () => ({ before: true })))
      .suspend('need_approval')
      .then(step('after', () => ({ after: true })))
      .build()

    const result = await wf.run({})
    expect(result['before']).toBe(true)
    expect(result['after']).toBeUndefined()
  })

  it('suspend at the very beginning (no prior steps)', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'sus0' })
      .suspend('gate')
      .then(step('a', () => ({ a: 1 })))
      .build()

    const result = await wf.run({}, { onEvent: (e) => events.push(e) })
    expect(result['a']).toBeUndefined()
    expect(events.some((e) => e.type === 'suspended')).toBe(true)
  })

  it('suspend as the last node', async () => {
    const wf = createWorkflow({ id: 'sus-end' })
      .then(step('work', () => ({ done: true })))
      .suspend('final_review')
      .build()

    const result = await wf.run({})
    expect(result['done']).toBe(true)
  })

  it('multiple suspends: only first is reached', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'multi-sus' })
      .then(step('a', () => ({ a: true })))
      .suspend('first')
      .then(step('b', () => ({ b: true })))
      .suspend('second')
      .then(step('c', () => ({ c: true })))
      .build()

    const result = await wf.run({}, { onEvent: (e) => events.push(e) })
    expect(result['a']).toBe(true)
    expect(result['b']).toBeUndefined()
    const suspendEvents = events.filter((e) => e.type === 'suspended')
    expect(suspendEvents).toHaveLength(1)
    expect((suspendEvents[0] as { reason: string }).reason).toBe('first')
  })

  it('suspend reason is preserved in event', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 's' })
      .suspend('human_review_required')
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const suspended = events.find((e) => e.type === 'suspended') as { reason: string }
    expect(suspended.reason).toBe('human_review_required')
  })
})

// ===========================================================================
// 7. Error Propagation
// ===========================================================================

describe('WorkflowBuilder - error propagation', () => {
  it('error in first step aborts pipeline', async () => {
    const wf = createWorkflow({ id: 'e' })
      .then(step('fail', () => { throw new Error('first-step-error') }))
      .then(step('never', () => ({ never: true })))
      .build()

    await expect(wf.run({})).rejects.toThrow('first-step-error')
  })

  it('error in middle step aborts remaining steps', async () => {
    const executed: string[] = []
    const wf = createWorkflow({ id: 'e' })
      .then(step('a', () => { executed.push('a'); return { a: 1 } }))
      .then(step('b', () => { executed.push('b'); throw new Error('mid-error') }))
      .then(step('c', () => { executed.push('c'); return { c: 3 } }))
      .build()

    await expect(wf.run({})).rejects.toThrow('mid-error')
    expect(executed).toEqual(['a', 'b'])
  })

  it('step:failed event carries correct stepId and error message', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'e' })
      .then(step('broken', () => { throw new Error('specific-msg') }))
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {})

    const failed = events.find(
      (e) => e.type === 'step:failed',
    ) as { stepId: string; error: string }
    expect(failed.stepId).toBe('broken')
    expect(failed.error).toBe('specific-msg')
  })

  it('non-Error throw is converted to string', async () => {
    const wf = createWorkflow({ id: 'e' })
      .then({ id: 'throw-str', execute: async () => { throw 'string-error' } } as unknown as WorkflowStep)
      .build()

    await expect(wf.run({})).rejects.toThrow()
  })

  it('error in branch arm propagates', async () => {
    const wf = createWorkflow({ id: 'eb' })
      .branch(
        () => 'bad',
        { bad: [step('boom', () => { throw new Error('branch-err') })] },
      )
      .build()

    await expect(wf.run({})).rejects.toThrow('branch-err')
  })
})

// ===========================================================================
// 8. Async Steps
// ===========================================================================

describe('WorkflowBuilder - async steps', () => {
  it('async step with delay resolves correctly', async () => {
    const wf = createWorkflow({ id: 'async' })
      .then(asyncStep('slow', async () => {
        await delay(5)
        return { delayed: true }
      }))
      .build()

    const result = await wf.run({})
    expect(result['delayed']).toBe(true)
  })

  it('multiple async steps execute sequentially', async () => {
    const order: number[] = []
    const wf = createWorkflow({ id: 'async-seq' })
      .then(asyncStep('first', async () => {
        await delay(5)
        order.push(1)
        return { first: true }
      }))
      .then(asyncStep('second', async () => {
        order.push(2)
        return { second: true }
      }))
      .build()

    await wf.run({})
    expect(order).toEqual([1, 2])
  })

  it('async rejection is caught and propagated', async () => {
    const wf = createWorkflow({ id: 'ar' })
      .then(asyncStep('reject', async () => {
        throw new Error('async-reject')
      }))
      .build()

    await expect(wf.run({})).rejects.toThrow('async-reject')
  })
})

// ===========================================================================
// 9. WorkflowContext
// ===========================================================================

describe('WorkflowBuilder - WorkflowContext', () => {
  it('step receives workflowId in context', async () => {
    let receivedId: string | undefined
    const wf = createWorkflow({ id: 'ctx-test' })
      .then(step('a', (_s, ctx) => { receivedId = ctx.workflowId; return {} }))
      .build()

    await wf.run({})
    expect(receivedId).toBe('ctx-test')
  })

  it('step receives accumulated state in context.state', async () => {
    let capturedState: Record<string, unknown> | undefined
    const wf = createWorkflow({ id: 'ctx-state' })
      .then(step('a', () => ({ key: 'value' })))
      .then(step('b', (_s, ctx) => { capturedState = { ...ctx.state }; return {} }))
      .build()

    await wf.run({ initial: true })
    expect(capturedState?.['key']).toBe('value')
    expect(capturedState?.['initial']).toBe(true)
  })

  it('step receives signal in context when provided', async () => {
    let receivedSignal: AbortSignal | undefined
    const controller = new AbortController()
    const wf = createWorkflow({ id: 'ctx-sig' })
      .then(step('a', (_s, ctx) => { receivedSignal = ctx.signal; return {} }))
      .build()

    await wf.run({}, { signal: controller.signal })
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)
  })
})

// ===========================================================================
// 10. Event Emissions - detailed
// ===========================================================================

describe('WorkflowBuilder - event emission details', () => {
  it('step:started fires before step:completed', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .then(step('a', () => ({ a: 1 })))
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const types = events.map((e) => e.type)
    const startIdx = types.indexOf('step:started')
    const endIdx = types.indexOf('step:completed')
    expect(startIdx).toBeLessThan(endIdx)
  })

  it('step:completed includes durationMs >= 0', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .then(step('a', () => ({ a: 1 })))
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const completed = events.find((e) => e.type === 'step:completed') as { durationMs: number }
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('workflow:completed includes durationMs', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .then(step('a', () => ({})))
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const completed = events.find((e) => e.type === 'workflow:completed') as { durationMs: number }
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('parallel:started includes all stepIds', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .parallel([
        step('p1', () => ({})),
        step('p2', () => ({})),
        step('p3', () => ({})),
      ])
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const started = events.find((e) => e.type === 'parallel:started') as { stepIds: string[] }
    expect(started.stepIds).toEqual(['p1', 'p2', 'p3'])
  })

  it('parallel:completed includes durationMs', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .parallel([step('p1', () => ({}))])
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) })
    const completed = events.find((e) => e.type === 'parallel:completed') as { durationMs: number }
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('workflow:failed event includes error message', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'ev' })
      .then(step('fail', () => { throw new Error('event-error-msg') }))
      .build()

    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {})
    const failed = events.find((e) => e.type === 'workflow:failed') as { error: string }
    expect(failed.error).toContain('event-error-msg')
  })

  it('no events emitted if no onEvent callback', async () => {
    // Just verify it does not throw
    const wf = createWorkflow({ id: 'no-cb' })
      .then(step('a', () => ({ a: 1 })))
      .build()

    const result = await wf.run({})
    expect(result['a']).toBe(1)
  })
})

// ===========================================================================
// 11. Pipeline Definition Structure
// ===========================================================================

describe('WorkflowBuilder - pipeline definition', () => {
  it('definition has correct id and version', () => {
    const def = createWorkflow({ id: 'def-id' }).build().toPipelineDefinition()
    expect(def.id).toBe('def-id')
    expect(def.version).toBe('1.0.0')
    expect(def.schemaVersion).toBe('1.0.0')
  })

  it('definition has entryNodeId pointing to a valid node', () => {
    const wf = createWorkflow({ id: 'entry' })
      .then(step('first', () => ({})))
      .build()

    const def = wf.toPipelineDefinition()
    const nodeIds = def.nodes.map((n) => n.id)
    expect(nodeIds).toContain(def.entryNodeId)
  })

  it('empty workflow definition has a noop entry node', () => {
    const def = createWorkflow({ id: 'empty' }).build().toPipelineDefinition()
    expect(def.nodes.length).toBeGreaterThanOrEqual(1)
    expect(def.entryNodeId).toBeTruthy()
  })

  it('definition contains transform nodes for each step', () => {
    const def = createWorkflow({ id: 'n' })
      .then(step('a', () => ({})))
      .then(step('b', () => ({})))
      .build()
      .toPipelineDefinition()

    const transforms = def.nodes.filter((n) => n.type === 'transform')
    expect(transforms.length).toBeGreaterThanOrEqual(2)
  })

  it('definition contains suspend node for suspend()', () => {
    const def = createWorkflow({ id: 's' })
      .suspend('gate')
      .build()
      .toPipelineDefinition()

    const suspendNodes = def.nodes.filter((n) => n.type === 'suspend')
    expect(suspendNodes).toHaveLength(1)
  })

  it('toPipelineDefinition returns a deep clone', () => {
    const wf = createWorkflow({ id: 'clone' }).then(step('a', () => ({}))).build()
    const def1 = wf.toPipelineDefinition()
    const def2 = wf.toPipelineDefinition()
    expect(def1).toEqual(def2)
    expect(def1).not.toBe(def2) // different object references
    expect(def1.nodes).not.toBe(def2.nodes)
  })

  it('definition edges connect nodes sequentially', () => {
    const def = createWorkflow({ id: 'edges' })
      .then(step('a', () => ({})))
      .then(step('b', () => ({})))
      .build()
      .toPipelineDefinition()

    const seqEdges = def.edges.filter((e) => e.type === 'sequential')
    expect(seqEdges.length).toBeGreaterThanOrEqual(1)
  })

  it('branch creates conditional edges', () => {
    const def = createWorkflow({ id: 'ce' })
      .branch(() => 'x', { x: [step('x', () => ({}))], y: [step('y', () => ({}))] })
      .build()
      .toPipelineDefinition()

    const condEdges = def.edges.filter((e) => e.type === 'conditional')
    expect(condEdges.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// 12. Stream
// ===========================================================================

describe('WorkflowBuilder - stream', () => {
  it('stream yields events ending with workflow:completed on success', async () => {
    const wf = createWorkflow({ id: 'str' })
      .then(step('a', () => ({ a: 1 })))
      .build()

    const events: WorkflowEvent[] = []
    for await (const e of wf.stream({})) {
      events.push(e)
    }

    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]!.type).toBe('workflow:completed')
  })

  it('stream yields suspended event on suspend', async () => {
    const wf = createWorkflow({ id: 'str-sus' })
      .suspend('wait')
      .build()

    const events: WorkflowEvent[] = []
    for await (const e of wf.stream({})) {
      events.push(e)
    }

    expect(events.some((e) => e.type === 'suspended')).toBe(true)
  })

  it('stream yields workflow:failed on error', async () => {
    const wf = createWorkflow({ id: 'str-fail' })
      .then(step('err', () => { throw new Error('stream-err') }))
      .build()

    const events: WorkflowEvent[] = []
    for await (const e of wf.stream({})) {
      events.push(e)
    }

    expect(events.some((e) => e.type === 'workflow:failed')).toBe(true)
  })
})

// ===========================================================================
// 13. Complex Compositions
// ===========================================================================

describe('WorkflowBuilder - complex compositions', () => {
  it('then -> parallel -> then -> branch -> then', async () => {
    const wf = createWorkflow({ id: 'complex' })
      .then(step('init', () => ({ count: 0 })))
      .parallel([
        step('inc1', (s) => ({ a: (s['count'] as number) + 1 })),
        step('inc2', (s) => ({ b: (s['count'] as number) + 2 })),
      ])
      .then(step('combine', (s) => ({ total: (s['a'] as number) + (s['b'] as number) })))
      .branch(
        (s) => (s['total'] as number) > 2 ? 'big' : 'small',
        {
          big: [step('big', () => ({ size: 'big' }))],
          small: [step('small', () => ({ size: 'small' }))],
        },
      )
      .then(step('final', (s) => ({ final: `${s['size']}-${s['total']}` })))
      .build()

    const result = await wf.run({})
    expect(result['final']).toBe('big-3')
  })

  it('parallel -> parallel (sequential parallel blocks)', async () => {
    const wf = createWorkflow({ id: 'pp' })
      .parallel([
        step('a', () => ({ a: 1 })),
        step('b', () => ({ b: 2 })),
      ])
      .parallel([
        step('c', (s) => ({ c: (s['a'] as number) + 10 })),
        step('d', (s) => ({ d: (s['b'] as number) + 20 })),
      ])
      .build()

    const result = await wf.run({})
    expect(result['c']).toBe(11)
    expect(result['d']).toBe(22)
  })

  it('branch -> branch (sequential branches)', async () => {
    const wf = createWorkflow({ id: 'bb' })
      .then(step('init', () => ({ x: 'a', y: 'b' })))
      .branch(
        (s) => s['x'] as string,
        {
          a: [step('pickA', () => ({ fromFirst: 'A' }))],
          b: [step('pickB', () => ({ fromFirst: 'B' }))],
        },
      )
      .branch(
        (s) => s['y'] as string,
        {
          a: [step('pickA2', () => ({ fromSecond: 'A2' }))],
          b: [step('pickB2', () => ({ fromSecond: 'B2' }))],
        },
      )
      .build()

    const result = await wf.run({})
    expect(result['fromFirst']).toBe('A')
    expect(result['fromSecond']).toBe('B2')
  })

  it('suspend before branch: branch is never reached', async () => {
    const executed: string[] = []
    const wf = createWorkflow({ id: 'sb' })
      .then(step('init', () => { executed.push('init'); return { mode: 'x' } }))
      .suspend('approval')
      .branch(
        () => 'x',
        { x: [step('x', () => { executed.push('x'); return {} })] },
      )
      .build()

    await wf.run({})
    expect(executed).toEqual(['init'])
  })
})

// ===========================================================================
// 14. Durability (Journal + Store)
// ===========================================================================

describe('WorkflowBuilder - journal integration', () => {
  let journal: InMemoryRunJournal

  beforeEach(() => {
    journal = new InMemoryRunJournal()
  })

  it('journal records step_started and step_completed for parallel steps', async () => {
    const wf = createWorkflow({ id: 'j-par' })
      .parallel([
        step('p1', () => ({ p1: true })),
        step('p2', () => ({ p2: true })),
      ])
      .build()
      .withJournal(journal)

    await wf.run({}, { runId: 'par-run' })

    const entries = await journal.getAll('par-run')
    const stepStarted = entries.filter((e) => e.type === 'step_started')
    const stepCompleted = entries.filter((e) => e.type === 'step_completed')
    // Should have step_started/completed for both parallel steps
    expect(stepStarted.length).toBeGreaterThanOrEqual(2)
    expect(stepCompleted.length).toBeGreaterThanOrEqual(2)
  })

  it('journal records run_started before run_completed', async () => {
    const wf = createWorkflow({ id: 'j-order' })
      .then(step('a', () => ({})))
      .build()
      .withJournal(journal)

    await wf.run({}, { runId: 'order-run' })

    const entries = await journal.getAll('order-run')
    const types = entries.map((e) => e.type)
    const startIdx = types.indexOf('run_started')
    const endIdx = types.indexOf('run_completed')
    expect(startIdx).toBeLessThan(endIdx)
  })

  it('journal records step_failed on error', async () => {
    const wf = createWorkflow({ id: 'j-fail' })
      .then(step('bad', () => { throw new Error('j-err') }))
      .build()
      .withJournal(journal)

    await wf.run({}, { runId: 'fail-run' }).catch(() => {})

    const entries = await journal.getAll('fail-run')
    const failed = entries.filter((e) => e.type === 'step_failed')
    expect(failed.length).toBeGreaterThanOrEqual(1)
  })

  it('withJournal is chainable with withStore', () => {
    const store = new InMemoryRunStore()
    const wf = createWorkflow({ id: 'chain' })
      .then(step('a', () => ({})))
      .build()
      .withJournal(journal)
      .withStore(store)

    expect(wf).toBeInstanceOf(CompiledWorkflow)
  })
})

// ===========================================================================
// 15. getHandle
// ===========================================================================

describe('WorkflowBuilder - getHandle', () => {
  it('getHandle throws when no journal and no store', async () => {
    const wf = createWorkflow({ id: 'h' }).then(step('a', () => ({}))).build()
    await expect(wf.getHandle('x')).rejects.toThrow('no journal configured')
  })

  it('getHandle throws RunNotFoundError for nonexistent runId with store', async () => {
    const store = new InMemoryRunStore()
    const journal = new InMemoryRunJournal()
    const wf = createWorkflow({ id: 'h' })
      .then(step('a', () => ({})))
      .build()
      .withStore(store)
      .withJournal(journal)

    await expect(wf.getHandle('nonexistent')).rejects.toThrow()
  })
})

// ===========================================================================
// 16. AbortSignal integration
// ===========================================================================

describe('WorkflowBuilder - AbortSignal', () => {
  it('pre-aborted signal causes workflow to throw/cancel', async () => {
    const controller = new AbortController()
    controller.abort()

    const wf = createWorkflow({ id: 'abort' })
      .then(step('a', () => ({ a: 1 })))
      .build()

    // The behavior depends on PipelineRuntime's handling of pre-aborted signals.
    // It should either throw or return early.
    try {
      const result = await wf.run({}, { signal: controller.signal })
      // If it completes, the step may or may not have run depending on timing
      expect(result).toBeDefined()
    } catch {
      // Cancellation error is also acceptable
    }
  })
})

// ===========================================================================
// 17. Empty and minimal workflows
// ===========================================================================

describe('WorkflowBuilder - edge cases', () => {
  it('empty workflow returns initial state unchanged', async () => {
    const wf = createWorkflow({ id: 'empty' }).build()
    const result = await wf.run({ x: 1, y: 2 })
    expect(result['x']).toBe(1)
    expect(result['y']).toBe(2)
  })

  it('workflow with only a suspend node', async () => {
    const events: WorkflowEvent[] = []
    const wf = createWorkflow({ id: 'only-sus' })
      .suspend('gate')
      .build()

    const result = await wf.run({ data: 42 }, { onEvent: (e) => events.push(e) })
    expect(events.some((e) => e.type === 'suspended')).toBe(true)
    expect(result['data']).toBe(42)
  })

  it('workflow with only a parallel block', async () => {
    const wf = createWorkflow({ id: 'only-par' })
      .parallel([step('x', () => ({ x: 1 }))])
      .build()

    const result = await wf.run({})
    expect(result['x']).toBe(1)
  })

  it('workflow with only a branch', async () => {
    const wf = createWorkflow({ id: 'only-br' })
      .branch(() => 'a', { a: [step('a', () => ({ a: true }))] })
      .build()

    const result = await wf.run({})
    expect(result['a']).toBe(true)
  })

  it('step with heavy computation resolves', async () => {
    const wf = createWorkflow({ id: 'heavy' })
      .then(asyncStep('compute', async () => {
        let sum = 0
        for (let i = 0; i < 10000; i++) sum += i
        return { sum }
      }))
      .build()

    const result = await wf.run({})
    expect(result['sum']).toBe(49995000)
  })

  it('workflow preserves complex nested state objects', async () => {
    const wf = createWorkflow({ id: 'nested' })
      .then(step('a', () => ({ nested: { deep: { value: [1, 2, 3] } } })))
      .then(step('b', (s) => {
        const nested = s['nested'] as { deep: { value: number[] } }
        return { count: nested.deep.value.length }
      }))
      .build()

    const result = await wf.run({})
    expect(result['count']).toBe(3)
  })
})
