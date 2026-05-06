/**
 * Audit-finding H-25 — verifies the `llm:invocation_recorded` event is wired
 * into the `DzupEvent` discriminated union and that
 * `attachLlmAuditEventBridge` forwards records onto the bus.
 */
import { describe, it, expect, vi } from 'vitest'

import { createEventBus } from '../events/event-bus.js'
import type { DzupEvent, LlmInvocationRecord } from '../events/event-types.js'
import { attachLlmAuditEventBridge, type LlmAuditSink } from '../events/llm-audit-bridge.js'

describe('llm:invocation_recorded — H-25', () => {
  it('LlmInvocationRecord has the documented shape and the event union accepts it', () => {
    const record: LlmInvocationRecord = {
      providerId: 'openai',
      model: 'gpt-4o-mini',
      runId: 'run-1',
      tenantId: 'tenant-x',
      promptCharCount: 12,
      systemPromptCharCount: 4,
      status: 'completed',
      durationMs: 100,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
      costCents: 0.5,
      startedAt: new Date().toISOString(),
    }
    const event: DzupEvent = { type: 'llm:invocation_recorded', ...record }
    // Compile-time assertion: discriminator narrows correctly
    if (event.type === 'llm:invocation_recorded') {
      expect(event.providerId).toBe('openai')
      expect(event.usage?.totalTokens).toBe(15)
    }
  })

  it('attachLlmAuditEventBridge emits each record onto the bus as llm:invocation_recorded', () => {
    const bus = createEventBus()
    const observed: DzupEvent[] = []
    bus.on('llm:invocation_recorded', (e) => { observed.push(e) })

    const sink: LlmAuditSink = attachLlmAuditEventBridge(bus)
    const record: LlmInvocationRecord = {
      providerId: 'claude',
      model: 'claude-haiku-4-5-20251001',
      promptCharCount: 7,
      status: 'completed',
      durationMs: 12,
      startedAt: '2026-01-01T00:00:00.000Z',
    }
    sink(record)

    expect(observed).toHaveLength(1)
    const ev = observed[0]!
    if (ev.type !== 'llm:invocation_recorded') throw new Error('wrong event type')
    expect(ev.providerId).toBe('claude')
    expect(ev.model).toBe('claude-haiku-4-5-20251001')
    expect(ev.promptCharCount).toBe(7)
    expect(ev.status).toBe('completed')
    expect(ev.durationMs).toBe(12)
    expect(ev.startedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('forwards failed-status records with their errorCode intact', () => {
    const bus = createEventBus()
    const observed: DzupEvent[] = []
    bus.on('llm:invocation_recorded', (e) => { observed.push(e) })

    const sink = attachLlmAuditEventBridge(bus)
    sink({
      providerId: 'openai',
      model: 'gpt-4o-mini',
      promptCharCount: 5,
      status: 'failed',
      errorCode: 'ADAPTER_EXECUTION_FAILED',
      durationMs: 33,
      startedAt: new Date().toISOString(),
    })

    expect(observed).toHaveLength(1)
    const ev = observed[0]!
    if (ev.type !== 'llm:invocation_recorded') throw new Error('wrong event type')
    expect(ev.status).toBe('failed')
    expect(ev.errorCode).toBe('ADAPTER_EXECUTION_FAILED')
    expect(ev.usage).toBeUndefined()
    expect(ev.costCents).toBeUndefined()
  })

  it('swallows bus.emit errors so the LLM call path is never broken', () => {
    const failingBus = {
      emit: vi.fn(() => { throw new Error('bus down') }),
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(),
    }
    const errors: string[] = []
    const sink = attachLlmAuditEventBridge(failingBus, {
      info: () => {},
      warn: () => {},
      error: (msg: string) => { errors.push(msg) },
      debug: () => {},
    } as unknown as Parameters<typeof attachLlmAuditEventBridge>[1])

    expect(() => sink({
      providerId: 'openai',
      model: 'gpt-4o-mini',
      promptCharCount: 1,
      status: 'completed',
      durationMs: 0,
      startedAt: new Date().toISOString(),
    })).not.toThrow()
    expect(errors[0]).toMatch(/llm-audit-bridge/)
  })
})
