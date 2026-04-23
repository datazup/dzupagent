/**
 * T4 — R1 Resume Semantics integration tests.
 *
 * Validates the journal-backed resume path:
 *   - Rehydrates a run from RunJournal entries.
 *   - Replays the last `step_completed` checkpoint to the client.
 *   - Re-enqueues the run via runQueue when configured so the executor can
 *     continue from the checkpoint.
 *   - Emits `run:resumed` with the resumed checkpoint attached to `input`.
 *   - Appends a `run_resumed` journal entry with idempotent resumeToken
 *     semantics (duplicate POSTs do not double-write).
 *   - Falls back to the legacy behavior when no journal is configured
 *     (backward compatibility).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  InMemoryRunJournal,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { RunJournal, DzupEvent } from '@dzupagent/core'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import type { RunExecutor } from '../runtime/run-worker.js'

interface TestHarness {
  config: ForgeServerConfig
  app: ReturnType<typeof createForgeApp>
  journal: RunJournal
  events: DzupEvent[]
}

function createHarness(options: { withJournal?: boolean; withQueue?: boolean } = {}): TestHarness {
  const journal = new InMemoryRunJournal()
  const eventBus = createEventBus()
  const events: DzupEvent[] = []
  eventBus.onAny((e) => { events.push(e) })

  const noopExecutor: RunExecutor = async () => ({
    output: 'ok',
    tokenUsage: { input: 0, output: 0 },
    costCents: 0,
  })

  const config: ForgeServerConfig = {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus,
    modelRegistry: new ModelRegistry(),
    ...(options.withJournal !== false ? { journal } : {}),
    ...(options.withQueue ? { runQueue: new InMemoryRunQueue(), runExecutor: noopExecutor } : {}),
  }

  const app = createForgeApp(config)
  return { config, app, journal, events }
}

async function post(
  app: ReturnType<typeof createForgeApp>,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init)
}

/**
 * Seed a run that has reached a mid-tool-loop checkpoint: one
 * step_completed entry + a state_updated entry, then paused.
 */
async function seedPausedRunWithCheckpoint(
  harness: TestHarness,
  opts: { agentId: string; runInput: unknown } = { agentId: 'agent-1', runInput: 'task' },
): Promise<{ runId: string; checkpointStepId: string; stateSeq: number }> {
  await harness.config.agentStore.save({
    id: opts.agentId,
    name: 'Test Agent',
    instructions: 'test',
    modelTier: 'chat',
  })

  const run = await harness.config.runStore.create({
    agentId: opts.agentId,
    input: opts.runInput,
    metadata: { priority: 3 },
  })

  // Simulate a mid-flight execution that produced one completed step
  // and a business-state snapshot before pausing.
  await harness.journal.append(run.id, {
    type: 'run_started',
    data: { input: opts.runInput, agentId: opts.agentId },
  })
  const stepSeq = await harness.journal.append(run.id, {
    type: 'step_completed',
    data: { stepId: 'step-1', toolName: 'search', output: { hits: 3 } },
  })
  const stateSeq = await harness.journal.append(run.id, {
    type: 'state_updated',
    data: { state: { messages: [{ role: 'assistant', content: 'partial' }] } },
  })
  await harness.journal.append(run.id, {
    type: 'run_paused',
    data: { reason: 'user_request' },
  })

  await harness.config.runStore.update(run.id, { status: 'paused' })

  return { runId: run.id, checkpointStepId: 'step-1', stateSeq }
}

