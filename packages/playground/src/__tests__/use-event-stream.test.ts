/**
 * Tests for the useEventStream composable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useEventStream, type ReplayEvent } from '../composables/useEventStream.js'
import { useWsStore } from '../stores/ws-store.js'
import type { WsEvent } from '../types.js'

describe('useEventStream', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Reset document visibility mock
    vi.restoreAllMocks()
  })

  function setup(options?: { url?: string; runId?: string | null }) {
    const serverUrl = ref(options?.url ?? 'ws://localhost:4000/ws')
    const runId = ref<string | null>(options?.runId ?? 'run-1')
    const result = useEventStream(serverUrl, runId)
    const wsStore = useWsStore()
    return { ...result, wsStore, serverUrl, runId }
  }

  it('starts with empty events and disconnected state', () => {
    const { events, isConnected, connectionError } = setup()
    expect(events.value).toEqual([])
    expect(isConnected.value).toBe(false)
    expect(connectionError.value).toBeNull()
  })

  it('converts WsEvent to ReplayEvent when a matching event arrives', async () => {
    const { events, wsStore, runId } = setup()
    runId.value = 'run-1'

    const wsEvent: WsEvent = {
      id: 'evt-1',
      type: 'tool:called',
      runId: 'run-1',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { toolName: 'search', input: { query: 'test' } },
    }

    // Simulate WsStore receiving an event
    wsStore.lastEvent = wsEvent
    await nextTick()

    expect(events.value.length).toBe(1)
    const event = events.value[0]!
    expect(event.type).toBe('tool:called')
    expect(event.runId).toBe('run-1')
    expect(event.payload['toolName']).toBe('search')
  })

  it('filters out events for different run IDs', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    const wsEvent: WsEvent = {
      type: 'tool:called',
      runId: 'other-run',
      payload: { toolName: 'search' },
    }

    wsStore.lastEvent = wsEvent
    await nextTick()

    expect(events.value.length).toBe(0)
  })

  it('accepts events without explicit runId when subscribed', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    const wsEvent: WsEvent = {
      type: 'agent:started',
      payload: {},
    }

    wsStore.lastEvent = wsEvent
    await nextTick()

    expect(events.value.length).toBe(1)
    expect(events.value[0]!.runId).toBe('run-1')
  })

  it('clearEvents removes all accumulated events', async () => {
    const { events, wsStore, clearEvents } = setup({ runId: 'run-1' })

    wsStore.lastEvent = {
      type: 'tool:called',
      runId: 'run-1',
      payload: { toolName: 'a' },
    }
    await nextTick()
    expect(events.value.length).toBe(1)

    clearEvents()
    expect(events.value.length).toBe(0)
  })

  it('syncs isConnected from WsStore state', async () => {
    const { isConnected, wsStore } = setup()

    wsStore.$patch({ state: 'connected' })
    await nextTick()
    expect(isConnected.value).toBe(true)

    wsStore.$patch({ state: 'disconnected' })
    await nextTick()
    expect(isConnected.value).toBe(false)
  })

  it('sets connectionError when WsStore enters error state', async () => {
    const { connectionError, wsStore } = setup()

    wsStore.$patch({ state: 'error' })
    await nextTick()
    expect(connectionError.value).not.toBeNull()
    expect(connectionError.value).toContain('failed')
  })

  it('clears connectionError when WsStore reconnects', async () => {
    const { connectionError, wsStore } = setup()

    wsStore.$patch({ state: 'error' })
    await nextTick()
    expect(connectionError.value).not.toBeNull()

    wsStore.$patch({ state: 'connected' })
    await nextTick()
    expect(connectionError.value).toBeNull()
  })

  it('sets connectionError when serverUrl is empty', () => {
    const { connectionError, connect } = setup({ url: '' })

    connect()
    expect(connectionError.value).toBe('No server URL provided')
  })

  it('generates unique IDs for events without an ID', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    wsStore.lastEvent = { type: 'tool:called', runId: 'run-1', payload: {} }
    await nextTick()
    wsStore.lastEvent = { type: 'tool:result', runId: 'run-1', payload: {} }
    await nextTick()

    expect(events.value.length).toBe(2)
    expect(events.value[0]!.id).not.toBe(events.value[1]!.id)
  })

  it('hoists top-level WsEvent fields into payload', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    const wsEvent: WsEvent = {
      type: 'tool:called',
      runId: 'run-1',
      toolName: 'custom-tool',
      agentId: 'agent-1',
      payload: { input: 'test' },
    }

    wsStore.lastEvent = wsEvent
    await nextTick()

    const event = events.value[0]!
    expect(event.payload['toolName']).toBe('custom-tool')
    expect(event.payload['agentId']).toBe('agent-1')
    expect(event.payload['input']).toBe('test')
  })

  it('prunes oldest events when exceeding MAX_EVENTS limit', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    // Manually inject many events
    const bulkEvents: ReplayEvent[] = []
    for (let i = 0; i < 2100; i++) {
      bulkEvents.push({
        id: `evt-${i}`,
        type: 'tool:called',
        timestamp: new Date().toISOString(),
        runId: 'run-1',
        payload: {},
      })
    }
    events.value = bulkEvents

    // Trigger a new event to cause pruning
    wsStore.lastEvent = {
      type: 'tool:called',
      runId: 'run-1',
      payload: {},
    }
    await nextTick()

    // Should have been pruned to roughly half + 1 new event
    expect(events.value.length).toBeLessThanOrEqual(1002)
  })

  it('does not process events with empty type', async () => {
    const { events, wsStore } = setup({ runId: 'run-1' })

    wsStore.lastEvent = { type: '', runId: 'run-1', payload: {} }
    await nextTick()

    expect(events.value.length).toBe(0)
  })
})
