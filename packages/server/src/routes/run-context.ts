/**
 * Run context routes — real-time visibility into token lifecycle,
 * compression events, and overall context health for a run.
 *
 * GET /api/runs/:id/context
 *
 * Response shape:
 * ```json
 * {
 *   "data": {
 *     "runId": "...",
 *     "tokenUsage": { "used": N, "remaining": N, "total": N },
 *     "compressionStats": { "count": N, "lastAt": "ISO|null", "savedTokens": N },
 *     "status": "ok|warn|critical|exhausted",
 *     "recommendations": ["..."]
 *   }
 * }
 * ```
 *
 * Data sources (in order of preference):
 *   1. `config.tokenLifecycleRegistry` — a `Map<runId, TokenLifecycleLike>` (or
 *      any compatible store) that run executors populate while a run is active.
 *   2. Run metadata — persisted `tokenLifecycleReport` / `tokenUsage` fields.
 *   3. Run logs — compression events are reconstructed from log entries whose
 *      `phase` is `'compression'` or `'compress'`.
 *
 * The route is tolerant of missing data: if no lifecycle manager is wired and
 * no metadata/logs exist, it returns a zero-state report with `status: 'ok'`
 * so callers can poll without branching on 404s.
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../app.js'
import type { LogEntry } from '@dzupagent/core'
import type { CompressionLogEntry } from '@dzupagent/agent'

/** Structural type for TokenLifecycleManager (from `@dzupagent/context`).
 *  We use structural typing to avoid a hard dependency on the context package,
 *  matching the existing `RunReflectorLike` pattern in this server. */
export interface TokenLifecycleLike {
  readonly usedTokens: number
  readonly remainingTokens: number
  readonly status: 'ok' | 'warn' | 'critical' | 'exhausted'
  readonly report: {
    used: number
    available: number
    pct: number
    status: 'ok' | 'warn' | 'critical' | 'exhausted'
    phases: Array<{ phase: string; tokens: number; timestamp: number }>
    recommendation?: string
  }
}

/** Minimal registry surface — anything that can look up a lifecycle manager by runId. */
export interface TokenLifecycleRegistry {
  get(runId: string): TokenLifecycleLike | undefined
}

interface CompressionStats {
  count: number
  lastAt: string | null
  savedTokens: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Derive compression stats for a run.
 *
 * Sources (in order of preference):
 *   1. **`run.metadata.compressionLog`** — an array of `CompressionLogEntry`
 *      ({ before, after, summary, ts }) that the run-worker persists when the
 *      underlying agent emits auto-compression events (Session Y). When at
 *      least one entry is present this is treated as the canonical source —
 *      `savedTokens` is derived from `entry.before - entry.after` (clamped
 *      at zero) and `lastAt` from the maximum `entry.ts`.
 *   2. **Run logs** — fallback used when `metadata.compressionLog` is absent,
 *      not an array, or empty. Any log whose `phase` starts with `'compress'`
 *      is counted; `data.savedTokens` (number) is summed.
 *
 * Both sources are tolerant of malformed entries — non-record entries and
 * non-numeric fields are skipped rather than aborting the scan.
 */
export function deriveCompressionStats(
  logs: LogEntry[],
  metadata?: Record<string, unknown> | null,
): CompressionStats {
  // --- Primary source: run.metadata.compressionLog ---
  if (metadata && isRecord(metadata)) {
    const raw = metadata['compressionLog']
    if (Array.isArray(raw) && raw.length > 0) {
      let count = 0
      let savedTokens = 0
      let latestTs: number | null = null

      for (const entry of raw) {
        if (!isRecord(entry)) continue
        count += 1

        const before = entry['before']
        const after = entry['after']
        if (
          typeof before === 'number' && Number.isFinite(before) &&
          typeof after === 'number' && Number.isFinite(after)
        ) {
          const saved = before - after
          if (saved > 0) savedTokens += saved
        }

        const ts = entry['ts']
        if (typeof ts === 'number' && Number.isFinite(ts)) {
          if (latestTs === null || ts > latestTs) latestTs = ts
        }
      }

      if (count > 0) {
        return {
          count,
          savedTokens,
          lastAt: latestTs !== null ? new Date(latestTs).toISOString() : null,
        }
      }
    }
  }

  // --- Fallback: scan run logs for phase='compress*' ---
  let count = 0
  let savedTokens = 0
  let lastAt: string | null = null

  for (const log of logs) {
    const phase = log.phase ?? ''
    if (!phase.startsWith('compress')) continue
    count += 1

    if (log.data && isRecord(log.data)) {
      const saved = log.data['savedTokens']
      if (typeof saved === 'number' && Number.isFinite(saved)) {
        savedTokens += saved
      }
    }

    const ts = log.timestamp
    if (ts instanceof Date) {
      lastAt = ts.toISOString()
    } else if (typeof ts === 'string') {
      lastAt = ts
    } else if (typeof ts === 'number') {
      lastAt = new Date(ts).toISOString()
    }
  }

  return { count, lastAt, savedTokens }
}

const RECOMMENDATIONS: Record<TokenLifecycleLike['status'], string | undefined> = {
  ok: undefined,
  warn: 'Consider compressing conversation history',
  critical: 'Compress or truncate history immediately',
  exhausted: 'Context window exhausted — must compress before next call',
}

export function createRunContextRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const { runStore } = config

