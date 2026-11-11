/**
 * One asynchronous quota-observation interface for every provider
 * (ADAPTER-QUOTA-OBSERVATION-MVP01).
 *
 * A probe never throws for a provider, transport or timing failure: it returns
 * a `ProviderQuotaReading` whose status and fixed reason code say why no
 * current evidence exists. It never starts an inference turn, reads
 * credentials or mutates provider state to obtain evidence.
 */
import {
  PROVIDER_QUOTA_SCHEMA,
  type ProviderQuotaObservation,
  type ProviderQuotaReading,
  type ProviderQuotaReasonCode,
} from '@dzupagent/runtime-contracts'

export interface ProviderQuotaReadRequest {
  /** Cancels the read; the probe still releases anything it owns. */
  readonly signal?: AbortSignal | undefined
  /** Upper bound for this read; probes clamp it to their own maximum. */
  readonly timeoutMs?: number | undefined
}

export interface ProviderQuotaProbe {
  readonly provider: string
  read(request?: ProviderQuotaReadRequest): Promise<ProviderQuotaReading>
}

/** Default evidence lifetime when the host does not choose one. */
export const PROVIDER_QUOTA_DEFAULT_OBSERVATION_TTL_MS = 5 * 60_000

export function providerQuotaInstant(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/** A reading without usable evidence. */
export function providerQuotaUnavailableReading(input: {
  readonly provider: string
  readonly poolRef: string | null
  readonly completedAtMs: number
  readonly status: 'unavailable' | 'unsupported' | 'failed'
  readonly reason: ProviderQuotaReasonCode
}): ProviderQuotaReading {
  return {
    schema: PROVIDER_QUOTA_SCHEMA,
    provider: input.provider,
    poolRef: input.poolRef,
    completedAt: providerQuotaInstant(input.completedAtMs),
    status: input.status,
    reason: input.reason,
    observations: [],
  }
}

/**
 * Classifies observations at `completedAtMs`: current if any is unexpired,
 * stale if all have expired, unavailable when there are none.
 */
export function providerQuotaReadingFromObservations(input: {
  readonly provider: string
  readonly poolRef: string | null
  readonly completedAtMs: number
  readonly observations: readonly ProviderQuotaObservation[]
}): ProviderQuotaReading {
  const base = {
    schema: PROVIDER_QUOTA_SCHEMA,
    provider: input.provider,
    poolRef: input.poolRef,
    completedAt: providerQuotaInstant(input.completedAtMs),
  }
  if (input.observations.length === 0) {
    return { ...base, status: 'unavailable', reason: 'no-observation', observations: [] }
  }
  const current = input.observations.some(
    (observation) => Date.parse(observation.expiresAt) > input.completedAtMs,
  )
  return current
    ? { ...base, status: 'current', observations: input.observations }
    : { ...base, status: 'stale', reason: 'stale', observations: input.observations }
}

/** Clamps a requested duration into `[1, maximum]`, using `fallback` when unset or invalid. */
export function boundedProviderQuotaMs(
  requested: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const value = requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested
    : fallback
  return Math.max(1, Math.min(Math.floor(value), maximum))
}
