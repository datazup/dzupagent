/**
 * Codex subscription-quota probe over the Codex app-server
 * (`account/rateLimits/read`), reusing `CodexAppServerStdioClient` through its
 * public `request` and `close` methods.
 *
 * Bounds: connecting an owned client and the request end by the read
 * deadline, and closing an owned client gets a further bounded grace; cancellation is honoured at every step; frame
 * sizes and pending-request limits are the client's own limits. An owned
 * client (from `connect`) is always closed, on success and on failure; a
 * shared client (`client`) stays owned by its caller and is never closed here.
 *
 * Only `account/rateLimits/read` is sent. No thread, turn, login, logout,
 * credit, reset or settings request is made. Provider errors, the raw payload
 * and the account identifier are never retained: failures become fixed reason
 * codes and the payload is reduced to allowlisted contract fields.
 *
 * Compatibility: the multi-bucket `rateLimitsByLimitId` map is preferred; when
 * it is absent, null or empty, the single `rateLimits` snapshot is used.
 * Windows are identified by their reported `windowDurationMins` (300 is five
 * hours, 10080 seven days), never by their primary/secondary position alone.
 */
import {
  PROVIDER_QUOTA_LIMITS,
  PROVIDER_QUOTA_SCHEMA,
  isProviderQuotaRef,
  type ProviderQuotaObservation,
  type ProviderQuotaReading,
  type ProviderQuotaReasonCode,
  type ProviderQuotaWindow,
} from '@dzupagent/runtime-contracts'

import {
  PROVIDER_QUOTA_DEFAULT_OBSERVATION_TTL_MS,
  boundedProviderQuotaMs,
  providerQuotaInstant,
  providerQuotaReadingFromObservations,
  providerQuotaUnavailableReading,
  type ProviderQuotaProbe,
  type ProviderQuotaReadRequest,
} from '../quota/provider-quota-probe.js'

export const CODEX_QUOTA_PROVIDER = 'codex'
export const CODEX_QUOTA_RPC_METHOD = 'account/rateLimits/read'
/**
 * Request parameters. `excludeResetCreditDetails` skips the separate
 * reset-credit lookup the app-server documents for background usage polls;
 * `supportsLunaReserve` is deliberately not sent because it lets the backend
 * record experiment exposure.
 */
export const CODEX_QUOTA_RPC_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({
  excludeResetCreditDetails: true,
})

/** The two public methods of `CodexAppServerStdioClient` that the probe uses. */
export interface CodexQuotaRpcClient {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<unknown>
  close(): Promise<void>
}

export interface CodexQuotaConnectOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

interface CodexQuotaProbeCommonOptions {
  /** Opaque account or pool reference supplied by the host; null when unknown. */
  readonly poolRef: string | null
  /** Default and maximum read time; defaults 15 s and 60 s. */
  readonly timeoutMs?: number
  readonly maxTimeoutMs?: number
  /** Extra time allowed to close an owned client; default 5 s, maximum 30 s. */
  readonly cleanupGraceMs?: number
  /** Evidence lifetime from observation time; default five minutes. */
  readonly observationTtlMs?: number
  /** Wall clock in epoch milliseconds (tests inject a fixed clock). */
  readonly now?: () => number
}

export type CodexQuotaProbeOptions = CodexQuotaProbeCommonOptions & (
  | {
      /** Shared, already-initialized client owned by the caller. */
      readonly client: CodexQuotaRpcClient
      readonly connect?: never
    }
  | {
      /**
       * Opens and initializes a client this probe owns for one read, for example
       * `(o) => CodexAppServerStdioClient.connect(clientOptions, o)`.
       */
      readonly connect: (options: CodexQuotaConnectOptions) => Promise<CodexQuotaRpcClient>
      readonly client?: never
    }
)

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_TIMEOUT_MS = 60_000
const MAX_TTL_MS = 60 * 60_000
const DEFAULT_CLEANUP_GRACE_MS = 5_000
const MAX_CLEANUP_GRACE_MS = 30_000

