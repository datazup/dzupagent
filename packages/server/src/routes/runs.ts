/**
 * Run management routes.
 *
 * POST /api/runs                — Trigger a new run
 * GET  /api/runs                — List runs (filter by agent, status)
 * GET  /api/runs/:id            — Get run details
 * POST /api/runs/:id/cancel     — Cancel a running execution
 * POST /api/runs/:id/pause      — Cooperatively pause a running execution
 * POST /api/runs/:id/resume     — Resume a paused/suspended execution
 * POST /api/runs/:id/fork       — Fork a run from a checkpoint step
 * GET  /api/runs/:id/checkpoints — List available checkpoints for a run
 * GET  /api/runs/:id/logs       — Get run logs
 * GET  /api/runs/:id/trace      — Execution trace with events + usage summary
 * GET  /api/runs/:id/stream     — SSE stream of run events
 *
 * This file defines one Hono sub-app produced by {@link createRunRoutes}. The
 * factory is deliberately thin — every endpoint is backed by a named handler
 * function exported below. Keeping handlers out of the factory closure makes
 * them unit-testable in isolation and the registration block trivial to scan.
 *
 * Owner scoping (RF-S02): when a run has a non-null `ownerId` and the caller
 * presents a different `apiKey.id`, read/write handlers return 404 as if the
 * run did not exist. The NOT_FOUND shape prevents leaking existence of other
 * tenants' runs via status code probing.
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ForgeServerConfig } from '../app.js'
import type { Run, RunStatus, LogEntry, RunJournalEntry } from '@dzupagent/core'
import { injectTraceContext } from '@dzupagent/core'
import {
  ConcreteRunHandle,
  ForkLimitExceededError,
  CheckpointExpiredError,
  InvalidRunStateError,
  StreamingRunHandle,
} from '@dzupagent/agent'
import { streamRunHandleToSSE } from '../streaming/sse-streaming-adapter.js'
import { RunCreateSchema, parseIntBounded, validateBodyCompat } from './schemas.js'

// ---------------------------------------------------------------------------
// Owner-scope helpers
// ---------------------------------------------------------------------------

/**
 * Extract the current API key's id from the Hono context (set by the auth
 * middleware). Returns undefined when auth is disabled or the context variable
 * is absent.
 */
function getRequestingKeyId(c: Context): string | undefined {
  // `apiKey` is set by the auth middleware as `Record<string, unknown>`;
  // the runtime may or may not carry an `id` field depending on the
  // configured validateKey callback.
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const id = key?.['id']
  return typeof id === 'string' ? id : undefined
}

/**
 * MC-S01 / MC-S02: Extract the authenticated API key's tenant scope from the
 * Hono context. Prefers `tenantId`, falls back to `ownerId`, then `id`, and
 * finally `'default'` when auth is disabled entirely. Using this helper keeps
 * quota accounting and tenant-isolation filters aligned on the same key.
 */
