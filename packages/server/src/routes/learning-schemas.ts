/**
 * Shared schemas, types, helpers, and persistence primitives for the learning
 * routes. Extracted from `learning.ts` to keep handler modules focused.
 */
import { z } from 'zod'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

// ── Zod request schemas ────────────────────────────────────────────────────

export const FeedbackSchema = z.object({
  runId: z.string().min(1),
  approved: z.boolean(),
  type: z.unknown().optional(),
  feedback: z.unknown().optional(),
  featureCategory: z.unknown().optional(),
})

export const SkillPackLoadSchema = z.object({
  packIds: z.array(z.unknown()).min(1),
})

export const IngestSchema = z.object({
  runId: z.string().min(1),
  score: z.number().finite(),
  patterns: z.array(z.unknown()),
  agentId: z.string().optional(),
})

// ── Shared constants ───────────────────────────────────────────────────────

export const DEFAULT_INGEST_THRESHOLD = 0.5
export const DEFAULT_INGEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

// ── Public types ───────────────────────────────────────────────────────────

/**
 * A generalizable pattern extracted from a scored run.
 * Shared shape across the `/ingest` route and `LearningEventProcessor`.
 */
export interface LearningPattern {
  /** Free-text summary of the learned pattern. */
  pattern: string
  /** Short contextual tag (e.g. tool name, phase, or category). */
  context: string
  /** Confidence score in the range [0, 1]. */
  confidence: number
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Settled result value or empty array on rejection. */
export function settledValue<T>(result: PromiseSettledResult<T[]>): T[] {
  return result.status === 'fulfilled' ? result.value : []
}

/** Parse a positive integer from a query string, returning `fallback` on failure. */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = parseInt(value, 10)
  return isNaN(n) || n <= 0 ? fallback : n
}

/** Build the scope object for a given tenant. */
export function tenantScope(tenantId: string): Record<string, string> {
  return tenantId ? { tenantId } : {}
}

/** Clamp a number into the [0, 1] range, falling back to the default threshold. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INGEST_THRESHOLD
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Runtime validator for a `LearningPattern` shape. */
export function isLearningPattern(value: unknown): value is LearningPattern {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['pattern'] === 'string' &&
    obj['pattern'].length > 0 &&
    typeof obj['context'] === 'string' &&
    typeof obj['confidence'] === 'number' &&
    Number.isFinite(obj['confidence'])
  )
}

// ── Persistence ────────────────────────────────────────────────────────────

/** Persist a single pattern into the `lessons` namespace with full provenance. */
export async function storeLearningPattern(
  memoryService: MemoryServiceLike,
  scope: Record<string, string>,
  pattern: LearningPattern,
  provenance: { runId: string; score: number; agentId?: string },
  ttlMs: number,
): Promise<string> {
  const key = `lesson-${provenance.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const record: Record<string, unknown> = {
    content: pattern.pattern,
    context: pattern.context,
    confidence: pattern.confidence,
    provenance: {
      runId: provenance.runId,
      score: provenance.score,
      ...(provenance.agentId !== undefined ? { agentId: provenance.agentId } : {}),
    },
    decay: {
      ttlMs,
      createdAt: now,
      expiresAt: now + ttlMs,
    },
    timestamp: new Date(now).toISOString(),
    // Legacy fields for compatibility with `/lessons` endpoint sort keys.
    importance: pattern.confidence,
    nodeId: pattern.context,
  }
  await memoryService.put('lessons', scope, key, record)
  return key
}

// ── Tenant resolution ──────────────────────────────────────────────────────

/**
 * Resolve tenantId from the same authenticated API key metadata used by the
 * rest of the route families. The legacy `tenantId` context variable remains
 * supported for older hosts that mounted learning routes directly.
 */
export function resolveTenantId(
  c: { get(key: string): unknown },
  defaultTenantId: string,
): string {
  const key = c.get('apiKey')
  if (key && typeof key === 'object') {
    const apiKey = key as Record<string, unknown>
    const tenantId = apiKey['tenantId']
    if (typeof tenantId === 'string' && tenantId.length > 0) return tenantId
    const ownerId = apiKey['ownerId']
    if (typeof ownerId === 'string' && ownerId.length > 0) return ownerId
    const id = apiKey['id']
    if (typeof id === 'string' && id.length > 0) return id
  }

  const fromCtx = c.get('tenantId')
  return typeof fromCtx === 'string' && fromCtx.length > 0 ? fromCtx : defaultTenantId
}
