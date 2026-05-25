/**
 * Routing statistics route.
 *
 * GET /api/runs/routing-stats — Aggregated model routing stats from recent runs.
 *
 * Queries the RunStore for recent runs and aggregates routing decision
 * metadata (modelTier, routingReason, complexity) to give operators
 * visibility into how the cost-aware router distributes traffic.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { RunStore } from '@dzupagent/core/persistence'
import { getOptionalRequestingTenantId } from './tenant-scope.js'

export interface RoutingStatsConfig {
  runStore: RunStore
}

interface TierStats {
  count: number
  avgDurationMs: number | null
  totalDurationMs: number
}

interface QualityMetrics {
  /** Average reflection quality score across all scored runs (0-1) */
  avgQuality: number | null
  /** Average quality score per model tier */
  avgQualityByTier: Record<string, number | null>
  /** Number of runs with quality below 0.5 threshold */
  lowQualityRunCount: number
}

interface RoutingStatsResponse {
  totalRuns: number
  byTier: Record<string, number>
  byReason: Record<string, number>
  byComplexity: Record<string, number>
  avgDurationByTier: Record<string, number | null>
  qualityMetrics: QualityMetrics
}

export function createRoutingStatsRoutes(config: RoutingStatsConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/routing-stats', async (c) => {
    const key = c.get('apiKey')
    const requestingTenantId = getOptionalRequestingTenantId(c)
    const requestingOwnerId = typeof key?.['id'] === 'string' ? key['id'] : undefined

    // SEC-M-05: If auth mode is active (key present) but the key has no valid
    // string id, fall back to tenant-only filter would expose cross-key
    // telemetry. Reject immediately instead.
    if (key !== undefined && typeof key?.['id'] !== 'string') {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'API key must have a valid id to access routing stats' } },
        403,
      )
    }

    const keyRole = typeof key?.['role'] === 'string' ? key['role'] : undefined
    const isOperator = keyRole === 'admin' || keyRole === 'operator'
    const includeOwnerless = isOperator
      && c.req.query('includeLegacyOwnerless') === 'true'

    const runs = await config.runStore.list({
      limit: 100,
      ...(requestingTenantId ? { tenantId: requestingTenantId } : {}),
      ...(requestingOwnerId ? { ownerId: requestingOwnerId, includeLegacyOwnerless: includeOwnerless } : {}),
    })

    // Defense in depth for third-party stores that may not fully implement
    // owner scoping yet.
    const visibleRuns = requestingOwnerId
      ? runs.filter((run) => !run.ownerId || run.ownerId === requestingOwnerId)
      : runs

    const byTier: Record<string, number> = {}
    const byReason: Record<string, number> = {}
    const byComplexity: Record<string, number> = {}
    const tierDurations: Record<string, TierStats> = {}

    for (const run of visibleRuns) {
      const meta = run.metadata as Record<string, unknown> | undefined
      const tier = (typeof meta?.['modelTier'] === 'string' ? meta['modelTier'] : 'unknown')
      const reason = (typeof meta?.['routingReason'] === 'string' ? meta['routingReason'] : 'unknown')
      const complexity = (typeof meta?.['complexity'] === 'string' ? meta['complexity'] : 'unknown')

      byTier[tier] = (byTier[tier] ?? 0) + 1
      byReason[reason] = (byReason[reason] ?? 0) + 1
      byComplexity[complexity] = (byComplexity[complexity] ?? 0) + 1

      // Compute duration if both timestamps exist
      const durationMs = run.completedAt && run.startedAt
        ? run.completedAt.getTime() - run.startedAt.getTime()
        : null

      if (!tierDurations[tier]) {
        tierDurations[tier] = { count: 0, avgDurationMs: null, totalDurationMs: 0 }
      }
      if (durationMs !== null) {
        tierDurations[tier].count += 1
        tierDurations[tier].totalDurationMs += durationMs
      }
    }

    const avgDurationByTier: Record<string, number | null> = {}
    for (const [tier, stats] of Object.entries(tierDurations)) {
      avgDurationByTier[tier] = stats.count > 0
        ? Math.round(stats.totalDurationMs / stats.count)
        : null
    }

    // --- Quality metrics from reflectionScore in run metadata ---
    let totalQuality = 0
    let qualityCount = 0
    let lowQualityRunCount = 0
    const tierQualitySums: Record<string, { total: number; count: number }> = {}

    for (const run of visibleRuns) {
      const meta = run.metadata as Record<string, unknown> | undefined
      const reflectionScore = meta?.['reflectionScore'] as { overall?: number } | undefined
      if (reflectionScore && typeof reflectionScore.overall === 'number') {
        const overall = reflectionScore.overall
        totalQuality += overall
        qualityCount += 1

        if (overall < 0.5) {
          lowQualityRunCount += 1
        }

        const tier = (typeof meta?.['modelTier'] === 'string' ? meta['modelTier'] : 'unknown')
        if (!tierQualitySums[tier]) {
          tierQualitySums[tier] = { total: 0, count: 0 }
        }
        tierQualitySums[tier].total += overall
        tierQualitySums[tier].count += 1
      }
    }

    const avgQualityByTier: Record<string, number | null> = {}
    for (const [tier, sums] of Object.entries(tierQualitySums)) {
      avgQualityByTier[tier] = sums.count > 0
        ? Math.round(sums.total / sums.count * 1000) / 1000
        : null
    }

    const qualityMetrics: QualityMetrics = {
      avgQuality: qualityCount > 0
        ? Math.round(totalQuality / qualityCount * 1000) / 1000
        : null,
      avgQualityByTier,
      lowQualityRunCount,
    }

    const result: RoutingStatsResponse = {
      totalRuns: visibleRuns.length,
      byTier,
      byReason,
      byComplexity,
      avgDurationByTier,
      qualityMetrics,
    }

    return c.json({ data: result })
  })

  return app
}