  app.get('/:id/context', async (c) => {
    const runId = c.req.param('id')
    const run = await runStore.get(runId)
    if (!run) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        404,
      )
    }

    // --- Resolve token lifecycle report ---
    const lifecycle = config.tokenLifecycleRegistry?.get(runId)

    let used = 0
    let remaining = 0
    let total = 0
    let status: TokenLifecycleLike['status'] = 'ok'
    const recommendations: string[] = []

    if (lifecycle) {
      const report = lifecycle.report
      used = report.used
      remaining = Math.max(0, report.available - report.used)
      total = report.available
      status = report.status
      if (report.recommendation) recommendations.push(report.recommendation)
    } else {
      // Fall back to persisted metadata on the run record. This lets terminal
      // runs still expose a meaningful report after the in-memory manager is
      // garbage-collected.
      const meta = (run.metadata ?? {}) as Record<string, unknown>
      const tokenReport = meta['tokenLifecycleReport']
      if (isRecord(tokenReport)) {
        if (typeof tokenReport['used'] === 'number') used = tokenReport['used']
        if (typeof tokenReport['available'] === 'number') {
          total = tokenReport['available']
          remaining = Math.max(0, total - used)
        }
        const reportStatus = tokenReport['status']
        if (
          reportStatus === 'ok' ||
          reportStatus === 'warn' ||
          reportStatus === 'critical' ||
          reportStatus === 'exhausted'
        ) {
          status = reportStatus
        }
        const rec = tokenReport['recommendation']
        if (typeof rec === 'string' && rec.length > 0) recommendations.push(rec)
      } else if (run.tokenUsage) {
        // Last resort — synthesize from tokenUsage totals (no budget => status ok).
        used = (run.tokenUsage.input ?? 0) + (run.tokenUsage.output ?? 0)
      }
    }

    // Emit a default recommendation based on status if the lifecycle manager
    // didn't supply one (e.g. when reading from persisted metadata).
    if (recommendations.length === 0) {
      const fallback = RECOMMENDATIONS[status]
      if (fallback !== undefined) recommendations.push(fallback)
    }

    // --- Derive compression stats ---
    // Session Z: prefer `run.metadata.compressionLog` (persisted by the
    // run-worker in Session Y); fall back to scanning run logs for
    // phase='compress*' when the metadata log is absent or empty.
    const logs = await runStore.getLogs(runId)
    const compressionStats = deriveCompressionStats(
      logs,
      (run.metadata ?? null) as Record<string, unknown> | null,
    )

