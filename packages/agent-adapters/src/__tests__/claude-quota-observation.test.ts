import { describe, expect, it } from 'vitest'
import {
  PROVIDER_QUOTA_WINDOW_MINUTES,
  assessProviderQuotaReading,
  validateProviderQuotaReading,
} from '@dzupagent/runtime-contracts'

import {
  CLAUDE_QUOTA_SOURCE,
  createClaudeQuotaObservationSource,
  parseClaudeStatusLineRateLimits,
} from '../claude/claude-quota-observation.js'
import { InMemoryProviderQuotaObservationStore } from '../quota/provider-quota-observation-store.js'

const T0 = Date.parse('2026-11-11T10:00:00.000Z')
const FIVE = PROVIDER_QUOTA_WINDOW_MINUTES.fiveHours
const SEVEN = PROVIDER_QUOTA_WINDOW_MINUTES.sevenDays
const both = { requiredWindowMinutes: [FIVE, SEVEN] }

/** Fixture shaped like the documented Claude Code status-line input. */
const statusLine = {
  hook_event_name: 'Status',
  session_id: 'session-private-id',
  transcript_path: '/home/someone/.claude/projects/x/transcript.jsonl',
  cwd: '/home/someone/project',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  workspace: { current_dir: '/home/someone/project', project_dir: '/home/someone/project' },
  cost: { total_cost_usd: 1.23, total_duration_ms: 4000 },
  context_window: { total_input_tokens: 15_000, context_window_size: 200_000, used_percentage: 7.5 },
  rate_limits: {
    five_hour: { used_percentage: 0, resets_at: (T0 + 3_600_000) / 1000 },
    seven_day: { used_percentage: 41.2, resets_at: (T0 + 4 * 86_400_000) / 1000 },
  },
}

function clock(start = T0) {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}

describe('Claude status-line rate limits', () => {
  it('parses both documented windows and nothing else', () => {
    expect(parseClaudeStatusLineRateLimits(statusLine)).toEqual([
      { windowRef: 'five_hour', durationMinutes: FIVE, usedPercent: 0, resetsAt: new Date(T0 + 3_600_000).toISOString() },
      { windowRef: 'seven_day', durationMinutes: SEVEN, usedPercent: 41.2, resetsAt: new Date(T0 + 4 * 86_400_000).toISOString() },
    ])
  })

  it('keeps independently missing windows and fields', () => {
    expect(parseClaudeStatusLineRateLimits({ rate_limits: { seven_day: { used_percentage: 5 } } })).toEqual([
      { windowRef: 'seven_day', durationMinutes: SEVEN, usedPercent: 5, resetsAt: null },
    ])
    expect(parseClaudeStatusLineRateLimits({ rate_limits: { five_hour: { used_percentage: 'high', resets_at: 'soon' } } })).toEqual([
      { windowRef: 'five_hour', durationMinutes: FIVE, usedPercent: null, resetsAt: null },
    ])
  })

  it('finds no observation when the host delivered none', () => {
    for (const input of [null, 'text', {}, { rate_limits: null }, { rate_limits: {} }, { context_window: { used_percentage: 99 } }]) {
      expect(parseClaudeStatusLineRateLimits(input)).toBeNull()
    }
  })
})

