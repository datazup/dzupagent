/**
 * Run-control handlers.
 *
 *   POST /api/runs/:id/cancel  — abort a running/queued run
 *   POST /api/runs/:id/pause   — cooperatively pause a run
 *   POST /api/runs/:id/resume  — resume a paused/suspended run
 *   POST /api/runs/:id/fork    — fork a run from a checkpoint step
 *
 * Extracted from `routes/runs.ts` (RF-22). Resume implements the journal-
 * backed rehydration path documented in the original module.
 */
import type { Context } from 'hono'
import type { RunJournalEntry } from '@dzupagent/core/persistence'
import {
  CheckpointExpiredError,
  ConcreteRunHandle,
  ForkLimitExceededError,
  InvalidRunStateError,
} from '@dzupagent/agent/runtime'

import type { ForgeServerConfig } from '../../composition/types.js'
import {
  sanitizeRunForResponse,
  sanitizeRunMetadataForPersistence,
} from '../../security/run-metadata-secrets.js'
import { loadOwnedRun } from './shared.js'

/** POST /api/runs/:id/cancel — abort a running/queued run. */
export async function handleCancelRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus } = config
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  if (
    run.status === 'completed'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'halted'
  ) {
    return c.json({ error: { code: 'INVALID_STATE', message: `Cannot cancel run in ${run.status} state` } }, 400)
  }

  // Signal the queue to abort the job (removes from pending or aborts active signal)
  config.runQueue?.cancel(run.id)

  await runStore.update(run.id, { status: 'cancelled', completedAt: new Date() })
  eventBus.emit({ type: 'agent:failed', agentId: run.agentId, runId: run.id, errorCode: 'AGENT_ABORTED', message: 'Cancelled by user' })

  return c.json({ data: sanitizeRunForResponse({ ...run, status: 'cancelled' }) })
}

/** POST /api/runs/:id/pause — cooperatively pause a run. */
export async function handlePauseRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus } = config
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  if (run.status !== 'running' && run.status !== 'executing') {
    return c.json({
      error: { code: 'INVALID_STATE', message: `Cannot pause run in '${run.status}' state` },
    }, 400)
  }

  await runStore.update(run.id, { status: 'paused' })
  eventBus.emit({ type: 'run:paused', runId: run.id, agentId: run.agentId })

  return c.json({ data: { runId: run.id, status: 'paused' as const } })
}

/**
 * POST /api/runs/:id/resume — resume a paused or suspended run.
 *
 * Resume semantics:
 *   1. If `config.journal` is configured, the handler rehydrates a
 *      ConcreteRunHandle from the journal, replays the last
 *      `step_completed` checkpoint, and (if present) the most recent
 *      `state_updated` entry. The journal handle's `resume()` appends a
 *      `run_resumed` entry with idempotent resumeToken semantics.
 *   2. If `config.runQueue` + `config.runExecutor` are configured, the
 *      run is re-enqueued with `metadata._resume` carrying the checkpoint
 *      sequence and user-supplied input so the executor can continue from
 *      the last committed step.
 *   3. When no journal is configured, the endpoint falls back to a
 *      simple status transition + event emit (original behavior), so
 *      existing deployments are unaffected.
 */
