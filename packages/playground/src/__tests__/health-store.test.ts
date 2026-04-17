/**
 * Tests for the health Pinia store.
 *
 * Covers: fetchHealth, fetchReady, fetchMetrics, refreshAll,
 * startPolling/stopPolling, computed getters (isHealthy, isReady,
 * uptimeFormatted, readinessChecks), and error handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHealthStore } from '../stores/health-store.js'

const getMock = vi.fn()

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: getMock,
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('health-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with null state', () => {
    const store = useHealthStore()
    expect(store.health).toBeNull()
    expect(store.ready).toBeNull()
    expect(store.metrics).toBeNull()
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
    expect(store.isHealthy).toBe(false)
    expect(store.isReady).toBe(false)
  })

  // ── fetchHealth ─────────────────────────────────────

  it('fetchHealth sets health on success', async () => {
    getMock.mockResolvedValueOnce({ status: 'ok', uptime: 120 })
    const store = useHealthStore()
    await store.fetchHealth()
    expect(store.health).toEqual({ status: 'ok', uptime: 120 })
    expect(store.isHealthy).toBe(true)
  })

  it('fetchHealth sets error health on failure', async () => {
    getMock.mockRejectedValueOnce(new Error('Network error'))
    const store = useHealthStore()
    await store.fetchHealth()
    expect(store.health).toEqual({ status: 'error' })
    expect(store.isHealthy).toBe(false)
  })

  // ── fetchReady ──────────────────────────────────────

  it('fetchReady sets ready on success', async () => {
    getMock.mockResolvedValueOnce({
      ready: true,
      checks: {
        database: { status: 'ok', message: 'Connected' },
      },
    })
    const store = useHealthStore()
    await store.fetchReady()
    expect(store.ready?.ready).toBe(true)
    expect(store.isReady).toBe(true)
  })

  it('fetchReady sets fallback on failure', async () => {
    getMock.mockRejectedValueOnce(new Error('timeout'))
    const store = useHealthStore()
    await store.fetchReady()
    expect(store.ready).toEqual({ ready: false, checks: {} })
    expect(store.isReady).toBe(false)
  })

  // ── fetchMetrics ────────────────────────────────────

  it('fetchMetrics sets metrics and loading state', async () => {
    const metricsData = { requestCount: 100, avgLatencyMs: 45 }
    getMock.mockResolvedValueOnce(metricsData)
    const store = useHealthStore()
    await store.fetchMetrics()
    expect(store.metrics).toEqual(metricsData)
    expect(store.isLoading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('fetchMetrics sets error on failure with Error instance', async () => {
    getMock.mockRejectedValueOnce(new Error('Metrics unavailable'))
    const store = useHealthStore()
    await store.fetchMetrics()
    expect(store.error).toBe('Metrics unavailable')
    expect(store.isLoading).toBe(false)
  })

  it('fetchMetrics sets fallback error for non-Error exceptions', async () => {
    getMock.mockRejectedValueOnce('string error')
    const store = useHealthStore()
    await store.fetchMetrics()
    expect(store.error).toBe('Failed to fetch metrics')
    expect(store.isLoading).toBe(false)
  })

  // ── refreshAll ──────────────────────────────────────

  it('refreshAll calls both fetchHealth and fetchReady', async () => {
    getMock
      .mockResolvedValueOnce({ status: 'ok', uptime: 60 })
      .mockResolvedValueOnce({ ready: true, checks: {} })
    const store = useHealthStore()
    await store.refreshAll()
    expect(getMock).toHaveBeenCalledWith('/api/health')
    expect(getMock).toHaveBeenCalledWith('/api/health/ready')
  })

  // ── Getters ─────────────────────────────────────────

  it('uptimeFormatted returns -- for null health', () => {
    const store = useHealthStore()
    expect(store.uptimeFormatted).toBe('--')
  })

  it('uptimeFormatted formats seconds correctly', async () => {
    getMock.mockResolvedValueOnce({ status: 'ok', uptime: 30 })
    const store = useHealthStore()
    await store.fetchHealth()
    expect(store.uptimeFormatted).toBe('30s')
  })

  it('uptimeFormatted formats minutes correctly', async () => {
    getMock.mockResolvedValueOnce({ status: 'ok', uptime: 300 })
    const store = useHealthStore()
    await store.fetchHealth()
    expect(store.uptimeFormatted).toBe('5m')
  })

  it('uptimeFormatted formats hours and minutes correctly', async () => {
    getMock.mockResolvedValueOnce({ status: 'ok', uptime: 7500 })
    const store = useHealthStore()
    await store.fetchHealth()
    expect(store.uptimeFormatted).toBe('2h 5m')
  })

  it('readinessChecks returns empty array when no checks', () => {
    const store = useHealthStore()
    expect(store.readinessChecks).toEqual([])
  })

  it('readinessChecks parses check entries', async () => {
    getMock.mockResolvedValueOnce({
      ready: true,
      checks: {
        database: { status: 'ok', message: 'Connected' },
        redis: { status: 'degraded', message: 'Slow' },
      },
    })
    const store = useHealthStore()
    await store.fetchReady()
    expect(store.readinessChecks).toEqual([
      { name: 'database', status: 'ok', message: 'Connected' },
      { name: 'redis', status: 'degraded', message: 'Slow' },
    ])
  })

  // ── Polling ─────────────────────────────────────────

  it('startPolling calls refreshAll immediately', async () => {
    getMock
      .mockResolvedValue({ status: 'ok', uptime: 1 })
    const store = useHealthStore()
    store.startPolling()
    // Should trigger an immediate call
    expect(getMock).toHaveBeenCalled()
    store.stopPolling()
  })

  it('stopPolling clears the interval', () => {
    getMock.mockResolvedValue({ status: 'ok' })
    const store = useHealthStore()
    store.startPolling()
    store.stopPolling()
    // After stopping, advancing timers should not trigger more calls
    const callCount = getMock.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(getMock.mock.calls.length).toBe(callCount)
  })

  it('startPolling re-calls after interval', async () => {
    getMock.mockResolvedValue({ status: 'ok' })
    const store = useHealthStore()
    store.startPolling()
    const initialCalls = getMock.mock.calls.length

    // Advance past the 30s polling interval
    vi.advanceTimersByTime(30_001)
    expect(getMock.mock.calls.length).toBeGreaterThan(initialCalls)
    store.stopPolling()
  })
})
