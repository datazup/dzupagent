/**
 * Per-API-key resource quota manager (MC-S01).
 *
 * Tracks how many tokens a key has consumed inside a sliding time window so
 * the server can reject run-creation requests when the caller has already
 * burned through their per-hour budget.
 *
 * Design notes:
 *
 * - The manager is in-memory and keyed by `keyId`. Each entry stores a
 *   running token count plus the `resetAt` deadline (epoch ms) for the
 *   current window. When a check/record call arrives after the deadline,
 *   the window is rolled over lazily — there is no background timer, so
 *   the manager costs nothing when idle.
 * - `checkQuota` never mutates usage: it only answers "would we accept
 *   this run?". Recording happens in `recordUsage` after the run
 *   completes so the sliding total reflects actual consumption, not
 *   pre-run estimates.
 * - `resetExpired()` is provided as a manual sweep for long-running
 *   processes that want to reclaim memory for dormant keys. It is safe
 *   to leave uninvoked — expired windows are cleaned up automatically
 *   on the next access to that key.
 *
 * The manager is intentionally free of database or event-bus dependencies.
 * Higher layers (route handlers, run-worker) are responsible for sourcing
 * the per-key limit from `ApiKeyRecord` and feeding actual token counts
 * back in after each run.
 */

/**
 * Result returned by {@link ResourceQuotaManager.checkQuota}.
 *
 * `reason` is populated only when `allowed === false` so callers can surface
 * a useful 429 message or structured error code without probing the manager
 * further.
 */
export interface QuotaCheckResult {
  allowed: boolean
  reason?: string
}

/** Internal sliding-window bucket tracking token usage for a single key. */
interface QuotaWindow {
  tokens: number
  resetAt: number
}

/**
 * Public resource quota manager interface. The in-memory implementation is
 * the only one shipped today; the interface is factored so alternate
 * backends (Redis, Postgres) can be slotted in without touching callers.
 */
export interface ResourceQuotaManager {
  /**
   * Would a new run with the given estimated token count fit within the
   * caller's remaining hourly budget?
   *
   * @param keyId           API key id whose window should be consulted.
   * @param estimatedTokens Upper-bound token estimate for the incoming run.
   *                        Pass the per-run cap (e.g. `guardrails.maxTokens`)
   *                        when unknown so callers err on the safe side.
   * @param hourlyLimit     Optional per-hour token cap for this key. When
   *                        omitted the quota manager always allows the
   *                        request — the key has no ceiling.
   */
  checkQuota(
    keyId: string,
    estimatedTokens: number,
    hourlyLimit?: number | null,
  ): QuotaCheckResult

  /**
   * Attribute actual token usage to a key after a run completes. Callers
   * should pass the sum of input and output tokens reported by the model
   * provider.
   */
  recordUsage(keyId: string, tokensUsed: number): void

  /** Purge windows whose `resetAt` is in the past. Idempotent. */
  resetExpired(): void

  /**
   * Inspect the current token count for a key. Intended for tests and
   * debugging endpoints — not part of the hot path.
   */
  getUsage(keyId: string): { tokens: number; resetAt: number } | undefined
}

/**
 * Configuration accepted by {@link createResourceQuotaManager}.
 */
export interface ResourceQuotaManagerConfig {
  /** Length of the sliding window in milliseconds. Defaults to 1 hour. */
  windowMs?: number
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000

/**
 * Build a fresh in-memory resource quota manager. Callers typically create
 * one at app construction time and inject it into the run-route handler +
 * run-worker so both sides of the pipeline see the same counter.
 */
export function createResourceQuotaManager(
  config: ResourceQuotaManagerConfig = {},
): ResourceQuotaManager {
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS
  const windows = new Map<string, QuotaWindow>()

  function currentWindow(keyId: string, now: number): QuotaWindow | undefined {
    const entry = windows.get(keyId)
    if (!entry) return undefined
    if (entry.resetAt <= now) {
      // Window has expired — drop it so the caller starts fresh.
      windows.delete(keyId)
      return undefined
    }
    return entry
  }

  function ensureWindow(keyId: string, now: number): QuotaWindow {
    const existing = currentWindow(keyId, now)
    if (existing) return existing
    const fresh: QuotaWindow = { tokens: 0, resetAt: now + windowMs }
    windows.set(keyId, fresh)
    return fresh
  }

  return {
    checkQuota(
      keyId: string,
      estimatedTokens: number,
      hourlyLimit?: number | null,
    ): QuotaCheckResult {
      if (hourlyLimit == null || hourlyLimit <= 0) {
        return { allowed: true }
      }

      const now = Date.now()
      const window = currentWindow(keyId, now)
      const currentTokens = window?.tokens ?? 0
      const projected = currentTokens + Math.max(0, estimatedTokens)

      if (projected > hourlyLimit) {
        const resetInSec = Math.max(
          1,
          Math.ceil(((window?.resetAt ?? now + windowMs) - now) / 1000),
        )
        return {
          allowed: false,
          reason:
            `Per-key hourly token budget exhausted (${currentTokens}/${hourlyLimit} used; ` +
            `retry after ${resetInSec}s).`,
        }
      }

      return { allowed: true }
    },

    recordUsage(keyId: string, tokensUsed: number): void {
      if (!keyId || tokensUsed <= 0) return
      const now = Date.now()
      const window = ensureWindow(keyId, now)
      window.tokens += tokensUsed
    },

    resetExpired(): void {
      const now = Date.now()
      for (const [keyId, window] of windows) {
        if (window.resetAt <= now) {
          windows.delete(keyId)
        }
      }
    },

    getUsage(keyId: string): { tokens: number; resetAt: number } | undefined {
      const now = Date.now()
      const window = currentWindow(keyId, now)
      if (!window) return undefined
      return { tokens: window.tokens, resetAt: window.resetAt }
    },
  }
}