function getRequestingTenantId(c: Context): string {
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const tenantId = key?.['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
  const ownerId = key?.['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
  const id = key?.['id']
  if (typeof id === 'string' && id.length > 0) return id
  return 'default'
}

/**
 * Enforce owner scoping on a run fetched from the store. Returns the run on
 * success, or a 404 Response when the caller's API key differs from the run's
 * recorded `ownerId`. Runs without an `ownerId` (pre-migration) are always
 * visible — we do not retroactively lock them out.
 */
function enforceOwnerAccess(c: Context, run: Run): Run | Response {
  const requestingKeyId = getRequestingKeyId(c)
  if (run.ownerId && requestingKeyId && run.ownerId !== requestingKeyId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }

  // MC-S02: tenant isolation — reject cross-tenant reads even when the
  // legacy owner check would otherwise allow them through. Runs with no
  // recorded tenant (pre-migration) are treated as 'default'. We only
  // gate when the caller is authenticated; unauth'd callers fall through
  // to preserve the library default.
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  if (key) {
    const requestingTenantId = getRequestingTenantId(c)
    const runTenantId = (run.tenantId ?? 'default') || 'default'
    if (runTenantId !== requestingTenantId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
  }

  return run
}

/**
 * Fetch a run by id, returning a 404 response when missing. This collapses
 * the `get + null-check` dance that every handler used to repeat.
 */
async function loadRunOr404(
  c: Context,
  config: ForgeServerConfig,
): Promise<Run | Response> {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }
  const run = await config.runStore.get(id)
  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
  }
  return run
}

/** Combined load + owner-check used by nearly every `/:id/*` handler. */
async function loadOwnedRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Run | Response> {
  const run = await loadRunOr404(c, config)
  if (run instanceof Response) return run
  return enforceOwnerAccess(c, run)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /api/runs — create a new run and optionally enqueue it. */
export async function handleCreateRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus, executableAgentResolver } = config

  const parsed = await validateBodyCompat(c, RunCreateSchema)
  if (parsed instanceof Response) return parsed
  const body = parsed

  // Guard against oversized metadata payloads before any database writes.
  // 64 KB is ample for routing hints, trace context, and user tags while
  // keeping rogue clients from bloating the run record.
  if (body.metadata && JSON.stringify(body.metadata).length > 65_536) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'metadata too large (max 64 KB)' } },
      400,
    )
  }

  const agent = executableAgentResolver
    ? await executableAgentResolver.resolve(body.agentId)
    : await config.agentStore.get(body.agentId)
  if (!agent) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  // MC-S01: Enforce the per-key hourly token budget before accepting the
  // run. The API key record carries both a per-run cap (`maxTokensPerRun`)
  // and an hourly ceiling (`maxRunsPerHour`, expressed in tokens). We use
  // the per-run cap as the estimate so rejection happens up-front if the
  // caller would blow through their budget. When no quota manager is
  // configured this block is a no-op — preserving the library default.
  //
  // We also project `guardrails.maxTokens` onto the run metadata so the
  // executor enforces the same cap. When the caller already supplied a
  // tighter limit we keep theirs (the smaller of the two).
  const apiKey = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const rawPerRunCap = apiKey?.['maxTokensPerRun']
  const perRunCap = typeof rawPerRunCap === 'number' && Number.isFinite(rawPerRunCap) && rawPerRunCap > 0
    ? Math.floor(rawPerRunCap)
    : null
  const rawHourlyLimit = apiKey?.['maxRunsPerHour']
  const hourlyLimit = typeof rawHourlyLimit === 'number' && Number.isFinite(rawHourlyLimit) && rawHourlyLimit > 0
    ? Math.floor(rawHourlyLimit)
    : null

  if (config.resourceQuota) {
    const keyId = getRequestingKeyId(c) ?? getRequestingTenantId(c)
    const estimate = perRunCap ?? 0
    const decision = config.resourceQuota.checkQuota(keyId, estimate, hourlyLimit)
    if (!decision.allowed) {
      return c.json(
        {
          error: {
            code: 'QUOTA_EXCEEDED',
            message: decision.reason ?? 'Token quota exceeded',
          },
        },
        429,
      )
    }
  }

  // --- Cost-aware routing: classify input to determine optimal model tier ---
  let routingMetadata: Record<string, unknown> = {}
  if (config.router) {
    const inputObj = body.input as Record<string, unknown> | null | undefined
    const text = typeof body.input === 'string'
      ? body.input
      : (inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj))
        ? (typeof inputObj['message'] === 'string' ? inputObj['message']
          : typeof inputObj['content'] === 'string' ? inputObj['content']
          : typeof inputObj['prompt'] === 'string' ? inputObj['prompt']
          : JSON.stringify(body.input))
        : JSON.stringify(body.input ?? '')

    try {
      const result = await config.router.classify(text)
      routingMetadata = {
        modelTier: result.modelTier,
        routingReason: result.routingReason,
        complexity: result.complexity,
      }

      // Track routing decision distribution
      config.metrics?.increment('forge_routing_total', {
        tier: result.modelTier,
        reason: result.routingReason,
        complexity: result.complexity,
      })
    } catch {
      // Router failure is non-fatal — fall through without routing metadata
    }
  }

  const mergedMetadata: Record<string, unknown> = { ...(body.metadata ?? {}), ...routingMetadata }

  // MC-S01: project the per-key `maxTokensPerRun` onto `guardrails.maxTokens`
  // so the executor enforces the same ceiling that the quota admission
  // check used. Keep the caller's value when it is tighter — never
  // upgrade a caller-specified cap to the key's (looser) ceiling.
  if (perRunCap !== null) {
    const existingGuardrails = (mergedMetadata['guardrails'] && typeof mergedMetadata['guardrails'] === 'object')
      ? (mergedMetadata['guardrails'] as Record<string, unknown>)
      : {}
    const existingMax = typeof existingGuardrails['maxTokens'] === 'number'
      ? (existingGuardrails['maxTokens'] as number)
      : undefined
    const finalMax = typeof existingMax === 'number'
      ? Math.min(existingMax, perRunCap)
      : perRunCap
    mergedMetadata['guardrails'] = { ...existingGuardrails, maxTokens: finalMax }
  }

  // Inject trace context so every run has a traceId from birth.
  // injectTraceContext is idempotent — if metadata already has _trace, it's preserved.
  let tracedMetadata: Record<string, unknown>
  try {
    tracedMetadata = injectTraceContext(mergedMetadata)
  } catch {
    // Trace injection is non-fatal — proceed without it
    tracedMetadata = mergedMetadata
  }

  // RF-S02: stamp the owning API key on creation so downstream handlers can
  // reject cross-key access. When auth is disabled, ownerId is null and
  // every caller is allowed through — preserving the library default.
  const ownerId = getRequestingKeyId(c) ?? null

  // MC-S02: carry the tenant scope from the authenticated key so list
  // queries can isolate runs between tenants.
  const tenantId = getRequestingTenantId(c)

  const run = await runStore.create({
    agentId: body.agentId,
    input: body.input,
    metadata: tracedMetadata,
    ownerId,
    tenantId,
  })

  if (config.runQueue) {
    if (!config.runExecutor) {
      return c.json({
        error: {
          code: 'RUN_EXECUTOR_NOT_CONFIGURED',
          message: 'runQueue is configured but no runExecutor is available',
        },
      }, 503)
    }

    const metadata = body.metadata ?? {}
    const priorityRaw = typeof metadata['priority'] === 'number' ? metadata['priority'] : 5
    const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.floor(priorityRaw)) : 5

    const job = await config.runQueue.enqueue({
      runId: run.id,
      agentId: run.agentId,
      input: run.input,
      metadata: run.metadata,
      priority,
    })

    await runStore.addLog(run.id, {
      level: 'info',
      phase: 'queue',
      message: 'Run enqueued',
      data: { jobId: job.id, priority },
    })

    return c.json({ data: run, queue: { accepted: true, jobId: job.id, priority } }, 202)
  }

  eventBus.emit({ type: 'agent:started', agentId: run.agentId, runId: run.id })

  return c.json({ data: run }, 201)
}