    return c.json({
      data: {
        runId,
        tokenUsage: { used, remaining, total },
        compressionStats,
        status,
        recommendations,
      },
    })
  })

  // -------------------------------------------------------------------------
  // Session X: GET /api/runs/:id/token-report
  //
  // Returns a flattened TokenLifecycleReport for the run, including the full
  // phase breakdown and an optional `haltReason` pulled from run metadata.
  //
  // Data sources (in order of preference):
  //   1. `config.tokenLifecycleRegistry?.get(runId)?.report` — live run
  //   2. `run.metadata.tokenLifecycleReport` — terminal run, persisted report
  //   3. `run.output.tokenLifecycle` — Session W promoted copy in the output
  //
  // If no report is found in any source, a zero-state payload is returned so
  // callers can poll without branching on 404s (matching the behaviour of the
  // adjacent /context route).
  // -------------------------------------------------------------------------
  app.get('/:id/token-report', async (c) => {
    const runId = c.req.param('id')
    const run = await runStore.get(runId)
    if (!run) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        404,
      )
    }

    type LifecyclePhase = { phase: string; tokens: number; timestamp: number }
    type LifecycleStatus = 'ok' | 'warn' | 'critical' | 'exhausted'

    let used = 0
    let available = 0
    let pct = 0
    let status: LifecycleStatus = 'ok'
    let phases: LifecyclePhase[] = []

    const lifecycle = config.tokenLifecycleRegistry?.get(runId)
    if (lifecycle) {
      const report = lifecycle.report
      used = report.used
      available = report.available
      pct = report.pct
      status = report.status
      phases = [...report.phases]
    } else {
      const meta = (run.metadata ?? {}) as Record<string, unknown>
      const metaReport = meta['tokenLifecycleReport']
      const outputReport = isRecord(run.output) && isRecord((run.output)['tokenLifecycle'])
        ? (run.output as Record<string, unknown>)['tokenLifecycle']
        : undefined

      const report = isRecord(metaReport)
        ? metaReport
        : isRecord(outputReport)
          ? outputReport
          : undefined

      if (report) {
        if (typeof report['used'] === 'number') used = report['used']
        if (typeof report['available'] === 'number') available = report['available']
        if (typeof report['pct'] === 'number') {
          pct = report['pct']
        } else if (available > 0) {
          pct = Math.min(1, used / available)
        }
        const reportStatus = report['status']
        if (
          reportStatus === 'ok' ||
          reportStatus === 'warn' ||
          reportStatus === 'critical' ||
          reportStatus === 'exhausted'
        ) {
          status = reportStatus
        }
        const reportPhases = report['phases']
        if (Array.isArray(reportPhases)) {
          phases = reportPhases.filter((p): p is LifecyclePhase =>
            isRecord(p)
            && typeof p['phase'] === 'string'
            && typeof p['tokens'] === 'number'
            && typeof p['timestamp'] === 'number',
          ).map(p => ({ phase: p.phase, tokens: p.tokens, timestamp: p.timestamp }))
        }
      }
    }

    const meta = (run.metadata ?? {}) as Record<string, unknown>
    const haltReason = typeof meta['haltReason'] === 'string' ? meta['haltReason'] : null

    // Session AA: include compression log entries persisted by run-worker. The
    // worker merges the agent's `GenerateResult.compressionLog` into
    // `run.metadata.compressionLog` when any compression occurred; callers get
    // an empty array otherwise so UIs can render deterministically.
    const rawCompressionLog = meta['compressionLog']
    const compressionLog: CompressionLogEntry[] = Array.isArray(rawCompressionLog)
      ? rawCompressionLog.filter((entry): entry is CompressionLogEntry =>
        isRecord(entry)
        && typeof entry['before'] === 'number'
        && typeof entry['after'] === 'number'
        && (entry['summary'] === null || typeof entry['summary'] === 'string')
        && typeof entry['ts'] === 'number',
      ).map(entry => ({
        before: entry.before,
        after: entry.after,
        summary: entry.summary,
        ts: entry.ts,
      }))
      : []

    return c.json({
      data: {
        runId,
        phases,
        status,
        used,
        available,
        pct,
        haltReason,
        compressionLog,
      },
    })
  })

  return app
}
