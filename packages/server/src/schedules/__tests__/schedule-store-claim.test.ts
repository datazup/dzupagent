/**
 * P4 HA scheduling — claim-tick semantics on InMemoryScheduleStore.
 *
 * Verifies the durable atomic claim that lets K nodes share one schedule store
 * yet fire a due occurrence exactly once:
 *   - save() computes nextRunAt from the cron expression when not provided
 *   - claimDue() returns each due schedule to at most one caller (the winner
 *     advances nextRunAt so a second concurrent call sees nothing)
 *   - skipIfRunning excludes a schedule whose previous run is still in flight
 *   - not-yet-due and disabled schedules are never claimed
 *   - catch-up: default skip-and-realign fires once and jumps to the next
 *     FUTURE occurrence; opt-in bounded backfill replays missed occurrences
 *   - markFired clears running and records lastFiredAt
 *
 * A fixed injected clock makes nextRunAt deterministic.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryScheduleStore } from '../schedule-store.js'

// Cron "*/5 * * * *" → every 5 minutes. Anchor the clock just after a slot.
const EVERY_5_MIN = '*/5 * * * *'

function storeAt(iso: string): InMemoryScheduleStore {
  let clock = new Date(iso)
  const store = new InMemoryScheduleStore(() => clock)
  return Object.assign(store, {
    setClock(next: string) {
      clock = new Date(next)
    },
  })
}

async function saveDue(
  store: InMemoryScheduleStore,
  id: string,
  overrides: Partial<{ enabled: boolean; nextRunAt: string | null }> = {}
) {
  return store.save({
    id,
    name: id,
    cronExpression: EVERY_5_MIN,
    workflowText: 'do work',
    enabled: overrides.enabled ?? true,
    ...(overrides.nextRunAt !== undefined
      ? { nextRunAt: overrides.nextRunAt }
      : {}),
  })
}

describe('InMemoryScheduleStore — save computes nextRunAt', () => {
  it('derives nextRunAt from the cron expression when not provided', async () => {
    const store = storeAt('2026-06-17T10:02:00.000Z')
    const rec = await saveDue(store, 's1')
    // Next */5 slot after 10:02 is 10:05.
    expect(rec.nextRunAt).toBe('2026-06-17T10:05:00.000Z')
  })

  it('honours an explicitly provided nextRunAt', async () => {
    const store = storeAt('2026-06-17T10:02:00.000Z')
    const rec = await saveDue(store, 's1', {
      nextRunAt: '2026-06-17T09:00:00.000Z',
    })
    expect(rec.nextRunAt).toBe('2026-06-17T09:00:00.000Z')
  })
})

describe('InMemoryScheduleStore — claimDue atomic single-fire', () => {
  it('claims a due schedule exactly once across two sequential calls', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    // nextRunAt 10:05 (due, since now is 10:06).
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:05:00.000Z' })

    const now = new Date('2026-06-17T10:06:00.000Z')
    const first = await store.claimDue(now, {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    const second = await store.claimDue(now, {
      limit: 10,
      claimerId: 'node-b',
      skipIfRunning: true,
    })

    expect(first).toHaveLength(1)
    expect(first[0]!.id).toBe('s1')
    expect(first[0]!.claimedBy).toBe('node-a')
    expect(first[0]!.occurrence.toISOString()).toBe('2026-06-17T10:05:00.000Z')
    // Winner advanced nextRunAt to the next future slot.
    expect(first[0]!.nextRunAt).toBe('2026-06-17T10:10:00.000Z')
    // Second caller sees nothing — already advanced past now.
    expect(second).toHaveLength(0)
  })

  it('excludes a running schedule when skipIfRunning is set', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    await store.update('s1', { running: true })

    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(0)
  })

  it('claims a running schedule when skipIfRunning is false', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    await store.update('s1', { running: true })

    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: false,
    })
    expect(claimed).toHaveLength(1)
  })

  it('does not claim a schedule that is not yet due', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:10:00.000Z' })
    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(0)
  })

  it('does not claim a disabled schedule', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', {
      enabled: false,
      nextRunAt: '2026-06-17T10:05:00.000Z',
    })
    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(0)
  })

  it('respects the limit', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    await saveDue(store, 's2', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    await saveDue(store, 's3', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 2,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(2)
  })
})

describe('InMemoryScheduleStore — catch-up', () => {
  it('default skip-and-realign fires once and jumps to the next future slot', async () => {
    // nextRunAt is 30 min (6 slots) in the past relative to now.
    const store = storeAt('2026-06-17T10:32:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:00:00.000Z' })

    const claimed = await store.claimDue(new Date('2026-06-17T10:32:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(1)
    // Fired exactly once for the original occurrence.
    expect(claimed[0]!.occurrence.toISOString()).toBe(
      '2026-06-17T10:00:00.000Z'
    )
    // Realigned to next FUTURE slot (10:35), no backfill.
    expect(claimed[0]!.nextRunAt).toBe('2026-06-17T10:35:00.000Z')
  })

  it('opt-in bounded backfill replays up to maxCatchUp missed occurrences', async () => {
    const store = storeAt('2026-06-17T10:32:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:00:00.000Z' })

    // Missed slots from 10:00: 10:00,10:05,10:10,... — backfill 3.
    const claimed = await store.claimDue(new Date('2026-06-17T10:32:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
      maxCatchUp: 3,
    })
    expect(claimed).toHaveLength(3)
    expect(claimed.map((c) => c.occurrence.toISOString())).toEqual([
      '2026-06-17T10:00:00.000Z',
      '2026-06-17T10:05:00.000Z',
      '2026-06-17T10:10:00.000Z',
    ])
  })
})

describe('InMemoryScheduleStore — markFired', () => {
  it('clears running and records lastFiredAt', async () => {
    const store = storeAt('2026-06-17T10:06:00.000Z')
    await saveDue(store, 's1', { nextRunAt: '2026-06-17T10:05:00.000Z' })
    await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })

    await store.markFired('s1', new Date('2026-06-17T10:05:00.000Z'), 'run-1')
    const rec = await store.get('s1')
    expect(rec?.running).toBe(false)
    expect(rec?.lastFiredAt).toBe('2026-06-17T10:06:00.000Z')
  })
})
