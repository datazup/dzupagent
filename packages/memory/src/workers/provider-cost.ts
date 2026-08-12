import type { InternalMemoryOutboxEntryV1 } from './types.js'

export interface InternalProviderCostFieldsV1 {
  readonly providerCostMicrousd: number
  readonly providerCostState: 'known' | 'unknown'
}

export function resolveProviderCost(
  entry: InternalMemoryOutboxEntryV1,
  providerCostMicrousd?: number,
  providerCostState?: 'known' | 'unknown',
  defaultState: 'known' | 'unknown' = 'known',
): InternalProviderCostFieldsV1 {
  const priorState = entry.outcome?.providerCostState
  const state = providerCostState === 'unknown' || priorState === 'unknown'
    ? 'unknown'
    : providerCostState ?? priorState ?? defaultState
  return {
    providerCostMicrousd: state === 'unknown'
      ? 0
      : providerCostMicrousd ?? entry.outcome?.providerCostMicrousd ?? 0,
    providerCostState: state,
  }
}
