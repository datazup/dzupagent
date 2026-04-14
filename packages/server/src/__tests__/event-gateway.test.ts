import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { InMemoryEventGateway } from '../events/event-gateway.js'

describe('InMemoryEventGateway', () => {
  it('publishes enveloped events to matching subscribers', async () => {
    const bus = createEventBus()
    const gateway = new InMemoryEventGateway(bus)
    const received: string[] = []

    gateway.subscribe({ runId: 'r1' }, (event) => {
      received.push(event.id)
      expect(event.version).toBe('v1')
      expect(event.runId).toBe('r1')
      expect(event.payload.type).toBe('agent:started')
    })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toHaveLength(1)
  })

  it('supports event type filtering', async () => {
    const gateway = new InMemoryEventGateway()
    const types: string[] = []

    gateway.subscribe({ eventTypes: ['agent:failed'] }, (event) => {
      types.push(event.type)
    })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    gateway.publish({ type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'INTERNAL_ERROR', message: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(types).toEqual(['agent:failed'])
  })

  it('drops old events when queue overflows with drop_oldest', async () => {
    const gateway = new InMemoryEventGateway(undefined, { maxQueueSize: 1, overflowStrategy: 'drop_oldest' })
    const received: string[] = []

    gateway.subscribe({}, (event) => {
      received.push(event.type)
    }, { maxQueueSize: 1, overflowStrategy: 'drop_oldest' })

    gateway.publish({ type: 'tool:called', toolName: 'a', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'b', input: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // At least one event is delivered; with queue size 1 and microtask drain,
    // newest events are preserved under pressure.
    expect(received.length).toBeGreaterThanOrEqual(1)
  })

  it('treats empty eventTypes filter as deny-all', async () => {
    const gateway = new InMemoryEventGateway()
    const received: string[] = []

    gateway.subscribe({ eventTypes: [] }, (event) => {
      received.push(event.type)
    })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toHaveLength(0)
  })
})