class QuotaReadStop extends Error {
  constructor(readonly reason: ProviderQuotaReasonCode) {
    super(reason)
    this.name = 'QuotaReadStop'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reasonForError(error: unknown): ProviderQuotaReasonCode {
  if (error instanceof QuotaReadStop) return error.reason
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
  switch (code) {
    case 'CODEX_APP_SERVER_TIMEOUT': return 'timeout'
    case 'CODEX_APP_SERVER_CANCELLED': return 'cancelled'
    case 'CODEX_APP_SERVER_CLEANUP_FAILED': return 'cleanup-failed'
    case 'CODEX_APP_SERVER_REQUEST_FAILED': return 'rpc-error'
    default: return 'transport-failed'
  }
}

function epochSecondsToInstant(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const ms = value * 1000
  if (!Number.isFinite(ms) || ms > 8.64e15) return null
  return new Date(Math.round(ms)).toISOString()
}

function normalizeWindow(windowRef: string, value: unknown): ProviderQuotaWindow | null {
  if (!isRecord(value)) return null
  const duration = value['windowDurationMins']
  const used = value['usedPercent']
  return {
    windowRef,
    durationMinutes: typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0
      ? duration
      : null,
    usedPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null,
    resetsAt: epochSecondsToInstant(value['resetsAt']),
  }
}

function normalizeSnapshot(
  key: string | null,
  value: unknown,
  context: { readonly poolRef: string | null, readonly observedAt: string, readonly expiresAt: string },
): ProviderQuotaObservation | null {
  if (!isRecord(value)) return null
  const limitId = value['limitId']
  const bucketRef = isProviderQuotaRef(limitId) ? limitId : (isProviderQuotaRef(key) ? key : null)
  const model = value['normalModelSlug']
  const windows: ProviderQuotaWindow[] = []
  const seen = new Set<number>()
  for (const position of ['primary', 'secondary'] as const) {
    const window = normalizeWindow(position, value[position])
    if (window === null) continue
    // A repeated duration is ambiguous; keep the first rather than guess.
    if (window.durationMinutes !== null) {
      if (seen.has(window.durationMinutes)) continue
      seen.add(window.durationMinutes)
    }
    windows.push(window)
  }
  return {
    schema: PROVIDER_QUOTA_SCHEMA,
    provider: CODEX_QUOTA_PROVIDER,
    poolRef: context.poolRef,
    bucketRef,
    modelScope: isProviderQuotaRef(model) ? model : null,
    source: CODEX_QUOTA_RPC_METHOD,
    method: 'request-response',
    observedAt: context.observedAt,
    expiresAt: context.expiresAt,
    windows,
  }
}

/**
 * Reduces an `account/rateLimits/read` response to contract observations, or
 * null when it has no usable snapshot.
 */
export function normalizeCodexRateLimits(
  payload: unknown,
  context: { readonly poolRef: string | null, readonly observedAt: string, readonly expiresAt: string },
): ProviderQuotaObservation[] | null {
  if (!isRecord(payload)) return null
  const observations: ProviderQuotaObservation[] = []
  const byId = payload['rateLimitsByLimitId']
  if (isRecord(byId)) {
    for (const key of Object.keys(byId).sort()) {
      if (observations.length >= PROVIDER_QUOTA_LIMITS.maxObservationsPerReading) break
      const observation = normalizeSnapshot(key, byId[key], context)
      if (observation !== null
        && !observations.some((existing) => existing.bucketRef === observation.bucketRef)) {
        observations.push(observation)
      }
    }
  }
  if (observations.length === 0) {
    const single = normalizeSnapshot(null, payload['rateLimits'], context)
    if (single !== null) observations.push(single)
  }
  return observations.length > 0 ? observations : null
}

export function createCodexQuotaProbe(options: CodexQuotaProbeOptions): ProviderQuotaProbe {
  if (options.poolRef !== null && !isProviderQuotaRef(options.poolRef)) {
    throw new TypeError('Codex quota probe poolRef must be an opaque reference or null')
  }
  const hasClient = options.client !== undefined
  const hasConnect = options.connect !== undefined
  if (hasClient === hasConnect) {
    throw new TypeError('Codex quota probe needs exactly one of client or connect')
  }
  const now = options.now ?? Date.now
  const maxTimeoutMs = boundedProviderQuotaMs(options.maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS)
  const defaultTimeoutMs = boundedProviderQuotaMs(options.timeoutMs, DEFAULT_TIMEOUT_MS, maxTimeoutMs)
  const ttlMs = boundedProviderQuotaMs(options.observationTtlMs, PROVIDER_QUOTA_DEFAULT_OBSERVATION_TTL_MS, MAX_TTL_MS)
  const cleanupGraceMs = boundedProviderQuotaMs(options.cleanupGraceMs, DEFAULT_CLEANUP_GRACE_MS, MAX_CLEANUP_GRACE_MS)

  const read = async (request: ProviderQuotaReadRequest = {}): Promise<ProviderQuotaReading> => {
    const timeoutMs = boundedProviderQuotaMs(request.timeoutMs, defaultTimeoutMs, maxTimeoutMs)
    const deadline = performance.now() + timeoutMs
    const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()))
    const controller = new AbortController()
    const state: { stop: QuotaReadStop | undefined } = { stop: undefined }
    const stopReason = (): ProviderQuotaReasonCode | undefined => state.stop?.reason
    let rejectStop: ((error: QuotaReadStop) => void) | undefined
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
    stopped.catch(() => undefined)
    const halt = (reason: ProviderQuotaReasonCode) => {
      if (state.stop !== undefined) return
      const error = new QuotaReadStop(reason)
      state.stop = error
      controller.abort()
      rejectStop?.(error)
    }
    const timer = setTimeout(() => halt('timeout'), timeoutMs)
    const onAbort = () => halt('cancelled')
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped])

    let owned: CodexQuotaRpcClient | undefined
    let pendingConnect: Promise<CodexQuotaRpcClient> | undefined
    let outcome:
      | { readonly payload: unknown, readonly observedAtMs: number }
      | { readonly reason: ProviderQuotaReasonCode }
    try {
      const early = stopReason()
      if (early !== undefined) throw new QuotaReadStop(early)
      let client: CodexQuotaRpcClient
      if (options.client !== undefined) {
        client = options.client
      } else {
        pendingConnect = options.connect({ timeoutMs: remaining(), signal: controller.signal })
        owned = await bounded(pendingConnect)
        pendingConnect = undefined
        client = owned
      }
      const payload = await bounded(client.request(
        CODEX_QUOTA_RPC_METHOD,
        CODEX_QUOTA_RPC_PARAMS,
        { timeoutMs: remaining(), signal: controller.signal },
      ))
      outcome = { payload, observedAtMs: now() }
    } catch (error) {
      outcome = { reason: stopReason() ?? reasonForError(error) }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }

    // A connect that finishes after the deadline still hands back a child we own.
    if (pendingConnect !== undefined) {
      pendingConnect.then((late) => late.close()).catch(() => undefined)
    }
    if (owned !== undefined) {
      // Closing gets its own bounded grace so a timed-out read can still reap its child.
      const cleanupMs = Math.max(1, Math.ceil(deadline - performance.now())) + cleanupGraceMs
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          owned.close(),
          new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => reject(new QuotaReadStop('cleanup-failed')), cleanupMs)
          }),
        ])
      } catch {
        outcome = { reason: 'cleanup-failed' }
      } finally {
        clearTimeout(cleanupTimer)
      }
    }

    const completedAtMs = now()
    if ('reason' in outcome) {
      return providerQuotaUnavailableReading({
        provider: CODEX_QUOTA_PROVIDER,
        poolRef: options.poolRef,
        completedAtMs,
        status: 'failed',
        reason: outcome.reason,
      })
    }
    const observations = normalizeCodexRateLimits(outcome.payload, {
      poolRef: options.poolRef,
      observedAt: providerQuotaInstant(outcome.observedAtMs),
      expiresAt: providerQuotaInstant(outcome.observedAtMs + ttlMs),
    })
    if (observations === null) {
      return providerQuotaUnavailableReading({
        provider: CODEX_QUOTA_PROVIDER,
        poolRef: options.poolRef,
        completedAtMs,
        status: 'failed',
        reason: 'schema-invalid',
      })
    }
    return providerQuotaReadingFromObservations({
      provider: CODEX_QUOTA_PROVIDER,
      poolRef: options.poolRef,
      completedAtMs,
      observations,
    })
  }

  return { provider: CODEX_QUOTA_PROVIDER, read }
}
