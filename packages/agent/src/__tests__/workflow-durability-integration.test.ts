/**
 * Integration tests for workflow durability: checkpoint, fork, resume, and HTTP routes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createWorkflow } from '../workflow/index.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import {
  InMemoryRunJournal,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { createForgeApp, type ForgeServerConfig } from '@dzupagent/server'

function step(
  id: string,
  fn: (state: Record<string, unknown>) => Record<string, unknown>,
): WorkflowStep {
  return { id, execute: async (input) => fn(input as Record<string, unknown>) }
}

describe('workflow durability integration', () => {
  let journal: InMemoryRunJournal
  let store: InMemoryRunStore

  beforeEach(() => {
    journal = new InMemoryRunJournal()
    store = new InMemoryRunStore()
  })

  it('checkpoint-fork roundtrip', async () => {
    const workflow = createWorkflow({ id: 'fork-test' })
      .then(step('step1', (s) => ({ ...s, step1: 'done' })))
      .then(step('step2', (s) => ({ ...s, step2: 'done' })))
      .then(step('step3', (s) => ({ ...s, step3: 'done' })))
      .build()
      .withJournal(journal)
      .withStore(store)

    // Create a store record and run
    const run = await store.create({ agentId: 'workflow:fork-test', input: {} })
    await workflow.run({}, { runId: run.id })

    // Get handle and verify checkpoints
    const handle = await workflow.getHandle(run.id)
    const checkpoints = await handle.getCheckpoints()
    expect(checkpoints.length).toBeGreaterThanOrEqual(2)

    // Fork from step2
    const step2Checkpoint = checkpoints.find((cp) => cp.stepId === 'step2')
    expect(step2Checkpoint).toBeDefined()

    const forked = await handle.fork('step2')
    expect(forked.runId).not.toBe(run.id)

    // Verify forked run has journal entries up to step2
    const forkedEntries = await journal.getAll(forked.runId)
    expect(forkedEntries.length).toBeGreaterThan(0)

    // The forked journal should include entries copied up to step2's checkpoint
    const forkedStepCompleted = forkedEntries.filter((e) => e.type === 'step_completed')
    // step1 and step2 completed entries should be copied, but not step3
    const forkedStepIds = forkedStepCompleted.map(
      (e) => (e.data as { stepId: string }).stepId,
    )
    expect(forkedStepIds).toContain('step1')
    expect(forkedStepIds).toContain('step2')
    expect(forkedStepIds).not.toContain('step3')
  })

  it('getHandle returns working handle', async () => {
    const workflow = createWorkflow({ id: 'handle-check' })
      .then(step('s1', (s) => ({ ...s, s1: true })))
      .then(step('s2', (s) => ({ ...s, s2: true })))
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:handle-check', input: {} })
    await workflow.run({}, { runId: run.id })

    const handle = await workflow.getHandle(run.id)
    expect(handle.runId).toBe(run.id)

    const checkpoints = await handle.getCheckpoints()
    expect(checkpoints.length).toBe(2)
    expect(checkpoints.map((cp) => cp.stepId)).toEqual(
      expect.arrayContaining(['s1', 's2']),
    )
  })

  it('resumeFromStep creates new run', async () => {
    const workflow = createWorkflow({ id: 'resume-test' })
      .then(step('step1', (s) => ({ ...s, step1: true })))
      .then(step('step2', (s) => ({ ...s, step2: true })))
      .then(step('step3', (s) => ({ ...s, step3: true })))
      .build()
      .withJournal(journal)
      .withStore(store)

    const run = await store.create({ agentId: 'workflow:resume-test', input: {} })
    await workflow.run({}, { runId: run.id })

    const handle = await workflow.getHandle(run.id)
    const resumed = await handle.resumeFromStep('step2')

    // The resumed handle should have a different runId
    expect(resumed.runId).not.toBe(run.id)

    // The resumed run should have journal entries
    const resumedEntries = await journal.getAll(resumed.runId)
    expect(resumedEntries.length).toBeGreaterThan(0)

    // It should include a run_resumed entry
    const resumedTypes = resumedEntries.map((e) => e.type)
    expect(resumedTypes).toContain('run_resumed')
  })

  it('fork + checkpoints server routes', async () => {
    const serverJournal = new InMemoryRunJournal()
    const serverStore = new InMemoryRunStore()

    const config: ForgeServerConfig = {
      runStore: serverStore,
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      journal: serverJournal,
    }

    // First run a workflow to populate the journal and store
    const workflow = createWorkflow({ id: 'route-test' })
      .then(step('step1', (s) => ({ ...s, step1: true })))
      .then(step('step2', (s) => ({ ...s, step2: true })))
      .build()
      .withJournal(serverJournal)

    // Create a run in the store
    const run = await serverStore.create({
      agentId: 'workflow:route-test',
      input: {},
    })
    await workflow.run({}, { runId: run.id })

    // Create the Hono app using createForgeApp (like existing server tests)
    const app = createForgeApp(config)

    // GET /api/runs/:id/checkpoints
    const checkpointsRes = await app.request(`/api/runs/${run.id}/checkpoints`)
    expect(checkpointsRes.status).toBe(200)
    const checkpointsData = await checkpointsRes.json() as {
      data: { runId: string; checkpoints: Array<{ stepId: string }> }
    }
    expect(checkpointsData.data.runId).toBe(run.id)
    expect(checkpointsData.data.checkpoints.length).toBeGreaterThanOrEqual(1)

    // POST /api/runs/:id/fork
    const forkRes = await app.request(`/api/runs/${run.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetStepId: 'step1' }),
    })
    expect(forkRes.status).toBe(201)
    const forkData = await forkRes.json() as {
      data: { originalRunId: string; forkedRunId: string }
    }
    expect(forkData.data.originalRunId).toBe(run.id)
    expect(forkData.data.forkedRunId).toBeTruthy()
    expect(forkData.data.forkedRunId).not.toBe(run.id)
  })
})
