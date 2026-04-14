import { describe, it, expect, vi } from 'vitest'

import {
  EventBusEscalationHandler,
  WebhookEscalationHandler,
} from '../recovery/escalation-handler.js'

describe('EventBusEscalationHandler', () => {
  it('notify emits event on bus', async () => {
    const bus = { emit: vi.fn(), on: vi.fn() }
    const handler = new EventBusEscalationHandler(bus as never)

    await handler.notify({
      requestId: 'req-1',
      failedProviderId: 'claude',
      error: 'timeout',
      attempts: [],
      suggestions: ['retry'],
    })

    expect(bus.emit).toHaveBeenCalledOnce()
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery:escalation_requested',
        requestId: 'req-1',
        failedProviderId: 'claude',
      }),
    )
  })

  it('notify succeeds without event bus', async () => {
    const handler = new EventBusEscalationHandler()

    await expect(
      handler.notify({
        requestId: 'req-1',
        failedProviderId: 'claude',
        error: 'timeout',
        attempts: [],
        suggestions: ['retry'],
      }),
    ).resolves.toBeUndefined()
  })

  it('resolveEscalation resolves pending wait', async () => {
    const handler = new EventBusEscalationHandler()

    const promise = handler.waitForResolution('req-1', 5000)

    const resolved = handler.resolveEscalation('req-1', {
      action: 'retry',
      reason: 'User approved',
    })

    expect(resolved).toBe(true)
    const result = await promise
    expect(result.action).toBe('retry')
    expect(result.reason).toBe('User approved')
  })

  it('waitForResolution times out', async () => {
    vi.useFakeTimers()
    const handler = new EventBusEscalationHandler()

    const promise = handler.waitForResolution('req-1', 1000)
    vi.advanceTimersByTime(1500)

    await expect(promise).rejects.toThrow('timed out')
    vi.useRealTimers()
  })

  it('resolveEscalation returns false for unknown request', () => {
    const handler = new EventBusEscalationHandler()
    expect(handler.resolveEscalation('unknown', { action: 'abort' })).toBe(false)
  })

  it('listPending returns pending request IDs', async () => {
    const handler = new EventBusEscalationHandler()
    // Start waiting but don't resolve
    const p1 = handler.waitForResolution('req-1', 60000).catch(() => {})
    const p2 = handler.waitForResolution('req-2', 60000).catch(() => {})

    expect(handler.listPending()).toEqual(['req-1', 'req-2'])

    // Cleanup
    handler.resolveEscalation('req-1', { action: 'abort' })
    handler.resolveEscalation('req-2', { action: 'abort' })
    await Promise.all([p1, p2])
  })

  it('cleans up pending entry after resolution', async () => {
    const handler = new EventBusEscalationHandler()

    const promise = handler.waitForResolution('req-1', 5000)
    handler.resolveEscalation('req-1', { action: 'abort' })
    await promise

    expect(handler.listPending()).toEqual([])
    // Second resolve attempt should return false
    expect(handler.resolveEscalation('req-1', { action: 'retry' })).toBe(false)
  })

  it('cleans up pending entry after timeout', async () => {
    vi.useFakeTimers()
    const handler = new EventBusEscalationHandler()

    const promise = handler.waitForResolution('req-1', 100)
    vi.advanceTimersByTime(200)

    await expect(promise).rejects.toThrow()
    expect(handler.listPending()).toEqual([])
    vi.useRealTimers()
  })
})

describe('WebhookEscalationHandler', () => {
  it('validates webhook URL at construction', () => {
    expect(() => new WebhookEscalationHandler('https://hooks.slack.com/xxx')).not.toThrow()
    expect(() => new WebhookEscalationHandler('http://localhost/hook')).toThrow()
  })

  it('allows HTTP when configured', () => {
    expect(
      () => new WebhookEscalationHandler('http://example.com/hook', { allowHttp: true }),
    ).not.toThrow()
  })

  it('rejects invalid URLs', () => {
    expect(() => new WebhookEscalationHandler('not-a-url')).toThrow()
  })

  it('resolveEscalation resolves pending wait', async () => {
    const handler = new WebhookEscalationHandler('https://hooks.example.com/escalation')

    const promise = handler.waitForResolution('req-1', 5000)
    const resolved = handler.resolveEscalation('req-1', { action: 'abort', reason: 'done' })

    expect(resolved).toBe(true)
    const result = await promise
    expect(result.action).toBe('abort')
  })

  it('resolveEscalation returns false for unknown request', () => {
    const handler = new WebhookEscalationHandler('https://hooks.example.com/escalation')
    expect(handler.resolveEscalation('unknown', { action: 'abort' })).toBe(false)
  })

  it('waitForResolution times out', async () => {
    vi.useFakeTimers()
    const handler = new WebhookEscalationHandler('https://hooks.example.com/escalation')

    const promise = handler.waitForResolution('req-1', 500)
    vi.advanceTimersByTime(600)

    await expect(promise).rejects.toThrow('timed out')
    vi.useRealTimers()
  })
})
