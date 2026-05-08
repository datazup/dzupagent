/**
 * Learning REST API routes — HTTP endpoints for self-learning dashboard and management.
 *
 * GET  /dashboard          — full dashboard from store namespaces
 * GET  /overview           — lightweight overview (counts only)
 * GET  /trends/quality     — quality trend (query: ?limit=20)
 * GET  /trends/cost        — cost trend (query: ?limit=20)
 * GET  /nodes              — per-node performance summaries
 * POST /feedback           — record user feedback
 * GET  /feedback/stats     — feedback statistics
 * POST /skill-packs/load   — load built-in skill packs
 * GET  /skill-packs        — list loaded skill pack IDs
 * GET  /lessons            — get top lessons (query: ?limit=10&nodeId=&taskType=)
 * GET  /rules              — get top rules (query: ?limit=10)
 * POST /ingest             — persist learning patterns from `run:scored` context (Step 3)
 *
 * All data is read directly from the MemoryServiceLike store to avoid
 * a hard dependency on @dzupagent/agent.
 *
 * This file is a thin coordinator — implementations live in:
 *   - `./learning-schemas`            — Zod schemas, types, helpers, persistence
 *   - `./learning-handlers-dashboard` — /dashboard, /overview, /trends/*, /nodes
 *   - `./learning-handlers-feedback`  — /feedback, /feedback/stats, /skill-packs/*
 *   - `./learning-handlers-content`   — /lessons, /rules, /ingest
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import type { LearningRouteConfig } from './learning-types.js'
import {
  DEFAULT_INGEST_THRESHOLD,
  DEFAULT_INGEST_TTL_MS,
  clamp01,
} from './learning-schemas.js'
import { registerDashboardHandlers } from './learning-handlers-dashboard.js'
import { registerFeedbackHandlers } from './learning-handlers-feedback.js'
import { registerContentHandlers } from './learning-handlers-content.js'

// ── Re-exports preserving the original public surface ──────────────────────

export type { LearningRouteConfig } from './learning-types.js'
export type { LearningPattern } from './learning-schemas.js'
export { isLearningPattern, storeLearningPattern } from './learning-schemas.js'

/**
 * Construct a Hono sub-app with all learning routes registered. Handler
 * implementations are organised across sibling modules; this factory wires
 * them together so callers continue to import from the original path.
 */
export function createLearningRoutes(config: LearningRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { memoryService, defaultTenantId = 'default' } = config
  const ingestThreshold = clamp01(
    typeof config.ingestConfidenceThreshold === 'number'
      ? config.ingestConfidenceThreshold
      : DEFAULT_INGEST_THRESHOLD,
  )
  const ingestTtlMs =
    typeof config.ingestDefaultTtlMs === 'number' && config.ingestDefaultTtlMs > 0
      ? config.ingestDefaultTtlMs
      : DEFAULT_INGEST_TTL_MS

  registerDashboardHandlers(app, { memoryService, defaultTenantId })
  registerFeedbackHandlers(app, { memoryService, defaultTenantId })
  registerContentHandlers(app, {
    memoryService,
    defaultTenantId,
    ingestThreshold,
    ingestTtlMs,
  })

  return app
}