/** GET /api/runs — paginated list with owner-scoped filter. */
export async function handleListRuns(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore } = config
  const agentId = c.req.query('agentId')
  const status = c.req.query('status') as RunStatus | undefined
  // Bounded parsing: malformed query params fall back to defaults instead
  // of blowing up the handler, and hard caps stop rogue clients from
  // requesting unbounded scans.
  const limit = parseIntBounded(c.req.query('limit'), 50, 1, 100)
  const offset = parseIntBounded(c.req.query('offset'), 0, 0, 1_000_000)

  // MC-S02: restrict listings to the authenticated key's tenant scope.
  // When auth is disabled the apiKey context is absent and `listFilter`
  // omits `tenantId`, preserving the library default that returns all
  // runs regardless of tenant.
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  const requestingTenantId = key ? getRequestingTenantId(c) : undefined

  const listFilter = {
    agentId: agentId ?? undefined,
    status: status ?? undefined,
    limit,
    offset,
    ...(requestingTenantId ? { tenantId: requestingTenantId } : {}),
  }

  const runs = await runStore.list(listFilter)

  // RF-S02: filter results to the requesting API key's runs. Runs with no
  // recorded ownerId (pre-migration rows) stay visible so legacy data does
  // not disappear after the schema change.
  const requestingKeyId = getRequestingKeyId(c)
  const visible = requestingKeyId
    ? runs.filter(r => !r.ownerId || r.ownerId === requestingKeyId)
    : runs

  // `total` reflects the full match count ignoring pagination, so UIs can
  // render accurate pagination controls. Falls back to `runs.length` for
  // stores that don't implement the optional `count()` method.
  //
  // Note: when the store lacks ownerId filter support (current interface
  // shape), the `total` intentionally matches the un-filtered count; the
  // per-row owner filter above keeps the returned data scoped correctly.
  const total = typeof runStore.count === 'function'
    ? await runStore.count({
        ...(agentId !== undefined ? { agentId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(requestingTenantId ? { tenantId: requestingTenantId } : {}),
      })
    : visible.length

  return c.json({ data: visible, count: visible.length, total })
}

/** GET /api/runs/:id — fetch a single owned run. */
export async function handleGetRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  return c.json({ data: run })
}

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

  return c.json({ data: { ...run, status: 'cancelled' } })
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
      ...(run.metadata ?? {}),
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

