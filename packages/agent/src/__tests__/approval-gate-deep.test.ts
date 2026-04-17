import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { ApprovalGate } from '../approval/approval-gate.js'

describe('ApprovalGate - extended', () => {
  describe('conditional mode', () => {
    it('requires approval when no condition is provided (falls through to required)', async () => {
      const bus = createEventBus()
      const gate = new ApprovalGate({
        mode: 'conditional',
        // No condition function -- should NOT auto-approve
        timeoutMs: 50,
      }, bus)

      // Without condition and without ctx, the conditional check is skipped
      // Falls through to the approval wait
      const result = await gate.waitForApproval('run-1', 'plan')
      expect(result).toBe('timeout')
    })

    it('requires approval when ctx is not provided (condition not evaluated)', async () => {
      const bus = createEventBus()
      const gate = new ApprovalGate({
        mode: 'conditional',
        condition: async () => false, // Would skip approval, but needs ctx
        timeoutMs: 50,
      }, bus)

      // No ctx provided -- condition is not evaluated
      const result = await gate.waitForApproval('run-1', 'plan')
      expect(result).toBe('timeout')
    })

    it('evaluates async condition', async () => {
      const bus = createEventBus()
      const conditionFn = vi.fn().mockResolvedValue(false)
      const gate = new ApprovalGate({
        mode: 'conditional',
        condition: conditionFn,
      }, bus)

      const result = await gate.waitForApproval('run-1', { data: 'safe' }, {
        agentId: 'a1',
        runId: 'run-1',
        metadata: {},
      })

      expect(result).toBe('approved')
      expect(conditionFn).toHaveBeenCalledWith(
        { data: 'safe' },
        expect.objectContaining({ runId: 'run-1' }),
      )
    })
  })

  describe('event bus integration', () => {
    it('emits approval:requested with contactId and channel', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)
      await gate.waitForApproval('run-1', { plan: 'test' })

      expect(events).toHaveLength(1)
      const evt = events[0] as Record<string, unknown>
      expect(evt['contactId']).toBeDefined()
      expect(evt['channel']).toBe('in-app')
      expect(evt['request']).toBeDefined()
    })

    it('uses custom channel when configured', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({
        mode: 'required',
        timeoutMs: 50,
        channel: 'slack',
      }, bus)
      await gate.waitForApproval('run-1', 'plan')

      const evt = events[0] as Record<string, unknown>
      expect(evt['channel']).toBe('slack')
    })

    it('handles plan as string for question', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)
      await gate.waitForApproval('run-1', 'Please approve deployment')

      const evt = events[0] as Record<string, unknown>
      const request = evt['request'] as Record<string, unknown>
      const data = request['data'] as Record<string, unknown>
      expect(data['question']).toBe('Please approve deployment')
    })

    it('handles plan as object for context', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)
      await gate.waitForApproval('run-1', { action: 'deploy', env: 'prod' })

      const evt = events[0] as Record<string, unknown>
      const request = evt['request'] as Record<string, unknown>
      const data = request['data'] as Record<string, unknown>
      expect(data['question']).toBe('Approve this action?') // Non-string plan
      expect(data['context']).toContain('deploy')
    })
  })

  describe('timeout behavior', () => {
    it('emits approval:rejected event on timeout', async () => {
      const bus = createEventBus()
      const rejections: unknown[] = []
      bus.on('approval:rejected', (e) => rejections.push(e))

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 30 }, bus)
      await gate.waitForApproval('run-timeout', 'slow')

      expect(rejections.length).toBeGreaterThanOrEqual(1)
      const rej = rejections.find((r) => (r as Record<string, unknown>)['runId'] === 'run-timeout') as Record<string, unknown>
      expect(rej).toBeDefined()
      expect(rej['reason']).toContain('timed out')
    })

    it('no timeout when timeoutMs is not set', async () => {
      const bus = createEventBus()
      const gate = new ApprovalGate({ mode: 'required' }, bus)

      // Start waiting but resolve quickly via event
      const resultPromise = gate.waitForApproval('run-no-timeout', 'plan')

      setTimeout(() => {
        bus.emit({ type: 'approval:granted', runId: 'run-no-timeout' })
      }, 10)

      const result = await resultPromise
      expect(result).toBe('approved')
    })
  })

  describe('webhook', () => {
    it('does not call webhook when not configured', async () => {
      const bus = createEventBus()
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 30 }, bus)
      await gate.waitForApproval('run-1', 'plan')

      expect(fetchSpy).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('webhook failure does not block approval flow', async () => {
      const bus = createEventBus()
      const fetchSpy = vi.fn().mockRejectedValue(new Error('webhook down'))
      vi.stubGlobal('fetch', fetchSpy)

      const gate = new ApprovalGate({
        mode: 'required',
        timeoutMs: 50,
        webhookUrl: 'https://hooks.example.com/approve',
      }, bus)

      // Should not throw even though webhook fails
      const result = await gate.waitForApproval('run-1', 'plan')
      expect(result).toBe('timeout')

      vi.unstubAllGlobals()
    })

    it('webhook sends correct payload', async () => {
      const bus = createEventBus()
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchSpy)

      const gate = new ApprovalGate({
        mode: 'required',
        timeoutMs: 50,
        webhookUrl: 'https://hooks.example.com/approve',
      }, bus)

      await gate.waitForApproval('run-wh', { action: 'deploy' })

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://hooks.example.com/approve',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body.type).toBe('approval_requested')
      expect(body.runId).toBe('run-wh')
      expect(body.plan).toEqual({ action: 'deploy' })
      expect(body.contactId).toBeDefined()
      expect(body.channel).toBe('in-app')

      vi.unstubAllGlobals()
    })
  })

  describe('multiple concurrent approvals', () => {
    it('handles approval for correct run only', async () => {
      const bus = createEventBus()
      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 200 }, bus)

      const p1 = gate.waitForApproval('run-a', 'plan-a')
      const p2 = gate.waitForApproval('run-b', 'plan-b')

      setTimeout(() => {
        bus.emit({ type: 'approval:granted', runId: 'run-b' })
      }, 10)
      setTimeout(() => {
        bus.emit({ type: 'approval:rejected', runId: 'run-a', reason: 'denied' })
      }, 20)

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe('rejected')
      expect(r2).toBe('approved')
    })
  })

  describe('approval request object', () => {
    it('includes timeoutAt when timeoutMs is set', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({ mode: 'required', timeoutMs: 60_000 }, bus)

      // Start and immediately approve
      const p = gate.waitForApproval('run-t', 'plan')
      setTimeout(() => bus.emit({ type: 'approval:granted', runId: 'run-t' }), 10)
      await p

      const evt = events[0] as Record<string, unknown>
      const request = evt['request'] as Record<string, unknown>
      expect(request['timeoutAt']).toBeDefined()
    })

    it('does not include timeoutAt when no timeout', async () => {
      const bus = createEventBus()
      const events: unknown[] = []
      bus.on('approval:requested', (e) => events.push(e))

      const gate = new ApprovalGate({ mode: 'required' }, bus)

      const p = gate.waitForApproval('run-nt', 'plan')
      setTimeout(() => bus.emit({ type: 'approval:granted', runId: 'run-nt' }), 10)
      await p

      const evt = events[0] as Record<string, unknown>
      const request = evt['request'] as Record<string, unknown>
      expect(request['timeoutAt']).toBeUndefined()
    })
  })
})
