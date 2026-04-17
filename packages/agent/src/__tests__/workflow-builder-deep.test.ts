import { describe, it, expect, vi } from 'vitest'
import { createWorkflow, type WorkflowEvent } from '../workflow/index.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import { InMemoryRunJournal, InMemoryRunStore } from '@dzupagent/core'

function step(id: string, fn: (state: Record<string, unknown>) => Record<string, unknown>): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) }
}

function asyncStep(id: string, fn: (state: Record<string, unknown>) => Promise<Record<string, unknown>>): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) }
}

describe('WorkflowBuilder - merge strategies', () => {
  it('last-wins merge strategy uses only the last result', async () => {
    const workflow = createWorkflow({ id: 'last-wins' })
      .parallel(
        [
          step('first', () => ({ winner: 'first', firstOnly: true })),
          step('second', () => ({ winner: 'second', secondOnly: true })),
        ],
        'last-wins',
      )
      .build()

    const result = await workflow.run({})
    expect(result['winner']).toBe('second')
    expect(result['secondOnly']).toBe(true)
  })

  it('concat-arrays merge strategy stores results in parallelResults', async () => {
    const workflow = createWorkflow({ id: 'concat' })
      .parallel(
        [
          step('a', () => ({ a: 1 })),
          step('b', () => ({ b: 2 })),
        ],
        'concat-arrays',
      )
      .build()

    const result = await workflow.run({})
    expect(result['parallelResults']).toBeDefined()
    expect(Array.isArray(result['parallelResults'])).toBe(true)
  })

  it('merge-objects (default) merges all results', async () => {
    const workflow = createWorkflow({ id: 'merge-obj' })
      .parallel([
        step('x', () => ({ x: 10 })),
        step('y', () => ({ y: 20 })),
      ])
      .build()

    const result = await workflow.run({})
    expect(result['x']).toBe(10)
    expect(result['y']).toBe(20)
  })
})

describe('WorkflowBuilder - branch edge cases', () => {
  it('takes the other branch path', async () => {
    const workflow = createWorkflow({ id: 'branch-b' })
      .then(step('init', () => ({ mode: 'slow' })))
      .branch(
        (s) => s['mode'] === 'fast' ? 'quick' : 'thorough',
        {
          quick: [step('quick', () => ({ result: 'quick-done' }))],
          thorough: [
            step('t1', () => ({ step1: true })),
            step('t2', () => ({ result: 'thorough-done' })),
          ],
        },
      )
      .build()

    const result = await workflow.run({})
    expect(result['result']).toBe('thorough-done')
    expect(result['step1']).toBe(true)
  })

  it('throws on unknown branch selection', async () => {
    const workflow = createWorkflow({ id: 'bad-branch' })
      .branch(
        () => 'nonexistent',
        {
          alpha: [step('a', () => ({ a: 1 }))],
          beta: [step('b', () => ({ b: 2 }))],
        },
      )
      .build()

    await expect(workflow.run({})).rejects.toThrow('Branch "nonexistent" not found')
  })

  it('handles branch with empty step arrays', async () => {
    const workflow = createWorkflow({ id: 'empty-branch' })
      .branch(
        () => 'empty',
        { empty: [] },
      )
      .build()

    // Should not throw -- noop passthrough
    const result = await workflow.run({ x: 1 })
    expect(result).toBeDefined()
  })
})

describe('WorkflowBuilder - empty workflow', () => {
  it('handles workflow with no nodes', async () => {
    const workflow = createWorkflow({ id: 'empty' }).build()
    const result = await workflow.run({ initial: true })
    expect(result['initial']).toBe(true)
  })
})

describe('WorkflowBuilder - step that returns undefined', () => {
  it('handles step that returns undefined', async () => {
    const workflow = createWorkflow({ id: 'undef-step' })
      .then({ id: 'noop', execute: async () => undefined } as unknown as WorkflowStep)
      .then(step('after', (s) => ({ ...s, after: true })))
      .build()

    const result = await workflow.run({ before: true })
    expect(result['before']).toBe(true)
    expect(result['after']).toBe(true)
  })
})