/** GET /api/runs/:id/checkpoints — enumerate journal checkpoints. */
export async function handleListCheckpoints(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const id = c.req.param('id') ?? ''

  if (!config.journal) {
    return c.json({
      error: { code: 'NOT_CONFIGURED', message: 'Journal is not configured; checkpoints are unavailable' },
    }, 501)
  }

  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  try {
    const handle = await ConcreteRunHandle.fromRunId(id, config.journal)
    const checkpoints = await handle.getCheckpoints()
    return c.json({ data: { runId: id, checkpoints } })
  } catch {
    // fromRunId may throw if journal has no entries — treat as empty checkpoints
    return c.json({ data: { runId: id, checkpoints: [] } })
  }
}

/** GET /api/runs/:id/logs — structured run logs. */
export async function handleGetLogs(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  const logs = await config.runStore.getLogs(run.id)
  return c.json({ data: logs })
}

/** GET /api/runs/:id/trace — aggregated trace + usage summary. */
export async function handleGetTrace(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore } = config
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  const logs = await runStore.getLogs(run.id)

  // If a traceStore is configured, include its structured step-by-step trace
  // (awaited to support both sync InMemory and async Drizzle implementations).
  const structuredTrace = config.traceStore
    ? await config.traceStore.getTrace(run.id)
    : null

  // Build usage summary
  const usage = {
    tokenUsage: run.tokenUsage ?? { input: 0, output: 0 },
    costCents: run.costCents ?? 0,
    durationMs: run.completedAt && run.startedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
      : undefined,
  }

  // Extract tool calls and phases from logs
  const toolCalls = logs
    .filter((l: LogEntry) => l.phase === 'tool_call' || (l.data != null && typeof l.data === 'object' && 'toolName' in (l.data as Record<string, unknown>)))
    .map((l: LogEntry) => ({
      message: l.message,
      data: l.data,
      timestamp: l.timestamp,
    }))

  const phases = logs
    .filter((l: LogEntry) => l.phase != null)
    .map((l: LogEntry) => l.phase!)
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)

  return c.json({
    data: {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      phases,
      events: logs,
      toolCalls,
      usage,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      ...(structuredTrace
        ? {
            trace: {
              steps: structuredTrace.steps,
              totalSteps: structuredTrace.totalSteps,
              startedAt: structuredTrace.startedAt,
              completedAt: structuredTrace.completedAt,
            },
          }
        : {}),
    },
  })
}

/**
 * GET /api/runs/:id/stream — SSE event stream.
 *
 * Uses StreamingRunHandle as the bridge between DzupEventBus events and Hono
 * SSE transport. Bus events for this run are mapped to StreamEvent objects
 * and pushed into the handle; the adapter pipes them to the SSE response. On
 * client disconnect the handle is cancelled, which stops the bus subscription.
 */