describe('Resume semantics — journal rehydration (T4 / R1)', () => {
  let harness: TestHarness

  beforeEach(() => {
    harness = createHarness({ withJournal: true })
  })

  afterEach(async () => {
    // Drain queue if present
    await harness.config.runQueue?.stop(false)
  })

  it('rehydrates run state and returns the latest checkpoint', async () => {
    const { runId, checkpointStepId } = await seedPausedRunWithCheckpoint(harness)

    const res = await post(harness.app, `/api/runs/${runId}/resume`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        runId: string
        status: 'running'
        checkpoint?: { stepId: string; stepSeq: number; toolName?: string; completedAt: string }
        lastStateSeq?: number
      }
    }
    expect(body.data.status).toBe('running')
    expect(body.data.runId).toBe(runId)
    expect(body.data.checkpoint).toBeDefined()
    expect(body.data.checkpoint!.stepId).toBe(checkpointStepId)
    expect(body.data.checkpoint!.toolName).toBe('search')
    expect(typeof body.data.checkpoint!.stepSeq).toBe('number')
    expect(typeof body.data.lastStateSeq).toBe('number')

    // Run store reflects the new status
    const updated = await harness.config.runStore.get(runId)
    expect(updated!.status).toBe('running')
  })

  it('appends a run_resumed journal entry with the resumeToken', async () => {
    const { runId } = await seedPausedRunWithCheckpoint(harness)

    const res = await post(harness.app, `/api/runs/${runId}/resume`, {
      resumeToken: 'tok-42',
      input: { continuation: 'keep going' },
    })
    expect(res.status).toBe(200)

    const entries = await harness.journal.getAll(runId)
    const resumed = entries.filter((e) => e.type === 'run_resumed')
    expect(resumed).toHaveLength(1)
    const data = resumed[0]!.data as { resumeToken: string; input?: unknown }
    expect(data.resumeToken).toBe('tok-42')
    expect(data.input).toEqual({ continuation: 'keep going' })
  })

  it('is idempotent on repeated resumeToken — only one run_resumed entry is written', async () => {
    const { runId } = await seedPausedRunWithCheckpoint(harness)

    const res1 = await post(harness.app, `/api/runs/${runId}/resume`, { resumeToken: 'tok-dup' })
    expect(res1.status).toBe(200)

    // Simulate the run cycling back to paused (e.g. executor saw a
    // cooperative-pause signal mid-tool-loop). The journal now has a
    // pre-existing `run_resumed` entry for tok-dup AND a later
    // `run_paused` entry — so a second resume with the same token
    // should be a silent no-op inside `ConcreteRunHandle.resume()`.
    await harness.journal.append(runId, {
      type: 'run_paused',
      data: { reason: 'user_request' },
    })
    await harness.config.runStore.update(runId, { status: 'paused' })

    const res2 = await post(harness.app, `/api/runs/${runId}/resume`, { resumeToken: 'tok-dup' })
    expect(res2.status).toBe(200)

    const resumedEntries = (await harness.journal.getAll(runId)).filter(
      (e) => e.type === 'run_resumed',
    )
    expect(resumedEntries).toHaveLength(1)
    expect((resumedEntries[0]!.data as { resumeToken: string }).resumeToken).toBe('tok-dup')
  })

  it('emits run:resumed with checkpoint attached to input payload when no explicit input is supplied', async () => {
    const { runId, checkpointStepId } = await seedPausedRunWithCheckpoint(harness)

    await post(harness.app, `/api/runs/${runId}/resume`)

    const resumedEvent = harness.events.find((e) => e.type === 'run:resumed') as
      | { type: 'run:resumed'; runId: string; agentId: string; resumeToken?: string; input?: unknown }
      | undefined
    expect(resumedEvent).toBeDefined()
    expect(resumedEvent!.runId).toBe(runId)

    const payload = resumedEvent!.input as {
      _resumeCheckpoint?: { stepId: string }
      _lastStateSeq?: number
    }
    expect(payload._resumeCheckpoint).toBeDefined()
    expect(payload._resumeCheckpoint!.stepId).toBe(checkpointStepId)
    expect(typeof payload._lastStateSeq).toBe('number')
  })

  it('forwards explicit input verbatim without the _resumeCheckpoint wrapper', async () => {
    const { runId } = await seedPausedRunWithCheckpoint(harness)

    await post(harness.app, `/api/runs/${runId}/resume`, { input: { userSays: 'continue' } })

    const resumedEvent = harness.events.find((e) => e.type === 'run:resumed') as
      | { type: 'run:resumed'; input?: unknown }
      | undefined
    expect(resumedEvent).toBeDefined()
    expect(resumedEvent!.input).toEqual({ userSays: 'continue' })
  })

  it('re-enqueues via runQueue with checkpoint metadata when queue is configured', async () => {
    harness = createHarness({ withJournal: true, withQueue: true })
    const { runId, checkpointStepId } = await seedPausedRunWithCheckpoint(harness)

    // Stop the worker so we can inspect the enqueued job before it is
    // drained by the worker loop.
    await harness.config.runQueue?.stop(false)

    const res = await post(harness.app, `/api/runs/${runId}/resume`, {
      input: { continuation: 'go' },
      resumeToken: 'tok-queue',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        status: 'running'
        queue?: { accepted: boolean; jobId: string; priority: number }
      }
    }
    expect(body.data.queue?.accepted).toBe(true)
    expect(body.data.queue?.priority).toBe(3)

    // Inspect the queue: either the job is still pending (worker stopped)
    // or it was processed; either way its metadata captured the resume
    // envelope.
    const stats = harness.config.runQueue!.stats()
    expect(stats.pending + stats.completed + stats.active).toBeGreaterThanOrEqual(1)

    // The checkpoint is exposed on the HTTP response too.
    const bodyWithCheckpoint = body as unknown as {
      data: { checkpoint?: { stepId: string } }
    }
    expect(bodyWithCheckpoint.data.checkpoint?.stepId).toBe(checkpointStepId)
  })

  it('writes a structured resume log entry describing the checkpoint', async () => {
    const { runId, checkpointStepId } = await seedPausedRunWithCheckpoint(harness)

    await post(harness.app, `/api/runs/${runId}/resume`, { resumeToken: 'tok-log' })

    const logs = await harness.config.runStore.getLogs(runId)
    const resumeLog = logs.find((l) => l.phase === 'resume')
    expect(resumeLog).toBeDefined()
    expect(resumeLog!.message).toContain(checkpointStepId)
    const data = resumeLog!.data as {
      resumeToken?: string
      checkpoint?: { stepId: string }
    }
    expect(data.resumeToken).toBe('tok-log')
    expect(data.checkpoint?.stepId).toBe(checkpointStepId)
  })
})

describe('Resume semantics — legacy fallback (no journal)', () => {
  it('transitions status to running and emits run:resumed when journal is absent', async () => {
    const harness = createHarness({ withJournal: false })
    await harness.config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const run = await harness.config.runStore.create({
      agentId: 'agent-1',
      input: 'task',
    })
    await harness.config.runStore.update(run.id, { status: 'paused' })

    const res = await post(harness.app, `/api/runs/${run.id}/resume`, {
      resumeToken: 'tok-legacy',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { status: string; checkpoint?: unknown } }
    expect(body.data.status).toBe('running')
    // No checkpoint — journal wasn't configured.
    expect(body.data.checkpoint).toBeUndefined()

    const resumedEvent = harness.events.find((e) => e.type === 'run:resumed') as
      | { type: 'run:resumed'; resumeToken?: string }
      | undefined
    expect(resumedEvent).toBeDefined()
    expect(resumedEvent!.resumeToken).toBe('tok-legacy')
  })
})
