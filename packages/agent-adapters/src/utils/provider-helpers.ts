/**
 * Centralized provider-resolution helpers used by orchestration,
 * HTTP handler, and recovery modules.
 */
import { ForgeError } from '@dzupagent/core'
import type { AdapterProviderId, AgentCLIAdapter } from '../types.js'

/** Accepted sources for provider resolution. */
type ProviderSource =
  | ReadonlyMap<AdapterProviderId, AgentCLIAdapter>
  | AgentCLIAdapter[]
  | AdapterProviderId[]

function extractCandidates(source: ProviderSource): AdapterProviderId[] {
  if (source instanceof Map) return [...source.keys()]
  const arr = source as AgentCLIAdapter[] | AdapterProviderId[]
  if (arr.length === 0) return []
  if (typeof arr[0] === 'string') {
    return arr as AdapterProviderId[]
  }
  return (arr as AgentCLIAdapter[]).map(a => a.providerId)
}

/**
 * Resolves a fallback provider ID from available adapters or provider IDs.
 * Returns the first available provider not in the exclusion list.
 */
export function resolveFallbackProviderId(
  adapters: ProviderSource,
  exclude?: AdapterProviderId[],
): AdapterProviderId | undefined {
  const excludeSet = new Set(exclude ?? [])
  const candidates = extractCandidates(adapters)
  return candidates.find(id => !excludeSet.has(id))
}

/**
 * Resolves a fallback provider ID, throwing if none available.
 */
export function requireFallbackProviderId(
  adapters: ProviderSource,
  exclude?: AdapterProviderId[],
): AdapterProviderId {
  const result = resolveFallbackProviderId(adapters, exclude)
  if (!result) {
    throw new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: 'No available provider for fallback',
      recoverable: false,
    })
  }
  return result
}
