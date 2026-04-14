import type { CostTrackingMiddleware } from './cost-tracking.js'
import type { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import type { AdapterMiddleware } from './middleware-pipeline.js'

/**
 * Creates a middleware that tracks token usage and cost.
 */
export function createCostTrackingMiddleware(tracker: CostTrackingMiddleware): AdapterMiddleware {
  return async function* costTracking(source, _context) {
    yield* tracker.wrap(source)
  }
}

/**
 * Creates a middleware that enforces budget limits and detects stuck agents.
 */
export function createGuardrailsMiddleware(guardrails: AdapterGuardrails): AdapterMiddleware {
  return async function* guardrailsMiddleware(source, _context) {
    yield* guardrails.wrap(source)
  }
}