describe('WorkflowBuilder - parallel step failure', () => {
  it('propagates error from parallel step', async () => {
    const workflow = createWorkflow({ id: 'par-fail' })
      .parallel([
        step('good', () => ({ good: true })),
        step('bad', () => { throw new Error('parallel boom') }),
      ])
      .build()

    await expect(workflow.run({})).rejects.toThrow('parallel boom')
  })

  it('emits step:failed event for failed parallel step', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'par-fail-events' })
      .parallel([
        step('good', () => ({ good: true })),
        step('bad', () => { throw new Error('pfail') }),
      ])
      .build()

    await workflow.run({}, { onEvent: (e) => events.push(e) }).catch(() => {})

    expect(events.some(e => e.type === 'step:failed' && 'stepId' in e && e.stepId === 'bad')).toBe(true)
  })
})

describe('WorkflowBuilder - event emissions', () => {
  it('emits parallel:started and parallel:completed events', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'par-events' })
      .parallel([
        step('p1', () => ({ p1: true })),
        step('p2', () => ({ p2: true })),
      ])
      .build()

    await workflow.run({}, { onEvent: (e) => events.push(e) })

    expect(events.some(e => e.type === 'parallel:started')).toBe(true)
    expect(events.some(e => e.type === 'parallel:completed')).toBe(true)
  })

  it('emits branch:evaluated event', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'branch-events' })
      .branch(
        () => 'alpha',
        { alpha: [step('a', () => ({ done: true }))] },
      )
      .build()

    await workflow.run({}, { onEvent: (e) => events.push(e) })

    const branchEvt = events.find(e => e.type === 'branch:evaluated')
    expect(branchEvt).toBeDefined()
    expect((branchEvt as { selected: string }).selected).toBe('alpha')
  })
})

describe('WorkflowBuilder - pipeline definition', () => {
  it('toPipelineDefinition returns stable definition with metadata', () => {
    const workflow = createWorkflow({ id: 'def-test', description: 'Test workflow' })
      .then(step('a', () => ({})))
      .build()

    const def = workflow.toPipelineDefinition()
    expect(def.id).toBe('def-test')
    expect(def.description).toBe('Test workflow')
    expect(def.metadata).toMatchObject({ source: 'WorkflowBuilder', runtime: 'PipelineRuntime' })
    expect(def.tags).toContain('workflow-compat')
    expect(def.checkpointStrategy).toBe('none')
  })
})

describe('WorkflowBuilder - getHandle errors', () => {
  it('throws RunNotFoundError when store has no matching run', async () => {
    const store = new InMemoryRunStore()
    const journal = new InMemoryRunJournal()
    const workflow = createWorkflow({ id: 'handle-err' })
      .then(step('a', () => ({})))
      .build()
      .withStore(store)
      .withJournal(journal)

    await expect(workflow.getHandle('nonexistent-run')).rejects.toThrow()
  })

  it('throws when no journal is configured', async () => {
    const workflow = createWorkflow({ id: 'no-journal' })
      .then(step('a', () => ({})))
      .build()

    await expect(workflow.getHandle('some-run')).rejects.toThrow('no journal configured')
  })
})

describe('WorkflowBuilder - stream error handling', () => {
  it('stream yields workflow:failed on error', async () => {
    const workflow = createWorkflow({ id: 'stream-fail' })
      .then(step('fail', () => { throw new Error('stream boom') }))
      .build()

    const events: WorkflowEvent[] = []
    for await (const event of workflow.stream({})) {
      events.push(event)
    }

    expect(events.some(e => e.type === 'workflow:failed')).toBe(true)
  })
})

describe('WorkflowBuilder - complex workflows', () => {
  it('executes sequential -> parallel -> branch -> sequential', async () => {
    const workflow = createWorkflow({ id: 'complex' })
      .then(step('init', () => ({ initialized: true })))
      .parallel([
        step('fetch-a', () => ({ dataA: 'A' })),
        step('fetch-b', () => ({ dataB: 'B' })),
      ])
      .then(step('merge', (s) => ({
        ...s,
        merged: `${s['dataA']}-${s['dataB']}`,
        quality: 'high',
      })))
      .branch(
        (s) => s['quality'] === 'high' ? 'publish' : 'review',
        {
          publish: [step('publish', (s) => ({ ...s, published: true }))],
          review: [step('review', (s) => ({ ...s, reviewed: true }))],
        },
      )
      .build()

    const result = await workflow.run({})
    expect(result['initialized']).toBe(true)
    expect(result['merged']).toBe('A-B')
    expect(result['published']).toBe(true)
    expect(result['reviewed']).toBeUndefined()
  })
})
