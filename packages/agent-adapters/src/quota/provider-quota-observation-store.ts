/**
 * Bounded in-memory store for normalized quota observations.
 *
 * Entries are keyed by the host's opaque pool reference and the provider's
 * bucket, never by profile, host or session, so the same shared subscription
 * pool observed from several places is held once. Only allowlisted contract
 * fields are copied in; anything else on the input is dropped. Reading an entry
 * returns it unchanged: reads never refresh `observedAt` or `expiresAt`, and an
 * older observation never replaces a newer one.
 */
import {
  validateProviderQuotaObservation,
  type ProviderQuotaObservation,
  type ProviderQuotaReading,
} from '@dzupagent/runtime-contracts'

export type ProviderQuotaStorePutResult =
  | { readonly accepted: true; readonly replaced: boolean }
  | {
      readonly accepted: false
      readonly reason: 'malformed' | 'pool-unknown' | 'pool-provider-mismatch' | 'older-than-stored'
    }

/** Port so hosts can supply their own bounded store. */
export interface ProviderQuotaObservationStore {
  put(observation: ProviderQuotaObservation): ProviderQuotaStorePutResult
  /** Observations held for one pool, in bucket order; empty when none. */
  read(provider: string, poolRef: string): readonly ProviderQuotaObservation[]
}

export interface InMemoryProviderQuotaObservationStoreOptions {
  /** Maximum stored observations across all pools (default 256). */
  readonly maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 256
const MAX_ENTRIES_LIMIT = 10_000

function copyAllowlisted(observation: ProviderQuotaObservation): ProviderQuotaObservation {
  return Object.freeze({
    schema: observation.schema,
    provider: observation.provider,
    poolRef: observation.poolRef,
    bucketRef: observation.bucketRef,
    modelScope: observation.modelScope,
    source: observation.source,
    method: observation.method,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    usagePermission: observation.usagePermission,
    windows: Object.freeze(observation.windows.map((window) => Object.freeze({
      windowRef: window.windowRef,
      durationMinutes: window.durationMinutes,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    }))),
  })
}

export class InMemoryProviderQuotaObservationStore implements ProviderQuotaObservationStore {
  private readonly maxEntries: number
  private readonly entries = new Map<string, ProviderQuotaObservation>()
  /** poolRef -> provider; an opaque pool belongs to exactly one provider. */
  private readonly poolProviders = new Map<string, string>()

  constructor(options: InMemoryProviderQuotaObservationStoreOptions = {}) {
    const requested = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxEntries = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, MAX_ENTRIES_LIMIT)
      : DEFAULT_MAX_ENTRIES
  }

  get size(): number {
    return this.entries.size
  }

  put(observation: ProviderQuotaObservation): ProviderQuotaStorePutResult {
    if (validateProviderQuotaObservation(observation).length > 0) {
      return { accepted: false, reason: 'malformed' }
    }
    const poolRef = observation.poolRef
    if (poolRef === null) return { accepted: false, reason: 'pool-unknown' }
    const owner = this.poolProviders.get(poolRef)
    if (owner !== undefined && owner !== observation.provider) {
      return { accepted: false, reason: 'pool-provider-mismatch' }
    }
    const key = `${poolRef}\u0000${observation.bucketRef ?? ''}`
    const existing = this.entries.get(key)
    if (existing !== undefined
      && Date.parse(existing.observedAt) > Date.parse(observation.observedAt)) {
      return { accepted: false, reason: 'older-than-stored' }
    }
    this.entries.delete(key)
    this.entries.set(key, copyAllowlisted(observation))
    this.poolProviders.set(poolRef, observation.provider)
    this.evict()
    return { accepted: true, replaced: existing !== undefined }
  }

  read(provider: string, poolRef: string): readonly ProviderQuotaObservation[] {
    const result: ProviderQuotaObservation[] = []
    for (const observation of this.entries.values()) {
      if (observation.poolRef === poolRef && observation.provider === provider) {
        result.push(observation)
      }
    }
    return result.sort((left, right) =>
      (left.bucketRef ?? '').localeCompare(right.bucketRef ?? ''))
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined
      let oldest = Number.POSITIVE_INFINITY
      for (const [key, observation] of this.entries) {
        const time = Date.parse(observation.observedAt)
        if (time < oldest) {
          oldest = time
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      this.entries.delete(oldestKey)
    }
    const livePools = new Set<string>()
    for (const observation of this.entries.values()) {
      if (observation.poolRef !== null) livePools.add(observation.poolRef)
    }
    for (const poolRef of [...this.poolProviders.keys()]) {
      if (!livePools.has(poolRef)) this.poolProviders.delete(poolRef)
    }
  }
}

/** Stores every observation of a current or stale reading; returns how many were accepted. */
export function recordProviderQuotaReading(
  store: ProviderQuotaObservationStore,
  reading: ProviderQuotaReading,
): number {
  let accepted = 0
  for (const observation of reading.observations) {
    if (store.put(observation).accepted) accepted += 1
  }
  return accepted
}
