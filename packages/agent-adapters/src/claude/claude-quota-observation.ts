/**
 * Claude subscription-quota observations from a host-delivered status-line
 * input, with readback through the common quota interface.
 *
 * Claude Code passes its status-line command a JSON document whose
 * `rate_limits.five_hour` and `rate_limits.seven_day` objects carry
 * `used_percentage` and `resets_at` (Unix seconds). They appear only after a
 * session response on supported subscriptions, so their interactive delivery
 * does not prove they reach a headless CLI or SDK run. This module therefore
 * only ingests what a host hands it: it never starts an inference turn, reads
 * credentials, calls an undocumented endpoint or edits the user's status line.
 * Without a fresh ingested observation, a read reports `unavailable` or
 * `stale` with its reason.
 *
 * Only the two rate-limit windows are read. Cost, token, context-window,
 * session, model and workspace fields of the input are ignored and never
 * stored.
 */
import {
  PROVIDER_QUOTA_DEFAULT_MAX_CLOCK_SKEW_MS,
  PROVIDER_QUOTA_SCHEMA,
  PROVIDER_QUOTA_WINDOW_MINUTES,
  isProviderQuotaRef,
  type ProviderQuotaObservation,
  type ProviderQuotaWindow,
} from '@dzupagent/runtime-contracts'

import {
  InMemoryProviderQuotaObservationStore,
  type ProviderQuotaObservationStore,
} from '../quota/provider-quota-observation-store.js'
import {
  PROVIDER_QUOTA_DEFAULT_OBSERVATION_TTL_MS,
  boundedProviderQuotaMs,
  providerQuotaInstant,
  providerQuotaReadingFromObservations,
  type ProviderQuotaProbe,
} from '../quota/provider-quota-probe.js'

export const CLAUDE_QUOTA_PROVIDER = 'claude'
export const CLAUDE_QUOTA_SOURCE = 'claude-code.status-line.rate_limits'

const CLAUDE_WINDOWS = [
  ['five_hour', PROVIDER_QUOTA_WINDOW_MINUTES.fiveHours],
  ['seven_day', PROVIDER_QUOTA_WINDOW_MINUTES.sevenDays],
] as const

const MAX_TTL_MS = 60 * 60_000
const MAX_SKEW_MS = 10 * 60_000

export interface ClaudeQuotaObservationSourceOptions {
  /** Opaque account or subscription-pool reference supplied by the host. */
  readonly poolRef: string
  /** Shared store; a private bounded in-memory store is used when omitted. */
  readonly store?: ProviderQuotaObservationStore
  /** Evidence lifetime from observation time; default five minutes. */
  readonly observationTtlMs?: number
  readonly maxClockSkewMs?: number
  /** Wall clock in epoch milliseconds (tests inject a fixed clock). */
  readonly now?: () => number
}

export interface ClaudeQuotaIngestOptions {
  /**
   * When the host received the status-line input, as epoch milliseconds.
   * Defaults to now; a time further in the future than the skew allowance is
   * refused.
   */
  readonly observedAtMs?: number
}

export type ClaudeQuotaIngestResult =
  | { readonly accepted: true, readonly observation: ProviderQuotaObservation }
  | {
      readonly accepted: false
      readonly reason:
        | 'no-observation'
        | 'malformed'
        | 'future-observation'
        | 'older-than-stored'
        | 'pool-provider-mismatch'
    }

export interface ClaudeQuotaObservationSource {
  /** Common-interface readback of the latest ingested observation. */
  readonly probe: ProviderQuotaProbe
  ingest(statusLineInput: unknown, options?: ClaudeQuotaIngestOptions): ClaudeQuotaIngestResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function epochSecondsToInstant(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const ms = value * 1000
  if (!Number.isFinite(ms) || ms > 8.64e15) return null
  return new Date(Math.round(ms)).toISOString()
}

/**
 * Extracts the documented rate-limit windows. Returns null when the input
 * carries no `rate_limits` object or neither window; a window that is present
 * keeps each field independently (missing or malformed values become null).
 */
export function parseClaudeStatusLineRateLimits(
  statusLineInput: unknown,
): ProviderQuotaWindow[] | null {
  if (!isRecord(statusLineInput)) return null
  const limits = statusLineInput['rate_limits']
  if (!isRecord(limits)) return null
  const windows: ProviderQuotaWindow[] = []
  for (const [windowRef, durationMinutes] of CLAUDE_WINDOWS) {
    const window = limits[windowRef]
    if (!isRecord(window)) continue
    const used = window['used_percentage']
    windows.push({
      windowRef,
      durationMinutes,
      usedPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null,
      resetsAt: epochSecondsToInstant(window['resets_at']),
    })
  }
  return windows.length > 0 ? windows : null
}

export function createClaudeQuotaObservationSource(
  options: ClaudeQuotaObservationSourceOptions,
): ClaudeQuotaObservationSource {
  if (!isProviderQuotaRef(options.poolRef)) {
    throw new TypeError('Claude quota source poolRef must be an opaque reference')
  }
  const poolRef = options.poolRef
  const store = options.store ?? new InMemoryProviderQuotaObservationStore({ maxEntries: 16 })
  const now = options.now ?? Date.now
  const ttlMs = boundedProviderQuotaMs(options.observationTtlMs, PROVIDER_QUOTA_DEFAULT_OBSERVATION_TTL_MS, MAX_TTL_MS)
  const skewMs = options.maxClockSkewMs !== undefined && Number.isFinite(options.maxClockSkewMs)
    ? Math.max(0, Math.min(options.maxClockSkewMs, MAX_SKEW_MS))
    : PROVIDER_QUOTA_DEFAULT_MAX_CLOCK_SKEW_MS

  const ingest = (
    statusLineInput: unknown,
    ingestOptions: ClaudeQuotaIngestOptions = {},
  ): ClaudeQuotaIngestResult => {
    const windows = parseClaudeStatusLineRateLimits(statusLineInput)
    if (windows === null) return { accepted: false, reason: 'no-observation' }
    const received = ingestOptions.observedAtMs ?? now()
    if (!Number.isFinite(received) || received <= 0) return { accepted: false, reason: 'malformed' }
    if (received > now() + skewMs) return { accepted: false, reason: 'future-observation' }
    const observation: ProviderQuotaObservation = {
      schema: PROVIDER_QUOTA_SCHEMA,
      provider: CLAUDE_QUOTA_PROVIDER,
      poolRef,
      bucketRef: null,
      modelScope: null,
      source: CLAUDE_QUOTA_SOURCE,
      method: 'host-ingestion',
      observedAt: providerQuotaInstant(received),
      expiresAt: providerQuotaInstant(received + ttlMs),
      windows,
    }
    const stored = store.put(observation)
    if (!stored.accepted) {
      return {
        accepted: false,
        reason: stored.reason === 'pool-unknown' ? 'malformed' : stored.reason,
      }
    }
    return { accepted: true, observation }
  }

  const probe: ProviderQuotaProbe = {
    provider: CLAUDE_QUOTA_PROVIDER,
    read: async () => providerQuotaReadingFromObservations({
      provider: CLAUDE_QUOTA_PROVIDER,
      poolRef,
      completedAtMs: now(),
      observations: store.read(CLAUDE_QUOTA_PROVIDER, poolRef),
    }),
  }

  return { probe, ingest }
}