export async function handleResumeRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus } = config
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  if (run.status !== 'paused' && run.status !== 'suspended') {
    return c.json({
      error: { code: 'INVALID_STATE', message: `Cannot resume run in '${run.status}' state` },
    }, 400)
  }

  // Accept optional resumeToken and input from request body
  let resumeToken: string | undefined
  let input: unknown
  try {
    const body = await c.req.json<{ resumeToken?: string; input?: unknown }>()
    resumeToken = body.resumeToken
    input = body.input
  } catch {
    // Empty body is acceptable for resume
  }

  // --- Journal-backed rehydration path ---
  let checkpoint: {
    stepId: string
    stepSeq: number
    toolName?: string
    completedAt: string
  } | undefined
  let lastStateSeq: number | undefined

  if (config.journal) {
    try {
      const entries: RunJournalEntry[] = await config.journal.getAll(run.id)

      // Find the most recent step_completed entry — that's the checkpoint
      // from which the executor will continue its tool loop.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry && entry.type === 'step_completed') {
          const data = entry.data as { stepId: string; toolName?: string }
          checkpoint = {
            stepId: data.stepId,
            stepSeq: entry.seq,
            completedAt: entry.ts,
            ...(data.toolName !== undefined ? { toolName: data.toolName } : {}),
          }
          break
        }
      }

      // Find the most recent state_updated entry so the executor can
      // restore business state (message history, working memory, etc.).
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry && entry.type === 'state_updated') {
          lastStateSeq = entry.seq
          break
        }
      }

      // Rehydrate the RunHandle and append the run_resumed journal entry.
      // `resume()` is idempotent on resumeToken — a repeated call with
      // the same token is a silent no-op.
      const handle = await ConcreteRunHandle.fromRunId(run.id, config.journal)
      await handle.resume(input, resumeToken)
    } catch (err) {
      if (err instanceof InvalidRunStateError) {
        return c.json({
          error: { code: 'INVALID_STATE', message: err.message },
        }, 400)
      }
      // Any other journal error (e.g. run not found in journal) is
      // non-fatal — we degrade to the legacy path so callers that
      // manage state outside the journal continue to work.
    }
  }

  await runStore.update(run.id, { status: 'running' })

  // Add a structured log entry capturing the resume checkpoint so
  // /runs/:id/logs and /runs/:id/trace expose the transition.
  await runStore.addLog(run.id, {
    level: 'info',
    phase: 'resume',
    message: checkpoint
      ? `Resumed from step ${checkpoint.stepId} (seq ${checkpoint.stepSeq})`
      : 'Resumed run',
    data: {
      ...(resumeToken !== undefined ? { resumeToken } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(lastStateSeq !== undefined ? { lastStateSeq } : {}),
      ...(input !== undefined ? { hasInput: true } : {}),
    },
  })

  // Re-enqueue the run so the worker continues execution from the
  // checkpoint. Without a queue the executor cannot be re-entered
  // here; callers subscribing to `run:resumed` are expected to drive
  // continuation themselves.
  let queueAccepted: { jobId: string; priority: number } | undefined
  if (config.runQueue && config.runExecutor) {
    const priorityRaw = typeof (run.metadata ?? {})['priority'] === 'number'
      ? ((run.metadata ?? {})['priority'] as number)
      : 5
    const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.floor(priorityRaw)) : 5

    const resumedMetadata: Record<string, unknown> = {
      ...(sanitizeRunMetadataForPersistence(run.metadata ?? undefined) ?? {}),
      _resume: {
        ...(resumeToken !== undefined ? { resumeToken } : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(lastStateSeq !== undefined ? { lastStateSeq } : {}),
        ...(input !== undefined ? { input } : {}),
      },
    }

    const job = await config.runQueue.enqueue({
      runId: run.id,
      agentId: run.agentId,
      input: input ?? run.input,
      metadata: resumedMetadata,
      priority,
    })
    queueAccepted = { jobId: job.id, priority }
  }

  eventBus.emit({
    type: 'run:resumed',
    runId: run.id,
    agentId: run.agentId,
    ...(resumeToken !== undefined ? { resumeToken } : {}),
    // Carry checkpoint info on `input` so downstream subscribers (worker,
    // UI, metrics) can read the restore point without widening the event
    // type. If the caller supplied an explicit `input`, that wins.
    ...(input !== undefined
      ? { input }
      : checkpoint !== undefined
        ? { input: { _resumeCheckpoint: checkpoint, ...(lastStateSeq !== undefined ? { _lastStateSeq: lastStateSeq } : {}) } }
        : {}),
  })

  return c.json({
    data: {
      runId: run.id,
      status: 'running' as const,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(lastStateSeq !== undefined ? { lastStateSeq } : {}),
      ...(queueAccepted !== undefined ? { queue: { accepted: true, ...queueAccepted } } : {}),
    },
  })
}

/** POST /api/runs/:id/fork — fork from a checkpoint step. */
export async function handleForkRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const id = c.req.param('id') ?? ''

  if (!config.journal) {
    return c.json({
      error: { code: 'NOT_CONFIGURED', message: 'Journal is not configured; fork is unavailable' },
    }, 501)
  }

  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  let targetStepId: string | undefined
  try {
    const body = await c.req.json<{ targetStepId?: string }>()
    targetStepId = body.targetStepId
  } catch {
    // Empty body is acceptable — fork from latest checkpoint
  }

  try {
    const handle = await ConcreteRunHandle.fromRunId(id, config.journal)
    const forked = await handle.fork(targetStepId!)
    return c.json({
      data: {
        originalRunId: id,
        forkedRunId: forked.runId,
        targetStepId: targetStepId ?? null,
      },
    }, 201)
  } catch (err) {
    if (err instanceof ForkLimitExceededError) {
      return c.json({ error: { code: 'FORK_LIMIT_EXCEEDED', message: (err as Error).message } }, 409)
    }
    if (err instanceof CheckpointExpiredError) {
      return c.json({ error: { code: 'CHECKPOINT_EXPIRED', message: (err as Error).message } }, 409)
    }
    throw err
  }
}
