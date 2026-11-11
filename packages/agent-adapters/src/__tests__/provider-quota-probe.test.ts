import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import {
  PROVIDER_QUOTA_SCHEMA,
  validateProviderQuotaReading,
  type ProviderQuotaObservation,
} from '@dzupagent/runtime-contracts'

import * as root from '../index.js'
import * as providers from '../providers.js'
import {
  InMemoryProviderQuotaObservationStore,
  recordProviderQuotaReading,
} from '../quota/provider-quota-observation-store.js'
import {
  boundedProviderQuotaMs,
  providerQuotaReadingFromObservations,
  providerQuotaUnavailableReading,
} from '../quota/provider-quota-probe.js'

const T0 = Date.parse('2026-11-11T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function observation(overrides: Partial<ProviderQuotaObservation> = {}): ProviderQuotaObservation {
  return {
    schema: PROVIDER_QUOTA_SCHEMA,
    provider: 'claude',
    poolRef: 'pool-shared',
    bucketRef: null,
    modelScope: null,
    source: 'claude-code.status-line.rate_limits',
    method: 'host-ingestion',
    observedAt: iso(T0),
    expiresAt: iso(T0 + 300_000),
    windows: [{ windowRef: 'five_hour', durationMinutes: 300, usedPercent: 12, resetsAt: iso(T0 + 3_600_000) }],
    ...overrides,
  }
}

describe('provider quota observation store', () => {
  it('holds a shared pool once, whatever profile or host observed it', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    expect(store.put(observation())).toEqual({ accepted: true, replaced: false })
    expect(store.put(observation({ observedAt: iso(T0 + 1000), expiresAt: iso(T0 + 301_000) }))).toEqual({ accepted: true, replaced: true })
    expect(store.size).toBe(1)
    expect(store.read('claude', 'pool-shared')).toHaveLength(1)
    expect(store.read('claude', 'pool-shared')[0]!.observedAt).toBe(iso(T0 + 1000))
  })

  it('keeps separate buckets of one pool apart', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    store.put(observation({ provider: 'codex', poolRef: 'acct', bucketRef: 'codex' }))
    store.put(observation({ provider: 'codex', poolRef: 'acct', bucketRef: 'codex_other' }))
    expect(store.read('codex', 'acct').map((entry) => entry.bucketRef)).toEqual(['codex', 'codex_other'])
  })

  it('never lets an older observation replace a newer one, and reads never refresh it', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    store.put(observation({ observedAt: iso(T0 + 5000), expiresAt: iso(T0 + 305_000) }))
    expect(store.put(observation())).toEqual({ accepted: false, reason: 'older-than-stored' })
    const first = store.read('claude', 'pool-shared')[0]
    const second = store.read('claude', 'pool-shared')[0]
    expect(second).toBe(first)
    expect(second!.expiresAt).toBe(iso(T0 + 305_000))
  })

  it('refuses unknown pools, malformed input and one pool claimed by two providers', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    expect(store.put(observation({ poolRef: null }))).toEqual({ accepted: false, reason: 'pool-unknown' })
    expect(store.put(observation({ windows: [{ windowRef: 'five_hour', durationMinutes: 300, usedPercent: -3, resetsAt: null }] }))).toEqual({ accepted: false, reason: 'malformed' })
    store.put(observation())
    expect(store.put(observation({ provider: 'codex' }))).toEqual({ accepted: false, reason: 'pool-provider-mismatch' })
  })

  it('stores only allowlisted fields, frozen', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    const withExtras = {
      ...observation(),
      rawPayload: { secret: 'token-like-value' },
      windows: [{ ...observation().windows[0]!, accountEmail: 'someone@example.invalid' }],
    }
    store.put(withExtras as ProviderQuotaObservation)
    const stored = store.read('claude', 'pool-shared')[0]!
    expect(JSON.stringify(stored)).not.toContain('token-like-value')
    expect(JSON.stringify(stored)).not.toContain('example.invalid')
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.windows[0])).toBe(true)
  })

  it('is bounded, evicting the oldest observation', () => {
    const store = new InMemoryProviderQuotaObservationStore({ maxEntries: 2 })
    store.put(observation({ poolRef: 'p1' }))
    store.put(observation({ poolRef: 'p2', observedAt: iso(T0 + 1), expiresAt: iso(T0 + 300_001) }))
    store.put(observation({ poolRef: 'p3', observedAt: iso(T0 + 2), expiresAt: iso(T0 + 300_002) }))
    expect(store.size).toBe(2)
    expect(store.read('claude', 'p1')).toEqual([])
    expect(store.put(observation({ provider: 'codex', poolRef: 'p1', observedAt: iso(T0 + 3), expiresAt: iso(T0 + 300_003) })).accepted).toBe(true)
  })

  it('records the observations of a reading', () => {
    const store = new InMemoryProviderQuotaObservationStore()
    const reading = providerQuotaReadingFromObservations({ provider: 'claude', poolRef: 'pool-shared', completedAtMs: T0, observations: [observation()] })
    expect(recordProviderQuotaReading(store, reading)).toBe(1)
  })
})

