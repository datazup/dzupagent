import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'
import { AuditTrail, InMemoryAuditStore } from '../audit-trail.js'
import { SafetyMonitor } from '../safety-monitor.js'

async function tick(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('AuditTrail onAny catch block', () => {
  it('swallows errors thrown by extractDetails on malformed budget:warning event', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({ store })
    const bus = createEventBus()
    trail.attach(bus)

    bus.emit({ type: 'budget:warning', level: 'warn' } as unknown as DzupEvent)
    await tick()

    const all = await store.getAll()
    expect(all.length).toBe(0)
  })

  it('swallows errors thrown by extractDetails on malformed budget:exceeded event', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({ store })
    const bus = createEventBus()
    trail.attach(bus)

    bus.emit({ type: 'budget:exceeded', reason: 'limit' } as unknown as DzupEvent)
    await tick()

    const all = await store.getAll()
    expect(all.length).toBe(0)
  })

  it('continues processing subsequent valid events after error', async () => {
    const store = new InMemoryAuditStore()
    const trail = new AuditTrail({ store })
    const bus = createEventBus()
    trail.attach(bus)

    bus.emit({ type: 'budget:warning', level: 'warn' } as unknown as DzupEvent)
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await tick()

    const all = await store.getAll()
    expect(all.length).toBe(1)
    expect(all[0]!.category).toBe('agent_lifecycle')
  })
})

describe('SafetyMonitor tool:error catch block', () => {
  it('swallows errors thrown while tracking tool failure', () => {
    const monitor = new SafetyMonitor({ toolFailureThreshold: 1 })
    const bus = createEventBus()
    monitor.attach(bus)

    const throwingMap = {
      get(): number {
        throw new Error('forced failure in get')
      },
      set(): void {
        throw new Error('forced failure in set')
      },
      clear(): void {
        // noop
      },
    }
    Object.defineProperty(monitor, '_toolFailures', {
      value: throwingMap,
      writable: true,
      configurable: true,
    })

    expect(() => {
      bus.emit({
        type: 'tool:error',
        toolName: 'bad',
        errorCode: 'ERR',
        message: 'boom',
      })
    }).not.toThrow()

    expect(monitor.getEvents().length).toBe(0)
  })

  it('subsequent tool:result still processes after prior tool:error threw', () => {
    const monitor = new SafetyMonitor({ toolFailureThreshold: 1 })
    const bus = createEventBus()
    monitor.attach(bus)

    let shouldThrow = true
    const backing = new Map<string, number>()
    const guardedMap = {
      get(key: string): number | undefined {
        if (shouldThrow) throw new Error('forced')
        return backing.get(key)
      },
      set(key: string, value: number): void {
        if (shouldThrow) throw new Error('forced')
        backing.set(key, value)
      },
      clear(): void {
        backing.clear()
      },
    }
    Object.defineProperty(monitor, '_toolFailures', {
      value: guardedMap,
      writable: true,
      configurable: true,
    })

    bus.emit({ type: 'tool:error', toolName: 't1', errorCode: 'E', message: 'x' })
    shouldThrow = false
    bus.emit({ type: 'tool:result', toolName: 't1', durationMs: 5 })

    expect(backing.get('t1')).toBe(0)
  })
})
