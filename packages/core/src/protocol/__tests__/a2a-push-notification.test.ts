import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushNotificationService } from '../a2a-push-notification.js'
import type { PushNotificationConfig } from '../a2a-push-notification.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(status: number, ok?: boolean): typeof globalThis.fetch {
  return vi.fn(async () => {
    return new Response(null, {
      status,
      headers: {},
    }) as Response
  }) as unknown as typeof globalThis.fetch
}

function createFailingFetch(errorMessage: string): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error(errorMessage)
  }) as unknown as typeof globalThis.fetch
}

/**
 * Creates a fetch that fails on first call, succeeds on second.
 */
function createRetryFetch(failStatus: number, successStatus: number): typeof globalThis.fetch {
  let callCount = 0
  return vi.fn(async () => {
    callCount++
    if (callCount === 1) {
      return new Response(null, { status: failStatus }) as Response
    }
    return new Response(null, { status: successStatus }) as Response
  }) as unknown as typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PushNotificationService', () => {
  let service: PushNotificationService

  beforeEach(() => {
    service = new PushNotificationService({
      fetch: createMockFetch(200),
      timeoutMs: 5000,
    })
  })

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe('register / unregister / getConfig', () => {
    it('registers and retrieves push config', () => {
      const cfg: PushNotificationConfig = {
        url: 'https://example.com/webhook',
        token: 'secret-token',
        events: ['task.completed'],
      }
      service.register('task-1', cfg)
      expect(service.getConfig('task-1')).toEqual(cfg)
    })

    it('returns undefined for unregistered task', () => {
      expect(service.getConfig('nonexistent')).toBeUndefined()
    })

    it('unregisters a task', () => {
      service.register('task-1', { url: 'https://example.com/webhook' })
      service.unregister('task-1')
      expect(service.getConfig('task-1')).toBeUndefined()
    })

    it('replaces existing registration', () => {
      service.register('task-1', { url: 'https://old.com' })
      service.register('task-1', { url: 'https://new.com' })
      expect(service.getConfig('task-1')?.url).toBe('https://new.com')
    })
  })

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  describe('dispose', () => {
    it('clears all registrations', () => {
      service.register('task-1', { url: 'https://example.com/a' })
      service.register('task-2', { url: 'https://example.com/b' })
      service.dispose()
      expect(service.getConfig('task-1')).toBeUndefined()
      expect(service.getConfig('task-2')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Notify — success
  // -----------------------------------------------------------------------

  describe('notify — successful delivery', () => {
    it('delivers notification and returns success result', async () => {
      const mockFetch = createMockFetch(200)
      const svc = new PushNotificationService({ fetch: mockFetch })
      svc.register('task-1', { url: 'https://example.com/webhook', token: 'tok' })

      const result = await svc.notify('task-1', 'task.completed', { state: 'completed' })

      expect(result.delivered).toBe(true)
      expect(result.statusCode).toBe(200)
      expect(result.error).toBeUndefined()
      expect(result.attemptedAt).toBeTruthy()

      // Verify fetch was called correctly
      expect(mockFetch).toHaveBeenCalledOnce()
      const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(callArgs[0]).toBe('https://example.com/webhook')
      expect(callArgs[1].method).toBe('POST')
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer tok')
      expect(headers['Content-Type']).toBe('application/json')

      // Verify payload
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>
      expect(body['taskId']).toBe('task-1')
      expect(body['event']).toBe('task.completed')
      expect(body['data']).toEqual({ state: 'completed' })
    })
  })

  // -----------------------------------------------------------------------
  // Notify — unregistered task
  // -----------------------------------------------------------------------

  describe('notify — unregistered task', () => {
    it('returns non-delivered result', async () => {
      const result = await service.notify('unknown-task', 'task.completed', {})

      expect(result.delivered).toBe(false)
      expect(result.error).toContain('No push notification config')
    })
  })

  // -----------------------------------------------------------------------
  // Notify — event filtering
  // -----------------------------------------------------------------------

  describe('notify — event filtering', () => {
    it('skips notification when event is not subscribed', async () => {
      const mockFetch = createMockFetch(200)
      const svc = new PushNotificationService({ fetch: mockFetch })
      svc.register('task-1', {
        url: 'https://example.com/webhook',
        events: ['task.completed'],
      })

      const result = await svc.notify('task-1', 'task.status.update', { state: 'working' })

      expect(result.delivered).toBe(false)
      expect(result.error).toContain('not in the subscribed events')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('delivers when event matches subscription', async () => {
      const mockFetch = createMockFetch(200)
      const svc = new PushNotificationService({ fetch: mockFetch })
      svc.register('task-1', {
        url: 'https://example.com/webhook',
        events: ['task.completed', 'task.failed'],
      })

      const result = await svc.notify('task-1', 'task.completed', { state: 'completed' })
      expect(result.delivered).toBe(true)
    })

    it('delivers when no event filter is set', async () => {
      const mockFetch = createMockFetch(200)
      const svc = new PushNotificationService({ fetch: mockFetch })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.status.update', {})
      expect(result.delivered).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Notify — failed delivery
  // -----------------------------------------------------------------------

  describe('notify — failed delivery', () => {
    it('returns non-delivered result on 4xx', async () => {
      const svc = new PushNotificationService({ fetch: createMockFetch(403) })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.completed', {})
      expect(result.delivered).toBe(false)
      expect(result.statusCode).toBe(403)
    })

    it('retries once on 500 and succeeds', async () => {
      const retryFetch = createRetryFetch(500, 200)
      const svc = new PushNotificationService({ fetch: retryFetch })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.completed', {})
      expect(result.delivered).toBe(true)
      expect(result.statusCode).toBe(200)
      expect(retryFetch).toHaveBeenCalledTimes(2)
    })

    it('retries once on 500 and fails on second 500', async () => {
      const svc = new PushNotificationService({ fetch: createMockFetch(500) })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.completed', {})
      expect(result.delivered).toBe(false)
      expect(result.statusCode).toBe(500)
    })

    it('retries once on network error and succeeds', async () => {
      let callCount = 0
      const fetchFn = vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Network failure')
        }
        return new Response(null, { status: 200 }) as Response
      }) as unknown as typeof globalThis.fetch

      const svc = new PushNotificationService({ fetch: fetchFn })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.completed', {})
      expect(result.delivered).toBe(true)
    })

    it('returns error after two network failures', async () => {
      const svc = new PushNotificationService({ fetch: createFailingFetch('Connection refused') })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      const result = await svc.notify('task-1', 'task.completed', {})
      expect(result.delivered).toBe(false)
      expect(result.error).toBe('Connection refused')
    })
  })

  // -----------------------------------------------------------------------
  // Notify — no token
  // -----------------------------------------------------------------------

  describe('notify — without token', () => {
    it('omits Authorization header when no token', async () => {
      const mockFetch = createMockFetch(200)
      const svc = new PushNotificationService({ fetch: mockFetch })
      svc.register('task-1', { url: 'https://example.com/webhook' })

      await svc.notify('task-1', 'task.completed', {})

      const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      const headers = callArgs[1].headers as Record<string, string>
      expect(headers['Authorization']).toBeUndefined()
    })
  })
})
