/**
 * Tests for the useMemoryAnalytics composable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'

// ---------------------------------------------------------------------------
// Mock useApi — must be declared before the composable import
// ---------------------------------------------------------------------------

const mockGet = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({ get: mockGet }),
}))

import { useMemoryAnalytics } from '../composables/useMemoryAnalytics.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnalyticsResponse<T>(rows: T[]) {
  return {
    data: {
      rows,
      rowCount: rows.length,
      executionMs: 42,
    },
  }
}

function createComposable(options?: Parameters<typeof useMemoryAnalytics>[0]) {
  // Use effectScope to capture onUnmounted hooks
  const effectScopeRef: EffectScope = effectScope()
  const result: ReturnType<typeof useMemoryAnalytics> = effectScopeRef.run(() => useMemoryAnalytics(options))!

  return { effectScopeRef, ...result }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMemoryAnalytics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Initial state ────────────────────────────────────

  describe('initial state', () => {
    it('starts with all analytics refs as null', () => {
      const { decayTrends, namespaceStats, expiringMemories, agentPerformance, usagePatterns, duplicates } =
        createComposable()
      expect(decayTrends.value).toBeNull()
      expect(namespaceStats.value).toBeNull()
      expect(expiringMemories.value).toBeNull()
      expect(agentPerformance.value).toBeNull()
      expect(usagePatterns.value).toBeNull()
      expect(duplicates.value).toBeNull()
    })

    it('starts with isLoading false', () => {
      const { isLoading } = createComposable()
      expect(isLoading.value).toBe(false)
    })

    it('starts with error as null', () => {
      const { error } = createComposable()
      expect(error.value).toBeNull()
    })

    it('starts with isDuckDBUnavailable false', () => {
      const { isDuckDBUnavailable } = createComposable()
      expect(isDuckDBUnavailable.value).toBe(false)
    })

    it('has default namespace of lessons', () => {
      const { namespace } = createComposable()
      expect(namespace.value).toBe('lessons')
    })

    it('has default scope of {}', () => {
      const { scope: scopeRef } = createComposable()
      expect(scopeRef.value).toBe('{}')
    })

    it('has default pollIntervalMs of 30000', () => {
      const { pollIntervalMs } = createComposable()
      expect(pollIntervalMs.value).toBe(30_000)
    })
  })

  // ── Custom options ───────────────────────────────────

  describe('custom options', () => {
    it('accepts custom namespace', () => {
      const { namespace } = createComposable({ namespace: 'custom-ns' })
      expect(namespace.value).toBe('custom-ns')
    })

    it('accepts custom scope', () => {
      const c = createComposable({ scope: '{"agentId":"a1"}' })
      expect(c.scope.value).toBe('{"agentId":"a1"}')
    })

    it('accepts custom pollIntervalMs', () => {
      const { pollIntervalMs } = createComposable({ pollIntervalMs: 5_000 })
      expect(pollIntervalMs.value).toBe(5_000)
    })

    it('accepts pollIntervalMs of 0 to disable polling', () => {
      const { pollIntervalMs } = createComposable({ pollIntervalMs: 0 })
      expect(pollIntervalMs.value).toBe(0)
    })
  })

  // ── refreshAll ───────────────────────────────────────

  describe('refreshAll', () => {
    it('sets isLoading true during fetch and false after', async () => {
      const resolvers: Array<(v: unknown) => void> = []
      mockGet.mockImplementation(
        () => new Promise((resolve) => { resolvers.push(resolve) }),
      )

      const { refreshAll, isLoading } = createComposable()
      const promise = refreshAll()

      expect(isLoading.value).toBe(true)

      // Resolve all 6 pending get() calls
      for (const resolve of resolvers) {
        resolve(makeAnalyticsResponse([]))
      }
      await promise

      expect(isLoading.value).toBe(false)
    })

    it('calls API for all 6 analytics endpoints', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { refreshAll } = createComposable()
      await refreshAll()

      expect(mockGet).toHaveBeenCalledTimes(6)
    })

    it('populates reactive refs on successful fetch', async () => {
      const nsRow = { namespace: 'lessons', total_memories: 42, active_memories: 30, avg_strength: 0.8, avg_importance: 0.6, oldest_created: 0, newest_created: 1 }
      mockGet.mockImplementation((url: string) => {
        if (url.includes('namespace-stats')) {
          return Promise.resolve(makeAnalyticsResponse([nsRow]))
        }
        return Promise.resolve(makeAnalyticsResponse([]))
      })

      const { refreshAll, namespaceStats } = createComposable()
      await refreshAll()

      expect(namespaceStats.value).not.toBeNull()
      expect(namespaceStats.value!.rows).toHaveLength(1)
      expect(namespaceStats.value!.rows[0]).toEqual(nsRow)
    })

    it('sets isLoading false even when fetch throws', async () => {
      mockGet.mockRejectedValue(new Error('network error'))

      const { refreshAll, isLoading } = createComposable()
      await refreshAll()

      expect(isLoading.value).toBe(false)
    })

    it('clears error before each refresh', async () => {
      mockGet.mockRejectedValueOnce(new Error('first error'))
      const { refreshAll, error } = createComposable()

      await refreshAll()
      expect(error.value).not.toBeNull()

      mockGet.mockResolvedValue(makeAnalyticsResponse([]))
      await refreshAll()
      // Error is cleared at the start of refreshAll even though individual fetchers may set it
      // The second call succeeds so error should be null (from the last handleFetchError)
      // Actually, error.value is set to null at the beginning of refreshAll
      expect(error.value).toBeNull()
    })
  })

  // ── Individual fetch functions ───────────────────────

  describe('individual fetch functions', () => {
    it('fetchDecayTrends populates decayTrends', async () => {
      const point = { namespace: 'lessons', bucket: '2026-01-01', avg_strength: 0.5, min_strength: 0.1, max_strength: 0.9, count: 10 }
      mockGet.mockResolvedValue(makeAnalyticsResponse([point]))

      const { fetchDecayTrends, decayTrends } = createComposable()
      await fetchDecayTrends()

      expect(decayTrends.value!.rows[0]).toEqual(point)
    })

    it('fetchExpiringMemories populates expiringMemories', async () => {
      const row = { id: 'm1', namespace: 'lessons', decay_strength: 0.1, expires_in_ms: 1000 }
      mockGet.mockResolvedValue(makeAnalyticsResponse([row]))

      const { fetchExpiringMemories, expiringMemories } = createComposable()
      await fetchExpiringMemories()

      expect(expiringMemories.value!.rows).toHaveLength(1)
    })

    it('fetchAgentPerformance populates agentPerformance', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([{ agent_id: 'a1', total_memories: 5, avg_importance: 0.7, categories: [], active_ratio: 0.8 }]))

      const { fetchAgentPerformance, agentPerformance } = createComposable()
      await fetchAgentPerformance()

      expect(agentPerformance.value).not.toBeNull()
    })

    it('fetchUsagePatterns populates usagePatterns', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { fetchUsagePatterns, usagePatterns } = createComposable()
      await fetchUsagePatterns()

      expect(usagePatterns.value).not.toBeNull()
    })

    it('fetchDuplicates populates duplicates', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { fetchDuplicates, duplicates } = createComposable()
      await fetchDuplicates()

      expect(duplicates.value).not.toBeNull()
    })
  })

  // ── Error handling ───────────────────────────────────

  describe('error handling', () => {
    it('sets error message on fetch failure', async () => {
      mockGet.mockRejectedValue(new Error('fetch failed'))

      const { fetchDecayTrends, error } = createComposable()
      await fetchDecayTrends()

      expect(error.value).toBe('fetch failed')
    })

    it('sets isDuckDBUnavailable on 503 status', async () => {
      const err = Object.assign(new Error('Service Unavailable'), { status: 503 })
      mockGet.mockRejectedValue(err)

      const { fetchNamespaceStats, isDuckDBUnavailable, error } = createComposable()
      await fetchNamespaceStats()

      expect(isDuckDBUnavailable.value).toBe(true)
      expect(error.value).toContain('DuckDB')
    })

    it('handles non-Error thrown values', async () => {
      mockGet.mockRejectedValue('string error')

      const { fetchDecayTrends, error } = createComposable()
      await fetchDecayTrends()

      expect(error.value).toBe('string error')
    })
  })

  // ── Polling ──────────────────────────────────────────

  describe('polling', () => {
    it('startPolling triggers periodic refreshAll', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { startPolling, stopPolling } = createComposable({ pollIntervalMs: 1000 })
      startPolling()

      // Advance 1 second — first poll fires
      await vi.advanceTimersByTimeAsync(1000)
      const callsAfterFirstPoll = mockGet.mock.calls.length

      // Advance another second — second poll fires
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockGet.mock.calls.length).toBeGreaterThan(callsAfterFirstPoll)

      stopPolling()
    })

    it('stopPolling clears the interval', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { startPolling, stopPolling } = createComposable({ pollIntervalMs: 1000 })
      startPolling()

      await vi.advanceTimersByTimeAsync(1000)
      const callsAfterPoll = mockGet.mock.calls.length

      stopPolling()

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockGet.mock.calls.length).toBe(callsAfterPoll)
    })

    it('setPollInterval updates interval and restarts polling', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { setPollInterval, stopPolling } = createComposable({ pollIntervalMs: 10_000 })
      setPollInterval(500)

      await vi.advanceTimersByTimeAsync(500)
      expect(mockGet.mock.calls.length).toBeGreaterThan(0)

      stopPolling()
    })

    it('setPollInterval(0) disables polling', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { startPolling, setPollInterval } = createComposable({ pollIntervalMs: 1000 })
      startPolling()

      await vi.advanceTimersByTimeAsync(1000)
      const callsBeforeDisable = mockGet.mock.calls.length

      setPollInterval(0)

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockGet.mock.calls.length).toBe(callsBeforeDisable)
    })

    it('stopPolling prevents further refresh calls', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { startPolling, stopPolling } = createComposable({ pollIntervalMs: 1000 })
      startPolling()

      await vi.advanceTimersByTimeAsync(1000)
      const callsAfterFirstPoll = mockGet.mock.calls.length
      expect(callsAfterFirstPoll).toBeGreaterThan(0)

      stopPolling()

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockGet.mock.calls.length).toBe(callsAfterFirstPoll)
    })
  })

  // ── Query params ─────────────────────────────────────

  describe('query parameters', () => {
    it('includes namespace in API calls', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { fetchDecayTrends } = createComposable({ namespace: 'my-ns' })
      await fetchDecayTrends()

      const url = mockGet.mock.calls[0]![0] as string
      expect(url).toContain('namespace=my-ns')
    })

    it('includes scope in API calls', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { fetchDecayTrends } = createComposable({ scope: '{"agentId":"a1"}' })
      await fetchDecayTrends()

      const url = mockGet.mock.calls[0]![0] as string
      expect(url).toContain('scope=')
    })

    it('fetchDecayTrends includes window parameter', async () => {
      mockGet.mockResolvedValue(makeAnalyticsResponse([]))

      const { fetchDecayTrends } = createComposable()
      await fetchDecayTrends('week')

      const url = mockGet.mock.calls[0]![0] as string
      expect(url).toContain('window=week')
    })
  })
})
