import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import {
  AdapterApprovalGate,
  type ApprovalContext,
  type ApprovalMode,
} from '../approval/adapter-approval.js'
import type { AdapterProviderId, AgentEvent } from '../types.js'
import { collectEvents } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    runId: 'run-1',
    description: 'Deploy to production',
    providerId: 'claude' as AdapterProviderId,
    ...overrides,
  }
}

async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterApprovalGate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('requestApproval()', () => {
    it('auto mode returns approved immediately', async () => {
      const gate = new AdapterApprovalGate({ mode: 'auto' })
      const result = await gate.requestApproval(createContext())
      expect(result).toBe('approved')
    })

    it('required mode waits for grant', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      const ctx = createContext()

      // Start requesting (will block until grant/reject/timeout)
      const promise = gate.requestApproval(ctx)

      // Wait a tick for the request to be registered
      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      expect(pending).toHaveLength(1)

      // Grant it
      const granted = gate.grant(pending[0]!.requestId)
      expect(granted).toBe(true)

      const result = await promise
      expect(result).toBe('approved')
    })

    it('required mode times out', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 50 })
      const result = await gate.requestApproval(createContext())
      expect(result).toBe('timeout')
    })

    it('conditional mode evaluates condition - approval needed', async () => {
      const gate = new AdapterApprovalGate({
        mode: 'conditional',
        condition: (ctx) => ctx.tags?.includes('dangerous') ?? false,
        timeoutMs: 50,
      })

      // No dangerous tag -- auto-approve
      const result1 = await gate.requestApproval(createContext({ tags: ['safe'] }))
      expect(result1).toBe('approved')

      // Dangerous tag -- requires approval, will timeout
      const result2 = await gate.requestApproval(createContext({ tags: ['dangerous'] }))
      expect(result2).toBe('timeout')
    })

    it('conditional mode evaluates async condition', async () => {
      const gate = new AdapterApprovalGate({
        mode: 'conditional',
        condition: async () => false,
        timeoutMs: 50,
      })

      const result = await gate.requestApproval(createContext())
      expect(result).toBe('approved')
    })
  })

  describe('grant()', () => {
    it('resolves pending request as approved', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      const promise = gate.requestApproval(createContext())

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      const found = gate.grant(pending[0]!.requestId, 'admin')
      expect(found).toBe(true)

      const result = await promise
      expect(result).toBe('approved')
    })

    it('returns false for unknown request ID', () => {
      const gate = new AdapterApprovalGate({ mode: 'required' })
      expect(gate.grant('nonexistent')).toBe(false)
    })
  })

  describe('reject()', () => {
    it('resolves pending request as rejected', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      const promise = gate.requestApproval(createContext())

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      const found = gate.reject(pending[0]!.requestId, 'too risky')
      expect(found).toBe(true)

      const result = await promise
      expect(result).toBe('rejected')
    })

    it('returns false for unknown request ID', () => {
      const gate = new AdapterApprovalGate({ mode: 'required' })
      expect(gate.reject('nonexistent')).toBe(false)
    })
  })

  describe('autoApproveBelowCostCents', () => {
    it('bypasses approval when estimated cost is below threshold', async () => {
      const gate = new AdapterApprovalGate({
        mode: 'required',
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      })

      // Below threshold -- auto-approve
      const result = await gate.requestApproval(
        createContext({ estimatedCostCents: 50 }),
      )
      expect(result).toBe('approved')
    })

    it('requires approval when cost is above threshold', async () => {
      const gate = new AdapterApprovalGate({
        mode: 'required',
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      })

      // Above threshold -- will timeout
      const result = await gate.requestApproval(
        createContext({ estimatedCostCents: 200 }),
      )
      expect(result).toBe('timeout')
    })

    it('requires approval when no cost estimate is provided', async () => {
      const gate = new AdapterApprovalGate({
        mode: 'required',
        autoApproveBelowCostCents: 100,
        timeoutMs: 50,
      })

      // No cost estimate -- requires approval, will timeout
      const result = await gate.requestApproval(createContext())
      expect(result).toBe('timeout')
    })
  })

  describe('listPending()', () => {
    it('returns pending requests', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })

      // Create two pending requests
      gate.requestApproval(createContext({ runId: 'run-1' }))
      gate.requestApproval(createContext({ runId: 'run-2' }))

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      expect(pending).toHaveLength(2)
      expect(pending.map((p) => p.runId)).toContain('run-1')
      expect(pending.map((p) => p.runId)).toContain('run-2')

      // Cleanup
      gate.clear()
    })
  })

  describe('getRequest()', () => {
    it('returns request by ID', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      gate.requestApproval(createContext())

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      const req = gate.getRequest(pending[0]!.requestId)
      expect(req).toBeDefined()
      expect(req!.status).toBe('pending')
      expect(req!.context.description).toBe('Deploy to production')

      gate.clear()
    })

    it('returns undefined for unknown ID', () => {
      const gate = new AdapterApprovalGate({ mode: 'required' })
      expect(gate.getRequest('unknown')).toBeUndefined()
    })
  })

  describe('clear()', () => {
    it('removes all pending requests', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      gate.requestApproval(createContext({ runId: 'a' }))
      gate.requestApproval(createContext({ runId: 'b' }))

      await new Promise((r) => setTimeout(r, 10))

      expect(gate.listPending()).toHaveLength(2)

      gate.clear()
      expect(gate.listPending()).toHaveLength(0)
    })
  })

  describe('guard()', () => {
    it('yields events when approved', async () => {
      const gate = new AdapterApprovalGate({ mode: 'auto' })
      const source: AgentEvent[] = [
        {
          type: 'adapter:started',
          providerId: 'claude',
          sessionId: 's1',
          timestamp: Date.now(),
        },
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]

      const events = await collectEvents(
        gate.guard(createContext(), eventStream(source)),
      )

      expect(events).toHaveLength(2)
      expect(events[0]!.type).toBe('adapter:started')
      expect(events[1]!.type).toBe('adapter:completed')
    })

    it('yields failed event when rejected', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 5000 })
      const ctx = createContext()

      const source: AgentEvent[] = [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]

      const guardGen = gate.guard(ctx, eventStream(source))

      // Start consuming in background
      const eventsPromise = collectEvents(guardGen)

      await new Promise((r) => setTimeout(r, 10))

      // Reject the pending request
      const pending = gate.listPending()
      gate.reject(pending[0]!.requestId, 'denied')

      const events = await eventsPromise
      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('adapter:failed')
      expect((events[0] as { error: string }).error).toBe('Approval rejected')
    })

    it('yields failed event on timeout', async () => {
      const gate = new AdapterApprovalGate({ mode: 'required', timeoutMs: 30 })
      const source: AgentEvent[] = [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]

      const events = await collectEvents(
        gate.guard(createContext(), eventStream(source)),
      )

      expect(events).toHaveLength(1)
      expect(events[0]!.type).toBe('adapter:failed')
      expect((events[0] as { error: string }).error).toBe('Approval timeout')
    })
  })

  describe('event bus integration', () => {
    it('emits approval events on bus', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)

      const gate = new AdapterApprovalGate({
        mode: 'required',
        timeoutMs: 5000,
        eventBus: bus,
      })

      const promise = gate.requestApproval(createContext())

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      gate.grant(pending[0]!.requestId, 'admin')

      await promise

      const types = emitted.map((e) => e.type)
      expect(types).toContain('approval:requested')
      expect(types).toContain('approval:granted')
    })

    it('emits approval:rejected event on rejection', async () => {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)

      const gate = new AdapterApprovalGate({
        mode: 'required',
        timeoutMs: 5000,
        eventBus: bus,
      })

      const promise = gate.requestApproval(createContext())

      await new Promise((r) => setTimeout(r, 10))

      const pending = gate.listPending()
      gate.reject(pending[0]!.requestId, 'too risky')

      await promise

      const types = emitted.map((e) => e.type)
      expect(types).toContain('approval:rejected')
    })
  })

  describe('webhook notification', () => {
    it('calls webhook URL on approval request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      )

      const gate = new AdapterApprovalGate({
        mode: 'required',
        timeoutMs: 50,
        webhookUrl: 'https://hooks.example.com/approve',
      })

      await gate.requestApproval(
        createContext({
          estimatedCostCents: 42,
          tags: ['deploy'],
          metadata: { env: 'prod' },
        }),
      )

      // Webhook is fire-and-forget, wait a tick
      await new Promise((r) => setTimeout(r, 20))

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, options] = fetchSpy.mock.calls[0]!
      expect(url).toBe('https://hooks.example.com/approve')
      expect((options as RequestInit).method).toBe('POST')

      const body = JSON.parse((options as RequestInit).body as string) as Record<string, unknown>
      expect(body['type']).toBe('approval_requested')
      expect(body['description']).toBe('Deploy to production')
      expect(body['estimatedCostCents']).toBe(42)
    })

    it('does not throw if webhook fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

      const gate = new AdapterApprovalGate({
        mode: 'required',
        timeoutMs: 50,
        webhookUrl: 'https://hooks.example.com/approve',
      })

      // Should not throw despite fetch failure
      const result = await gate.requestApproval(createContext())
      expect(result).toBe('timeout')
    })
  })
})
