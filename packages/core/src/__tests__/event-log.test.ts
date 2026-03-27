import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryEventLog, EventLogSink } from '../persistence/event-log.js'
import { createEventBus } from '../events/event-bus.js'

describe('InMemoryEventLog', () => {
  let log: InMemoryEventLog

  beforeEach(() => {
    log = new InMemoryEventLog()
  })

  it('appends events with auto-incrementing seq and timestamp', async () => {
    const e1 = await log.append({ runId: 'r1', type: 'tool:called', payload: { tool: 'git' } })
    const e2 = await log.append({ runId: 'r1', type: 'tool:result', payload: { ok: true } })

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e1.timestamp).toBeLessThanOrEqual(e2.timestamp)
    expect(e1.runId).toBe('r1')
    expect(e1.type).toBe('tool:called')
    expect(e1.payload).toEqual({ tool: 'git' })
  })

  it('maintains separate seq counters per run', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    await log.append({ runId: 'r2', type: 'b', payload: {} })
    const e3 = await log.append({ runId: 'r1', type: 'c', payload: {} })
    const e4 = await log.append({ runId: 'r2', type: 'd', payload: {} })

    expect(e3.seq).toBe(2)
    expect(e4.seq).toBe(2)
  })

  it('getEvents returns ordered events for a run', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    await log.append({ runId: 'r1', type: 'b', payload: {} })
    await log.append({ runId: 'r2', type: 'c', payload: {} })

    const events = await log.getEvents('r1')
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('a')
    expect(events[1]!.type).toBe('b')
  })

  it('getEvents returns empty array for unknown run', async () => {
    expect(await log.getEvents('nonexistent')).toEqual([])
  })

  it('getEventsSince filters by seq', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    await log.append({ runId: 'r1', type: 'b', payload: {} })
    await log.append({ runId: 'r1', type: 'c', payload: {} })

    const since = await log.getEventsSince('r1', 1)
    expect(since).toHaveLength(2)
    expect(since[0]!.seq).toBe(2)
    expect(since[1]!.seq).toBe(3)
  })

  it('getEventsSince returns empty for unknown run', async () => {
    expect(await log.getEventsSince('x', 0)).toEqual([])
  })

  it('getLatest returns the last event', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    await log.append({ runId: 'r1', type: 'b', payload: { final: true } })

    const latest = await log.getLatest('r1')
    expect(latest).not.toBeNull()
    expect(latest!.type).toBe('b')
    expect(latest!.payload).toEqual({ final: true })
  })

  it('getLatest returns null for unknown run', async () => {
    expect(await log.getLatest('nonexistent')).toBeNull()
  })

  it('totalEvents counts across all runs', async () => {
    expect(log.totalEvents).toBe(0)
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    await log.append({ runId: 'r2', type: 'b', payload: {} })
    expect(log.totalEvents).toBe(2)
  })

  it('clear removes all events', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    log.clear()
    expect(log.totalEvents).toBe(0)
    expect(await log.getEvents('r1')).toEqual([])
  })

  it('getEvents returns a copy (not the internal array)', async () => {
    await log.append({ runId: 'r1', type: 'a', payload: {} })
    const events = await log.getEvents('r1')
    events.pop()
    expect(await log.getEvents('r1')).toHaveLength(1)
  })
})

describe('EventLogSink', () => {
  it('captures DzipEventBus events for a run', async () => {
    const log = new InMemoryEventLog()
    const sink = new EventLogSink(log)
    const bus = createEventBus()

    const unsub = sink.attach(bus, 'run-42')

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'run-42' } as never)
    bus.emit({ type: 'tool:called', toolName: 'bash', input: {} } as never)

    // Give microtasks a chance to resolve (append is async but fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const events = await log.getEvents('run-42')
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('agent:started')
    expect(events[0]!.payload).toHaveProperty('agentId', 'a1')
    expect(events[1]!.type).toBe('tool:called')

    unsub()

    bus.emit({ type: 'agent:done' } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))

    // No new events after unsub
    expect(await log.getEvents('run-42')).toHaveLength(2)
  })
})
