import { describe, it, expect, vi } from 'vitest'
import { createWorkflow, type WorkflowEvent } from '../workflow/index.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'

function step(id: string, fn: (state: Record<string, unknown>) => Record<string, unknown>): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) }
}

describe('WorkflowBuilder', () => {
  it('executes sequential steps', async () => {
    const workflow = createWorkflow({ id: 'test' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .then(step('b', (s) => ({ ...s, b: true })))
      .build()

    const result = await workflow.run({ initial: true })
    expect(result['a']).toBe(true)
    expect(result['b']).toBe(true)
    expect(result['initial']).toBe(true)
  })

  it('executes parallel steps and merges results', async () => {
    const workflow = createWorkflow({ id: 'par' })
      .parallel([
        step('p1', () => ({ p1: 'done' })),
        step('p2', () => ({ p2: 'done' })),
        step('p3', () => ({ p3: 'done' })),
      ])
      .build()

    const result = await workflow.run({})
    expect(result['p1']).toBe('done')
    expect(result['p2']).toBe('done')
    expect(result['p3']).toBe('done')
  })

  it('executes conditional branches', async () => {
    const workflow = createWorkflow({ id: 'branch' })
      .then(step('init', () => ({ mode: 'fast' })))
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
    expect(result['result']).toBe('quick-done')
  })

  it('emits events during execution', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'events' })
      .then(step('a', () => ({ done: true })))
      .build()

    await workflow.run({}, { onEvent: (e) => events.push(e) })

    const types = events.map(e => e.type)
    expect(types).toContain('step:started')
    expect(types).toContain('step:completed')
    expect(types).toContain('workflow:completed')
  })

  it('emits suspended event on suspend node', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'suspend' })
      .then(step('plan', () => ({ plan: 'done' })))
      .suspend('review_needed')
      .then(step('execute', () => ({ executed: true })))
      .build()

    const result = await workflow.run({}, { onEvent: (e) => events.push(e) })

    const suspended = events.find(e => e.type === 'suspended')
    expect(suspended).toBeDefined()
    expect((suspended as { reason: string }).reason).toBe('review_needed')
    expect(result['plan']).toBe('done')
    expect(result['executed']).toBeUndefined()
  })

  it('compiles workflow into canonical PipelineDefinition', () => {
    const workflow = createWorkflow({ id: 'compiled' })
      .then(step('a', () => ({ a: 1 })))
      .branch(
        () => 'x',
        {
          x: [step('x1', () => ({ x: true }))],
          y: [step('y1', () => ({ y: true }))],
        },
      )
      .build()

    const definition = workflow.toPipelineDefinition()
    expect(definition.id).toBe('compiled')
    expect(definition.schemaVersion).toBe('1.0.0')
    expect(definition.entryNodeId.length).toBeGreaterThan(0)
    expect(definition.nodes.length).toBeGreaterThan(0)
    expect(definition.edges.length).toBeGreaterThan(0)
  })

  it('propagates step errors', async () => {
    const workflow = createWorkflow({ id: 'err' })
      .then(step('fail', () => { throw new Error('boom') }))
      .build()

    await expect(workflow.run({})).rejects.toThrow('boom')
  })

  it('emits workflow:failed on error', async () => {
    const events: WorkflowEvent[] = []
    const workflow = createWorkflow({ id: 'err' })
      .then(step('fail', () => { throw new Error('oops') }))
      .build()

    await workflow.run({}, { onEvent: (e) => events.push(e) }).catch(() => {})

    expect(events.some(e => e.type === 'workflow:failed')).toBe(true)
  })

  it('supports stream() async generator', async () => {
    const workflow = createWorkflow({ id: 'stream' })
      .then(step('a', () => ({ a: 1 })))
      .then(step('b', () => ({ b: 2 })))
      .build()

    const events: WorkflowEvent[] = []
    for await (const event of workflow.stream({})) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]!.type).toBe('workflow:completed')
  })
})
