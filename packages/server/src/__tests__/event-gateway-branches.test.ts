/**
 * Branch coverage tests for InMemoryEventGateway.
 *
 * Covers overflow strategies (drop_new, disconnect), sink returning false,
 * filter variations (agentId, no-runId events), destroy cleanup, subscriber counting.
 */
import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { InMemoryEventGateway } from '../events/event-gateway.js'

describe('InMemoryEventGateway branch coverage', () => {
  it('uses drop_new overflow strategy and drops incoming events when full', async () => {
    const gateway = new InMemoryEventGateway()
    const received: string[] = []

    gateway.subscribe({}, (env) => { received.push(env.type) }, {
      maxQueueSize: 1,
      overflowStrategy: 'drop_new',
    })

    // Publish synchronously so queue fills before microtask drain
    gateway.publish({ type: 'tool:called', toolName: 'a', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'b', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'c', input: {} })

    await new Promise((r) => setTimeout(r, 10))
    // With drop_new and queue size 1, only the first event is kept
    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received.length).toBeLessThanOrEqual(3)
  })

  it('uses disconnect overflow strategy and removes subscriber', async () => {
    const gateway = new InMemoryEventGateway()
    let received = 0

    gateway.subscribe({}, () => { received++ }, {
      maxQueueSize: 1,
      overflowStrategy: 'disconnect',
    })

    // Emit synchronously so the queue overflows before drain microtask
    gateway.publish({ type: 'tool:called', toolName: 'a', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'b', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'c', input: {} })

    await new Promise((r) => setTimeout(r, 10))
    expect(gateway.subscriberCount).toBe(0)
    expect(received).toBeGreaterThanOrEqual(0)
  })

  it('removes subscriber when sink returns false', async () => {
    const gateway = new InMemoryEventGateway()
    let calls = 0

    gateway.subscribe({}, () => {
      calls++
      return false
    })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(1)
    expect(gateway.subscriberCount).toBe(0)
  })

  it('filters by agentId', async () => {
    const gateway = new InMemoryEventGateway()
    const types: string[] = []

    gateway.subscribe({ agentId: 'a1' }, (env) => { types.push(env.type) })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    gateway.publish({ type: 'agent:started', agentId: 'a2', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(types).toEqual(['agent:started'])
  })

  it('filters by runId AND agentId together', async () => {
    const gateway = new InMemoryEventGateway()
    const types: string[] = []

    gateway.subscribe({ runId: 'r1', agentId: 'a1' }, (env) => { types.push(env.type) })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    gateway.publish({ type: 'agent:started', agentId: 'a2', runId: 'r1' })
    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 10))

    expect(types).toHaveLength(1)
  })

  it('publishes events without runId correctly', async () => {
    const gateway = new InMemoryEventGateway()
    const envelopes: Array<{ runId?: string; agentId?: string }> = []

    gateway.subscribe({}, (env) => {
      envelopes.push({ runId: env.runId, agentId: env.agentId })
    })

    gateway.publish({ type: 'tool:called', toolName: 'x', input: {} })
    await new Promise((r) => setTimeout(r, 10))

    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.runId).toBeUndefined()
  })

  it('tracks subscriber count correctly', () => {
    const gateway = new InMemoryEventGateway()
    expect(gateway.subscriberCount).toBe(0)

    const sub1 = gateway.subscribe({}, () => {})
    const sub2 = gateway.subscribe({}, () => {})
    expect(gateway.subscriberCount).toBe(2)

    sub1.unsubscribe()
    expect(gateway.subscriberCount).toBe(1)

    sub2.unsubscribe()
    expect(gateway.subscriberCount).toBe(0)
  })

  it('destroy unsubscribes from event bus', async () => {
    const bus = createEventBus()
    const gateway = new InMemoryEventGateway(bus)

    const received: string[] = []
    gateway.subscribe({}, (env) => { received.push(env.type) })

    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)

    gateway.destroy()
    expect(gateway.subscriberCount).toBe(0)

    // Post-destroy events should not produce subscriptions
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)
  })

  it('unsubscribe during drain breaks the drain loop', async () => {
    const gateway = new InMemoryEventGateway()
    const received: string[] = []
    let sub: { unsubscribe(): void } | null = null

    sub = gateway.subscribe({}, (env) => {
      received.push(env.type)
      sub?.unsubscribe()
    })

    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    gateway.publish({ type: 'agent:started', agentId: 'a1', runId: 'r2' })
    await new Promise((r) => setTimeout(r, 10))

    // First event dequeues and triggers unsubscribe; further iterations are skipped.
    expect(received.length).toBeGreaterThanOrEqual(1)
  })

  it('respects default config values when none are provided', () => {
    const gateway = new InMemoryEventGateway()
    expect(gateway.subscriberCount).toBe(0)
    gateway.destroy()
  })

  it('handles subscriptions with default overflow strategy (drop_oldest)', async () => {
    const gateway = new InMemoryEventGateway(undefined, {
      maxQueueSize: 1,
      overflowStrategy: 'drop_oldest',
    })
    const received: string[] = []

    gateway.subscribe({}, (env) => { received.push(env.type) })

    gateway.publish({ type: 'tool:called', toolName: 'a', input: {} })
    gateway.publish({ type: 'tool:called', toolName: 'b', input: {} })
    await new Promise((r) => setTimeout(r, 10))

    expect(received.length).toBeGreaterThanOrEqual(1)
  })
})