describe('Claude quota observation source', () => {
  it('reports unavailable before any host-delivered observation', async () => {
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: () => T0 })
    const reading = await source.probe.read()
    expect(reading).toMatchObject({ provider: 'claude', status: 'unavailable', reason: 'no-observation', observations: [] })
    expect(assessProviderQuotaReading(reading, { ...both, now: new Date(T0).toISOString() }).map((entry) => [entry.state, entry.reason])).toEqual([['unknown', 'no-observation'], ['unknown', 'no-observation']])
  })

  it('ingests a fixture and reads it back through the common interface', async () => {
    const time = clock()
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: time.now })
    const ingested = source.ingest(statusLine)
    expect(ingested.accepted).toBe(true)
    time.advance(1000)
    const reading = await source.probe.read()
    expect(validateProviderQuotaReading(reading)).toEqual([])
    expect(reading.status).toBe('current')
    expect(reading.completedAt).toBe(new Date(T0 + 1000).toISOString())
    expect(reading.observations[0]).toMatchObject({ observedAt: new Date(T0).toISOString(), source: CLAUDE_QUOTA_SOURCE, method: 'host-ingestion', poolRef: 'claude-max-a' })
    const [five, seven] = assessProviderQuotaReading(reading, { ...both, now: reading.completedAt })
    expect(five).toMatchObject({ state: 'available', usedPercent: 0 })
    expect(seven).toMatchObject({ state: 'available', usedPercent: 41.2 })
  })

  it('stores no session, path, cost, token or context data', async () => {
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: () => T0 })
    source.ingest(statusLine)
    const text = JSON.stringify(await source.probe.read())
    for (const leaked of ['session-private-id', '/home/someone', 'total_cost', '1.23', '15000', 'context', 'Opus']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('goes stale on schedule; repeated reads never extend validity', async () => {
    const time = clock()
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: time.now, observationTtlMs: 60_000 })
    source.ingest(statusLine)
    for (let index = 0; index < 5; index += 1) {
      time.advance(10_000)
      const reading = await source.probe.read()
      expect(reading.status).toBe('current')
      expect(reading.observations[0]!.expiresAt).toBe(new Date(T0 + 60_000).toISOString())
    }
    time.advance(10_000)
    const stale = await source.probe.read()
    expect(stale).toMatchObject({ status: 'stale', reason: 'stale' })
    expect(assessProviderQuotaReading(stale, { ...both, now: stale.completedAt }).map((entry) => [entry.state, entry.reason])).toEqual([['unknown', 'stale'], ['unknown', 'stale']])
  })

  it('does not report exhausted or reset-passed windows as available', async () => {
    const time = clock()
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: time.now, observationTtlMs: 3_600_000 })
    source.ingest({ rate_limits: { five_hour: { used_percentage: 100, resets_at: (T0 + 600_000) / 1000 }, seven_day: { used_percentage: 12 } } })
    const [five] = assessProviderQuotaReading(await source.probe.read(), { ...both, now: new Date(T0).toISOString() })
    expect(five).toMatchObject({ state: 'exhausted' })
    time.advance(600_000)
    const [afterReset] = assessProviderQuotaReading(await source.probe.read(), { ...both, now: new Date(time.now()).toISOString() })
    expect(afterReset).toMatchObject({ state: 'unknown', reason: 'reset-passed' })
  })

  it('refuses future, older and empty deliveries without touching the stored evidence', async () => {
    const source = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', now: () => T0 })
    expect(source.ingest(statusLine, { observedAtMs: T0 + 10 * 60_000 })).toEqual({ accepted: false, reason: 'future-observation' })
    expect(source.ingest(statusLine, { observedAtMs: T0 - 1000 }).accepted).toBe(true)
    expect(source.ingest(statusLine, { observedAtMs: T0 - 5000 })).toEqual({ accepted: false, reason: 'older-than-stored' })
    expect(source.ingest({ cost: { total_cost_usd: 2 } })).toEqual({ accepted: false, reason: 'no-observation' })
    const reading = await source.probe.read()
    expect(reading.observations).toHaveLength(1)
    expect(reading.observations[0]!.observedAt).toBe(new Date(T0 - 1000).toISOString())
  })

  it('holds one shared pool once across profiles and hosts', async () => {
    const store = new InMemoryProviderQuotaObservationStore()
    const time = clock()
    const laptop = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', store, now: time.now })
    const server = createClaudeQuotaObservationSource({ poolRef: 'claude-max-a', store, now: time.now })
    laptop.ingest(statusLine)
    time.advance(1000)
    server.ingest({ rate_limits: { five_hour: { used_percentage: 3 }, seven_day: { used_percentage: 42 } } })
    expect(store.size).toBe(1)
    const fromLaptop = await laptop.probe.read()
    expect(fromLaptop.observations).toHaveLength(1)
    expect(fromLaptop.observations[0]!.windows[0]!.usedPercent).toBe(3)
    expect((await server.probe.read()).observations).toEqual(fromLaptop.observations)
  })

  it('requires an opaque pool reference', () => {
    expect(() => createClaudeQuotaObservationSource({ poolRef: '' })).toThrow(TypeError)
    expect(() => createClaudeQuotaObservationSource({ poolRef: 'free text pool' })).toThrow(TypeError)
  })
})
