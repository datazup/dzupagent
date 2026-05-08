/**
 * Cost-cap helpers for EvalOrchestrator.
 *
 * Extracted from eval-orchestrator-impl.ts in MC-026a so the orchestrator
 * class stays focused on queue / lease coordination.
 */

import { EvalCostExceededError } from './eval-orchestrator-errors.js'

export interface CostCapConfig {
  costCapCents?: number
  getAccumulatedCostCents?: () => number | Promise<number>
}

export async function resolveAccumulatedCostCents(config: CostCapConfig): Promise<number> {
  const raw = config.getAccumulatedCostCents
    ? await config.getAccumulatedCostCents()
    : 0
  return Number.isFinite(raw) ? raw : 0
}

export async function assertCostWithinCap(config: CostCapConfig): Promise<void> {
  const capCents = config.costCapCents
  if (capCents === undefined) return

  const observedCents = await resolveAccumulatedCostCents(config)
  if (observedCents > capCents) {
    throw new EvalCostExceededError(
      `Eval run exceeded cost cap: observed ${observedCents} cents, cap ${capCents} cents`,
      capCents,
      observedCents,
    )
  }
}
