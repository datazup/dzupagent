/**
 * Read-only run handlers.
 *
 *   GET /api/runs                  — paginated list with owner/tenant filter
 *   GET /api/runs/:id              — fetch a single owned run
 *   GET /api/runs/:id/logs         — structured run logs
 *   GET /api/runs/:id/trace        — aggregated trace + usage summary
 *   GET /api/runs/:id/checkpoints  — enumerate journal checkpoints
 *
 * Extracted from `routes/runs.ts` (RF-22). Each handler is owner-scoped via
 * the helpers in `./shared.js` so the router file stays free of business
 * logic.
 */
import type { Context } from 'hono'
import type { LogEntry, RunStatus } from '@dzupagent/core/persistence'
import { ConcreteRunHandle } from '@dzupagent/agent/runtime'

import type { ForgeServerConfig } from '../../composition/types.js'
import type { AppEnv } from '../../types.js'
import { sanitizeRunForResponse } from '../../security/run-metadata-secrets.js'
import { parseIntBounded } from '../schemas.js'
import {
  getRequestingKeyId,
  getRequestingTenantId,
  loadOwnedRun,
} from './shared.js'

/**
 * DZUPAGENT-ERR-H-01: keys whose values carry raw failure detail (driver
 * text, stacks, causes) inside run log `data` and trace step payloads. The
 * failure persistence path writes the unsanitized detail there for operators.
 */
const FAILURE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'error',
  'errorDetail',
  'errorMessage',
  'stack',
  'cause',
])
const REDACTED_FAILURE_DETAIL = 'Internal server error'
const MAX_PROJECTION_DEPTH = 32

/**
 * Replace every failure-detail value at any depth with a fixed string,
 * leaving correlation and classification fields (traceId, phase, status,
 * toolName, ...) intact. Boolean/numeric flags under those keys are kept.
 */
export function redactFailureDetail(value: unknown, depth = 0): unknown {
  if (depth > MAX_PROJECTION_DEPTH) return REDACTED_FAILURE_DETAIL
  if (Array.isArray(value)) return value.map(item => redactFailureDetail(item, depth + 1))
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  const projected: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const carriesDetail =
      FAILURE_DETAIL_KEYS.has(key) &&
      (typeof child === 'string' || (typeof child === 'object' && child !== null))
    projected[key] = carriesDetail ? REDACTED_FAILURE_DETAIL : redactFailureDetail(child, depth + 1)
  }
  return projected
}

/** Client-safe projection of a run log entry for non-admin readers. */
function projectLogEntry(entry: LogEntry): LogEntry {
  return entry.data === undefined ? entry : { ...entry, data: redactFailureDetail(entry.data) }
}

/** Client-safe projection of a structured trace step for non-admin readers. */
export function projectTraceStep<T extends { content?: unknown; metadata?: unknown }>(step: T): T {
  return {
    ...step,
    ...(step.content !== undefined ? { content: redactFailureDetail(step.content) } : {}),
    ...(step.metadata !== undefined ? { metadata: redactFailureDetail(step.metadata) } : {}),
  }
}

/** Only admin-scoped reads see raw failure detail in logs and traces. */
function readsAdminDetail(c: Context): boolean {
  return (c as Context<AppEnv>).get('forgeRole') === 'admin'
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
  const key = (c as Context<AppEnv>).get('apiKey')
  const requestingTenantId = key ? getRequestingTenantId(c) : undefined

  const listFilter = {
    agentId: agentId ?? undefined,
    status: status ?? undefined,
    limit,
    offset,
    ...(requestingTenantId ? { tenantId: requestingTenantId } : {}),
  }

  const requestingKeyId = getRequestingKeyId(c)
  const ownerScopeFilter = requestingKeyId
    ? { ownerId: requestingKeyId, includeLegacyOwnerless: true }
    : {}

  const runs = await runStore.list({
    ...listFilter,
    ...ownerScopeFilter,
  })

  // RF-S02: filter results to the requesting API key's runs. Runs with no
  // recorded ownerId (pre-migration rows) stay visible so legacy data does
  // not disappear after the schema change. This remains as a defense-in-depth
  // guard for third-party stores that have not adopted the owner filter yet.
  const visible = requestingKeyId
    ? runs.filter(r => !r.ownerId || r.ownerId === requestingKeyId)
    : runs

  // `total` reflects the full match count ignoring pagination, so UIs can
  // render accurate pagination controls. Falls back to `runs.length` for
  // stores that don't implement the optional `count()` method.
  //
  const total = typeof runStore.count === 'function'
    ? await runStore.count({
        ...(agentId !== undefined ? { agentId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(requestingTenantId ? { tenantId: requestingTenantId } : {}),
        ...ownerScopeFilter,
      })
    : visible.length

  // DZUPAGENT-ERR-H-02: only admin-scoped reads expose the full failure detail
  // stashed on run.metadata.errorDetail; normal clients get the safe message.
  const includeAdminDetail = (c as Context<AppEnv>).get('forgeRole') === 'admin'
  return c.json({
    data: visible.map(r => sanitizeRunForResponse(r, { includeAdminDetail })),
    count: visible.length,
    total,
  })
}

/** GET /api/runs/:id — fetch a single owned run. */
export async function handleGetRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run
  // DZUPAGENT-ERR-H-02: admin-only failure detail is exposed only to admins.
  const includeAdminDetail = (c as Context<AppEnv>).get('forgeRole') === 'admin'
  return c.json({ data: sanitizeRunForResponse(run, { includeAdminDetail }) })
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
  // DZUPAGENT-ERR-H-01: non-admin owners get a client-safe projection.
  return c.json({ data: readsAdminDetail(c) ? logs : logs.map(projectLogEntry) })
}

/** GET /api/runs/:id/trace — aggregated trace + usage summary. */
export async function handleGetTrace(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore } = config
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  // DZUPAGENT-ERR-H-01: project before deriving events/toolCalls/steps so no
  // derived view re-exposes raw failure detail to non-admin owners.
  const includeAdminDetail = readsAdminDetail(c)
  const storedLogs = await runStore.getLogs(run.id)
  const logs = includeAdminDetail ? storedLogs : storedLogs.map(projectLogEntry)

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
              steps: includeAdminDetail
                ? structuredTrace.steps
                : structuredTrace.steps.map(projectTraceStep),
              totalSteps: structuredTrace.totalSteps,
              startedAt: structuredTrace.startedAt,
              completedAt: structuredTrace.completedAt,
            },
          }
        : {}),
    },
  })
}
