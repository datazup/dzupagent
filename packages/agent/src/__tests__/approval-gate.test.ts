import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import { ApprovalGate } from '../approval/approval-gate.js'

describe('ApprovalGate', () => {
  it('returns approved immediately in auto mode', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'auto' }, bus)
    const result = await gate.waitForApproval('run-1', { plan: 'test' })
    expect(result).toBe('approved')
  })

  it('waits for approval event in required mode', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'required' }, bus)

    // Start waiting (non-blocking)
    const resultPromise = gate.waitForApproval('run-1', { plan: 'deploy' })

    // Simulate external approval
    setTimeout(() => {
      bus.emit({ type: 'approval:granted', runId: 'run-1' })
    }, 10)

    const result = await resultPromise
    expect(result).toBe('approved')
  })

  it('waits for rejection event in required mode', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'required' }, bus)

    const resultPromise = gate.waitForApproval('run-1', { plan: 'risky' })

    setTimeout(() => {
      bus.emit({ type: 'approval:rejected', runId: 'run-1', reason: 'too risky' })
    }, 10)

    const result = await resultPromise
    expect(result).toBe('rejected')
  })

  it('ignores events for other runs', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 100 }, bus)

    const resultPromise = gate.waitForApproval('run-1', { plan: 'test' })

    // Approve a different run — should be ignored
    setTimeout(() => {
      bus.emit({ type: 'approval:granted', runId: 'run-OTHER' })
    }, 10)

    // Our run should timeout
    const result = await resultPromise
    expect(result).toBe('timeout')
  })

  it('times out and returns timeout result', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)

    const result = await gate.waitForApproval('run-1', { plan: 'slow' })
    expect(result).toBe('timeout')
  })

  it('conditional mode: skips approval when condition returns false', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({
      mode: 'conditional',
      condition: async () => false,
    }, bus)

    const result = await gate.waitForApproval('run-1', { plan: 'safe' }, {
      agentId: 'a1',
      runId: 'run-1',
      metadata: {},
    })
    expect(result).toBe('approved')
  })

  it('conditional mode: requires approval when condition returns true', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({
      mode: 'conditional',
      condition: async () => true,
      timeoutMs: 50,
    }, bus)

    // Condition returns true → needs approval → will timeout
    const result = await gate.waitForApproval('run-1', { plan: 'risky' }, {
      agentId: 'a1',
      runId: 'run-1',
      metadata: {},
    })
    expect(result).toBe('timeout')
  })

  it('emits approval:requested event', async () => {
    const bus = createEventBus()
    const events: unknown[] = []
    bus.on('approval:requested', (e) => events.push(e))

    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)
    await gate.waitForApproval('run-1', { plan: 'test' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'approval:requested', runId: 'run-1' })
  })

  it('calls webhook when configured', async () => {
    const bus = createEventBus()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const gate = new ApprovalGate({
      mode: 'required',
      timeoutMs: 50,
      webhookUrl: 'https://example.com/webhook',
    }, bus)

    await gate.waitForApproval('run-1', { plan: 'notify' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ method: 'POST' }),
    )

    vi.unstubAllGlobals()
  })
})
