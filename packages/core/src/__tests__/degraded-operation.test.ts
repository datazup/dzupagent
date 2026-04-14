import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../events/event-bus.js'
import { emitDegradedOperation } from '../events/degraded-operation.js'

describe('emitDegradedOperation', () => {
  it('emits a system:degraded event through the event bus', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('system:degraded', handler)

    emitDegradedOperation(bus, 'memory-ipc', 'peer dependency not installed', false)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system:degraded',
        subsystem: 'memory-ipc',
        reason: 'peer dependency not installed',
        recoverable: false,
        timestamp: expect.any(Number),
      }),
    )
  })

  it('defaults recoverable to true', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('system:degraded', handler)

    emitDegradedOperation(bus, 'mcp-server', 'connection refused')

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ recoverable: true }),
    )
  })
})
