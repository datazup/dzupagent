/**
 * Session Q: formal 'halted' RunStatus variant.
 *
 * Prior to Session Q, a clean executor halt (e.g. token exhaustion surfaced by
 * `run:halted:token-exhausted`) was recorded as status='completed' with a
 * `halted:true` flag in run metadata. Session Q adds 'halted' to the
 * RunStatus union in @dzupagent/core, teaches the run-worker to set
 * status='halted' when the executor reports the halt flag, and updates the
 * REST cancel endpoint to treat 'halted' as terminal.
 *
 * Coverage:
 *   1. run-worker sets status='halted' when executor result.metadata.halted=true
 *   2. run-worker preserves metadata.halted=true for backward compatibility
 *   3. run-worker still uses 'completed' for regular successful runs
 *   4. GET /api/runs/:id returns status='halted' through the RunStatus-typed layer
 *   5. POST /api/runs/:id/cancel rejects 'halted' runs as terminal
 *   6. Migration SQL contains the required backfill + index statements
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type RunStatus,
} from '@dzupagent/core'
import { waitForCondition } from '@dzupagent/test-utils'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import { createForgeApp, type ForgeServerConfig } from '../app.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function waitForRunStatus(
  store: InMemoryRunStore,
  runId: string,
  terminal: readonly RunStatus[] = ['completed', 'halted', 'failed', 'rejected', 'cancelled'],
  timeoutMs = 3000,
): Promise<RunStatus> {
  let observed: RunStatus | undefined
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      if (run && terminal.includes(run.status)) {
        observed = run.status
        return true
      }
      return false
    },
    { timeoutMs, intervalMs: 20, description: `waiting for terminal status on ${runId}` },
  )
  return observed!
}

describe('Session Q — RunStatus.halted', () => {
  // -------------------------------------------------------------------------
  // 1. run-worker maps metadata.halted=true to status='halted'
  // -------------------------------------------------------------------------

  it('run-worker sets status="halted" when executor metadata reports halted:true', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'halt-agent',
      name: 'Halt Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { message: 'partial output before halt' },
        metadata: {
          halted: true,
          haltReason: 'token_exhausted',
          haltIterations: 3,
        },
      }),
    })

    const run = await runStore.create({ agentId: 'halt-agent', input: { message: 'hi' } })
    await runQueue.enqueue({ runId: run.id, agentId: 'halt-agent', input: { message: 'hi' }, priority: 1 })

    const status = await waitForRunStatus(runStore, run.id)
    expect(status).toBe('halted')

    const finalRun = await runStore.get(run.id)
    // Metadata flag is preserved for backward compatibility with pre-Session-Q
    // readers (e.g. the /runs/:id/context endpoint that still inspects the flag).
    expect(finalRun?.metadata?.['halted']).toBe(true)
    expect(finalRun?.metadata?.['haltReason']).toBe('token_exhausted')
    expect(finalRun?.completedAt).toBeInstanceOf(Date)

    await runQueue.stop(false)
  })

  // -------------------------------------------------------------------------
  // 2. Regular completions remain status='completed'
  // -------------------------------------------------------------------------

  it('run-worker still uses status="completed" for regular runs without halted metadata', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'ok-agent',
      name: 'OK Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({
        output: { message: 'all good' },
        metadata: { streamMode: true, chunkCount: 1 },
      }),
    })

    const run = await runStore.create({ agentId: 'ok-agent', input: { message: 'hi' } })
    await runQueue.enqueue({ runId: run.id, agentId: 'ok-agent', input: { message: 'hi' }, priority: 1 })

    const status = await waitForRunStatus(runStore, run.id)
    expect(status).toBe('completed')

    const finalRun = await runStore.get(run.id)
    expect(finalRun?.metadata).not.toHaveProperty('halted')

    await runQueue.stop(false)
  })

  // -------------------------------------------------------------------------
  // 3. GET /api/runs/:id surfaces status='halted' through the typed response
  // -------------------------------------------------------------------------

  it('GET /api/runs/:id returns status="halted" for a halted run', async () => {
    const config: ForgeServerConfig = {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
    }
    await config.agentStore.save({
      id: 'api-halt-agent',
      name: 'API Halt Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const app = createForgeApp(config)

    const created = await config.runStore.create({
      agentId: 'api-halt-agent',
      input: { message: 'x' },
    })
    // Simulate Session-Q-era worker: write directly to the store.
    await config.runStore.update(created.id, {
      status: 'halted',
      output: { message: 'partial' },
      metadata: { halted: true, haltReason: 'token_exhausted' },
      completedAt: new Date(),
    })

    const res = await app.request(`/api/runs/${created.id}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { status: RunStatus; metadata?: Record<string, unknown> } }
    expect(body.data.status).toBe('halted')
    expect(body.data.metadata?.['halted']).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 4. POST /api/runs/:id/cancel rejects halted runs as terminal
  // -------------------------------------------------------------------------

  it('POST /api/runs/:id/cancel returns 400 INVALID_STATE for a halted run', async () => {
    const config: ForgeServerConfig = {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
    }
    await config.agentStore.save({
      id: 'cancel-halted-agent',
      name: 'Cancel Halted Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const app = createForgeApp(config)

    const run = await config.runStore.create({
      agentId: 'cancel-halted-agent',
      input: { message: 'x' },
    })
    await config.runStore.update(run.id, { status: 'halted', completedAt: new Date() })

    const res = await app.request(`/api/runs/${run.id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_STATE')
    expect(body.error.message).toMatch(/halted/)
  })

  // -------------------------------------------------------------------------
  // 5. Migration SQL is well-formed (backfill + index)
  // -------------------------------------------------------------------------

  it('migration 0002_run_status_halted.sql backfills completed→halted rows and adds an index', () => {
    const sqlPath = join(__dirname, '..', '..', 'drizzle', '0002_run_status_halted.sql')
    const sql = readFileSync(sqlPath, 'utf8')

    // Backfill: flip 'completed' rows that already had metadata.halted=true
    expect(sql).toMatch(/UPDATE\s+"forge_runs"/i)
    expect(sql).toMatch(/SET\s+"status"\s*=\s*'halted'/i)
    expect(sql).toMatch(/"status"\s*=\s*'completed'/i)
    expect(sql).toMatch(/metadata.*halted/i)

    // Index: enable fast status filtering now that 'halted' joins the union
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"forge_runs_status_idx"/i)
    expect(sql).toMatch(/ON\s+"forge_runs"\s*\(\s*"status"\s*\)/i)

    // Must NOT attempt a destructive column alteration — status is varchar(30)
    // and 'halted' already fits.
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+"status"/i)
    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
  })
})