describe('provider quota readings', () => {
  it('classifies current, stale and missing evidence', () => {
    const base = { provider: 'claude', poolRef: 'pool-shared' }
    const current = providerQuotaReadingFromObservations({ ...base, completedAtMs: T0 + 1, observations: [observation()] })
    const stale = providerQuotaReadingFromObservations({ ...base, completedAtMs: T0 + 300_000, observations: [observation()] })
    const none = providerQuotaReadingFromObservations({ ...base, completedAtMs: T0, observations: [] })
    expect(current.status).toBe('current')
    expect(stale).toMatchObject({ status: 'stale', reason: 'stale' })
    expect(none).toMatchObject({ status: 'unavailable', reason: 'no-observation', observations: [] })
    for (const reading of [current, stale, none]) expect(validateProviderQuotaReading(reading)).toEqual([])
    const failed = providerQuotaUnavailableReading({ ...base, completedAtMs: T0, status: 'failed', reason: 'timeout' })
    expect(validateProviderQuotaReading(failed)).toEqual([])
  })

  it('bounds durations', () => {
    expect(boundedProviderQuotaMs(undefined, 100, 500)).toBe(100)
    expect(boundedProviderQuotaMs(10_000, 100, 500)).toBe(500)
    expect(boundedProviderQuotaMs(-1, 100, 500)).toBe(100)
    expect(boundedProviderQuotaMs(Number.NaN, 100, 500)).toBe(100)
  })
})

const quotaExports = [
  'InMemoryProviderQuotaObservationStore',
  'recordProviderQuotaReading',
  'providerQuotaReadingFromObservations',
  'providerQuotaUnavailableReading',
  'createCodexQuotaProbe',
  'normalizeCodexRateLimits',
  'createClaudeQuotaObservationSource',
  'parseClaudeStatusLineRateLimits',
] as const

describe('provider quota exports', () => {
  it('resolves through the package root and the providers subpath', () => {
    for (const name of quotaExports) {
      expect(typeof (root as Record<string, unknown>)[name]).toBe('function')
      expect((providers as Record<string, unknown>)[name]).toBe((root as Record<string, unknown>)[name])
    }
  })

  const dist = join(process.cwd(), 'dist')
  const built = existsSync(join(dist, 'index.js')) && existsSync(join(dist, 'providers.js'))
  it.skipIf(!built)('resolves from the built entry points', async () => {
    const builtRoot = await import(pathToFileURL(join(dist, 'index.js')).href) as Record<string, unknown>
    const builtProviders = await import(pathToFileURL(join(dist, 'providers.js')).href) as Record<string, unknown>
    for (const name of quotaExports) {
      expect(typeof builtRoot[name]).toBe('function')
      expect(typeof builtProviders[name]).toBe('function')
    }
    const declarations = readFileSync(join(dist, 'index.d.ts'), 'utf8')
    for (const name of [...quotaExports, 'ProviderQuotaProbe', 'CodexQuotaRpcClient']) {
      expect(declarations).toContain(name)
    }
  })
})
