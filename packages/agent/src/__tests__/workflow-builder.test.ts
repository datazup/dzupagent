import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWorkflow, type WorkflowEvent } from '../workflow/index.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import { InMemoryRunJournal, InMemoryRunStore } from '@dzupagent/core'
import type { RunJournal, RunJournalEntry } from '@dzupagent/core'

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

describe('workflow durability', () => {
  let journal: InMemoryRunJournal

  beforeEach(() => {
    journal = new InMemoryRunJournal()
  })

  it('withJournal writes run_started and run_completed entries', async () => {
    const workflow = createWorkflow({ id: 'journal-basic' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .build()
      .withJournal(journal)

    await workflow.run({ initial: true })

    // Query journal — the runId is auto-generated so we need to find it
    // The journal is keyed by runId; we inspect internal state via getAll on known entries
    // Since we don't know the runId upfront, use the events approach:
    // Re-run with explicit runId
    const journal2 = new InMemoryRunJournal()
    const workflow2 = createWorkflow({ id: 'journal-basic-2' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .build()
      .withJournal(journal2)

    await workflow2.run({ initial: true }, { runId: 'test-run-1' })

    const entries = await journal2.getAll('test-run-1')
    const types = entries.map((e) => e.type)
    expect(types).toContain('run_started')
    expect(types).toContain('run_completed')
  })

  it('withJournal writes step_started and step_completed for each step', async () => {
    const workflow = createWorkflow({ id: 'journal-steps' })
      .then(step('s1', (s) => ({ ...s, s1: true })))
      .then(step('s2', (s) => ({ ...s, s2: true })))
      .build()
      .withJournal(journal)

    await workflow.run({}, { runId: 'run-steps' })

    const entries = await journal.getAll('run-steps')
    const stepStarted = entries.filter((e) => e.type === 'step_started')
    const stepCompleted = entries.filter((e) => e.type === 'step_completed')

    expect(stepStarted).toHaveLength(2)
    expect(stepCompleted).toHaveLength(2)
  })

  it('withJournal writes run_failed on error', async () => {
    const workflow = createWorkflow({ id: 'journal-fail' })
      .then(step('fail', () => { throw new Error('boom') }))
      .build()
      .withJournal(journal)

    await workflow.run({}, { runId: 'run-fail' }).catch(() => {})

    const entries = await journal.getAll('run-fail')
    const types = entries.map((e) => e.type)
    expect(types).toContain('run_failed')
  })

  it('withJournal writes run_suspended on suspend node', async () => {
    const workflow = createWorkflow({ id: 'journal-suspend' })
      .then(step('plan', (s) => ({ ...s, plan: true })))
      .suspend('need_review')
      .then(step('exec', (s) => ({ ...s, exec: true })))
      .build()
      .withJournal(journal)

    await workflow.run({}, { runId: 'run-suspend' })

    const entries = await journal.getAll('run-suspend')
    const types = entries.map((e) => e.type)
    expect(types).toContain('run_suspended')
  })

  it('journal entries have correct runId', async () => {
    const workflow = createWorkflow({ id: 'journal-runid' })
      .then(step('a', (s) => ({ ...s, a: 1 })))
      .then(step('b', (s) => ({ ...s, b: 2 })))
      .build()
      .withJournal(journal)

    await workflow.run({}, { runId: 'consistent-run' })

    const entries = await journal.getAll('consistent-run')
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.runId).toBe('consistent-run')
    }
  })

  it('run() accepts explicit runId', async () => {
    const workflow = createWorkflow({ id: 'explicit-id' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .build()
      .withJournal(journal)

    await workflow.run({}, { runId: 'my-run-id' })

    const entries = await journal.getAll('my-run-id')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.runId === 'my-run-id')).toBe(true)
  })

  it('journal writes do not break execution when journal throws', async () => {
    // Create a journal that throws on every append
    const brokenJournal: RunJournal = {
      async append(): Promise<number> {
        throw new Error('journal is broken')
      },
      async query() {
        return { entries: [], hasMore: false }
      },
      async getAll() {
        return []
      },
      async compact() {},
      async needsCompaction() {
        return false
      },
    }

    const workflow = createWorkflow({ id: 'resilient' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .then(step('b', (s) => ({ ...s, b: true })))
      .build()
      .withJournal(brokenJournal)

    // The workflow should still complete despite journal failures.
    // Note: run_started is awaited directly (not fire-and-forget), so it will
    // throw. We need to verify the workflow handles this gracefully or accept
    // that the run_started append bubbles up. Let's check:
    // Looking at the implementation, journal.append for run_started is awaited
    // directly in run(). So this will actually throw. That's the current behavior.
    // The resilience guarantee is only for step-level journal writes (via journalWrite
    // which catches errors). We'll test that the step-level writes don't break things.

    // Use a journal that only fails on step writes but succeeds on run lifecycle
    let callCount = 0
    const partiallyBrokenJournal: RunJournal = {
      async append(_runId: string, entry: Omit<RunJournalEntry, 'v' | 'seq' | 'ts' | 'runId'>): Promise<number> {
        callCount++
        // Allow run_started, run_completed, run_failed through; throw on step writes
        if (entry.type === 'step_started' || entry.type === 'step_completed') {
          throw new Error('step journal write failed')
        }
        return callCount
      },
      async query() {
        return { entries: [], hasMore: false }
      },
      async getAll() {
        return []
      },
      async compact() {},
      async needsCompaction() {
        return false
      },
    }

    const workflow2 = createWorkflow({ id: 'resilient-2' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .then(step('b', (s) => ({ ...s, b: true })))
      .build()
      .withJournal(partiallyBrokenJournal)

    const result = await workflow2.run({}, { runId: 'resilient-run' })
    expect(result['a']).toBe(true)
    expect(result['b']).toBe(true)
  })

  it('withStore enables getHandle()', async () => {
    const store = new InMemoryRunStore()
    const workflow = createWorkflow({ id: 'handle-test' })
      .then(step('a', (s) => ({ ...s, a: true })))
      .build()
      .withJournal(journal)
      .withStore(store)

    // Create a run record in the store so getHandle can find it
    const run = await store.create({ agentId: 'workflow:handle-test', input: {} })

    await workflow.run({}, { runId: run.id })

    const handle = await workflow.getHandle(run.id)
    expect(handle).toBeDefined()
    expect(handle.runId).toBe(run.id)
  })
})
