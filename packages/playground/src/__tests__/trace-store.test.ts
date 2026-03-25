/**
 * Tests for the trace Pinia store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTraceStore } from '../stores/trace-store.js'
import type { TraceEvent } from '../types.js'

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `event-${Date.now()}-${Math.random()}`,
    type: 'llm',
    name: 'test-event',
    startedAt: new Date().toISOString(),
    durationMs: 100,
    ...overrides,
  }
}

describe('trace-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with empty events', () => {
    const store = useTraceStore()
    expect(store.events).toEqual([])
    expect(store.eventCount).toBe(0)
  })

  it('addEvent appends an event', () => {
    const store = useTraceStore()
    const event = makeEvent({ id: 'e1' })

    store.addEvent(event)

    expect(store.events.length).toBe(1)
    expect(store.events[0]?.id).toBe('e1')
    expect(store.eventCount).toBe(1)
  })

  it('addEvent appends multiple events', () => {
    const store = useTraceStore()

    store.addEvent(makeEvent({ id: 'e1' }))
    store.addEvent(makeEvent({ id: 'e2' }))
    store.addEvent(makeEvent({ id: 'e3' }))

    expect(store.events.length).toBe(3)
  })

  it('clearEvents resets to empty', () => {
    const store = useTraceStore()

    store.addEvent(makeEvent())
    store.addEvent(makeEvent())

    store.clearEvents()

    expect(store.events).toEqual([])
    expect(store.eventCount).toBe(0)
  })

  it('totalDurationMs sums all event durations', () => {
    const store = useTraceStore()

    store.addEvent(makeEvent({ durationMs: 100 }))
    store.addEvent(makeEvent({ durationMs: 200 }))
    store.addEvent(makeEvent({ durationMs: 300 }))

    expect(store.totalDurationMs).toBe(600)
  })

  it('eventsByType groups events correctly', () => {
    const store = useTraceStore()

    store.addEvent(makeEvent({ type: 'llm' }))
    store.addEvent(makeEvent({ type: 'tool' }))
    store.addEvent(makeEvent({ type: 'llm' }))
    store.addEvent(makeEvent({ type: 'memory' }))

    const grouped = store.eventsByType
    expect(grouped['llm']?.length).toBe(2)
    expect(grouped['tool']?.length).toBe(1)
    expect(grouped['memory']?.length).toBe(1)
  })
})