export async function handleStreamRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus } = config
  const runId = c.req.param('id') ?? ''
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  return streamSSE(c, async (stream) => {
    const handle = new StreamingRunHandle({ maxBufferSize: 100 })

    // Emit a `run:memory-frame` SSE event directly if the current run has a
    // memoryFrame snapshot stored on its metadata. Written directly to the
    // SSE stream (bypassing StreamingRunHandle) so we can extend the event
    // vocabulary without widening the closed StreamEvent union. Must be
    // awaited BEFORE the `done` event is pushed so the memory frame arrives
    // on the wire first.
    const maybeEmitMemoryFrame = async (): Promise<void> => {
      try {
        const latest = await runStore.get(runId)
        const memoryFrame = latest?.metadata != null
          && typeof latest.metadata === 'object'
          ? (latest.metadata as Record<string, unknown>)['memoryFrame']
          : undefined
        if (memoryFrame === undefined) return
        await stream.writeSSE({
          event: 'run:memory-frame',
          data: JSON.stringify({ runId, memoryFrame }),
        })
      } catch {
        // Non-fatal — memory frame emission is best-effort observability
      }
    }

    // Subscribe to bus events for this run and push into the handle
    const unsub = eventBus.onAny((event) => {
      if (handle.status !== 'running') return

      const eventRunId = 'runId' in event ? (event as { runId: string }).runId : undefined
      if (eventRunId !== runId) return

      // Map bus event types to StreamEvent types
      switch (event.type) {
        case 'agent:stream_delta': {
          handle.push({ type: 'text_delta', content: event.content })
          break
        }
        case 'tool:called': {
          const toolEvent = event as { toolName: string; callId?: string }
          handle.push({
            type: 'tool_call_start',
            toolName: toolEvent.toolName,
            callId: toolEvent.callId ?? '',
          })
          break
        }
        case 'tool:result': {
          const resultEvent = event as { callId?: string; result?: unknown }
          handle.push({
            type: 'tool_call_end',
            callId: resultEvent.callId ?? '',
            result: resultEvent.result,
          })
          break
        }
        case 'agent:stream_done': {
          const finalOutput = event.finalContent
          void (async () => {
            await maybeEmitMemoryFrame()
            if (handle.status !== 'running') return
            handle.push({ type: 'done', finalOutput })
            handle.complete()
          })()
          break
        }
        case 'agent:completed': {
          const completedEvent = event as { output?: string }
          const finalOutput = typeof completedEvent.output === 'string' ? completedEvent.output : ''
          void (async () => {
            await maybeEmitMemoryFrame()
            if (handle.status !== 'running') return
            handle.push({ type: 'done', finalOutput })
            handle.complete()
          })()
          break
        }
        case 'agent:failed': {
          handle.fail(new Error(event.message ?? event.errorCode ?? 'Run failed'))
          break
        }
        default:
          // Other run events (paused, resumed, cancelled) do not map
          // to StreamEvent types — they are handled by the polling check.
          break
      }
    })

    // Send initial state before piping the handle
    await stream.writeSSE({ data: JSON.stringify({ status: run.status }), event: 'init' })

    // Poll for completion of runs that may have finished before we subscribed
    const checkInterval = setInterval(() => { void (async () => {
      if (handle.status !== 'running') { clearInterval(checkInterval); return }
      const current = await runStore.get(runId)
      if (!current || ['completed', 'failed', 'cancelled', 'rejected', 'halted'].includes(current.status)) {
        if (handle.status === 'running') {
          await maybeEmitMemoryFrame()
          if (handle.status === 'running') {
            handle.push({ type: 'done', finalOutput: '' })
            handle.complete()
          }
        }
        clearInterval(checkInterval)
      }
    })() }, 2000)

    // Pipe handle events to SSE; adapter handles onAbort → handle.cancel()
    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: Number(process.env['SSE_KEEPALIVE_INTERVAL_MS'] ?? 30_000),
      runTimeoutMs: Number(process.env['RUN_TIMEOUT_MS'] ?? 0),
      onError: (e) => {
        console.error('SSE write error', e)
        clearInterval(checkInterval)
        unsub()
      },
    })

    // Cleanup when the stream ends (normal completion or abort)
    clearInterval(checkInterval)
    unsub()
  })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Register all run routes on a new Hono sub-app. Each endpoint delegates to a
 * named handler above — the factory itself carries no business logic beyond
 * wiring.
 */
export function createRunRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  app.post('/', (c) => handleCreateRun(c, config))
  app.get('/', (c) => handleListRuns(c, config))
  app.get('/:id', (c) => handleGetRun(c, config))
  app.post('/:id/cancel', (c) => handleCancelRun(c, config))
  app.post('/:id/pause', (c) => handlePauseRun(c, config))
  app.post('/:id/resume', (c) => handleResumeRun(c, config))
  app.post('/:id/fork', (c) => handleForkRun(c, config))
  app.get('/:id/checkpoints', (c) => handleListCheckpoints(c, config))
  app.get('/:id/logs', (c) => handleGetLogs(c, config))
  app.get('/:id/trace', (c) => handleGetTrace(c, config))
  app.get('/:id/stream', (c) => handleStreamRun(c, config))
  return app
}
