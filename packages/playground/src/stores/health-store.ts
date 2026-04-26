/**
 * Health store -- monitors server health, readiness, and metrics.
 *
 * Auto-polls the health endpoint at a configurable interval
 * to keep the sidebar status indicator up to date.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { HealthStatus, HealthReady, HealthMetrics, RegistryFleetHealthDto } from '../types.js'
import { useApi } from '../composables/useApi.js'

const POLL_INTERVAL_MS = 30_000

export const useHealthStore = defineStore('health', () => {
  const { get } = useApi()

  // ── State ─────────────────────────────────────────
  const health = ref<HealthStatus | null>(null)
  const ready = ref<HealthReady | null>(null)
  const metrics = ref<HealthMetrics | null>(null)
  const fleetHealth = ref<RegistryFleetHealthDto | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // ── Getters ───────────────────────────────────────
  const isHealthy = computed(() => health.value?.status === 'ok')
  const isReady = computed(() => ready.value?.ready === true)

  const uptimeFormatted = computed(() => {
    const s = health.value?.uptime
    if (s == null) return '--'
    if (s < 60) return `${Math.round(s)}s`
    if (s < 3600) return `${Math.round(s / 60)}m`
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return `${h}h ${m}m`
  })

  const readinessChecks = computed(() => {
    if (!ready.value?.checks) return []
    return Object.entries(ready.value.checks).map(([name, check]) => ({
      name,
      status: check.status,
      message: check.message,
    }))
  })

  // ── Actions ───────────────────────────────────────

  async function fetchHealth(): Promise<void> {
    try {
      health.value = await get<HealthStatus>('/api/health')
    } catch {
      health.value = { status: 'error' }
    }
  }

  async function fetchReady(): Promise<void> {
    try {
      ready.value = await get<HealthReady>('/api/health/ready')
    } catch {
      ready.value = { ready: false, checks: {} }
    }
  }

  async function fetchMetrics(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      metrics.value = await get<HealthMetrics>('/api/health/metrics')
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch metrics'
    } finally {
      isLoading.value = false
    }
  }

  /** Fetch canonical registry/fleet health. Returns null if registry is not configured. */
  async function fetchRegistryHealth(): Promise<void> {
    try {
      const resp = await get<{ data: RegistryFleetHealthDto }>('/api/registry/health')
      fleetHealth.value = resp.data
    } catch {
      fleetHealth.value = null
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([fetchHealth(), fetchReady()])
  }

  function startPolling(): void {
    stopPolling()
    void refreshAll()
    pollTimer = setInterval(() => { void refreshAll() }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    health,
    ready,
    metrics,
    fleetHealth,
    isLoading,
    error,
    isHealthy,
    isReady,
    uptimeFormatted,
    readinessChecks,
    fetchHealth,
    fetchReady,
    fetchMetrics,
    fetchRegistryHealth,
    refreshAll,
    startPolling,
    stopPolling,
  }
})
