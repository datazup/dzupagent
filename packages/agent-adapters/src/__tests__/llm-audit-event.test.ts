/**
 * Audit-finding H-25 — verifies AdapterStreamRunner emits a structured
 * LlmInvocationRecord for every terminal LLM call (success + failure paths)
 * via the injected `auditSink` callback. Audit-sink failures must never
 * break the LLM call path.
 */
import { describe, it, expect, vi } from 'vitest'
import type { LlmInvocationRecord } from '@dzupagent/core'

import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'
import type { AdapterProviderId, AgentEvent, AgentInput, TokenUsage } from '../types.js'
import { collectEvents } from './test-helpers.js'

type FakeRaw =
  | { kind: 'completed'; result: string; usage?: TokenUsage; durationMs: number }
  | { kind: 'failed'; error: string; code?: string }

function buildSuccessSource(usage?: TokenUsage): AdapterStreamSource<FakeRaw> {
  return {
    providerId: 'openai' satisfies AdapterProviderId,
    async *open(_input: AgentInput, _signal: AbortSignal): AsyncIterable<FakeRaw> {
      yield { kind: 'completed', result: 'ok', durationMs: 42, ...(usage ? { usage } : {}) }
    },
    mapRawEvent(raw: FakeRaw, ctx: StreamContext): AgentEvent | null {
      if (raw.kind !== 'completed') return null
      return {
        type: 'adapter:completed',
        providerId: 'openai',
        sessionId: ctx.sessionId,
        result: raw.result,
        ...(raw.usage ? { usage: raw.usage } : {}),
        durationMs: raw.durationMs,
        timestamp: Date.now(),
      }
    },
  }
}

function buildFailureSource(): AdapterStreamSource<FakeRaw> {
  return {
    providerId: 'openai' satisfies AdapterProviderId,
    async *open(_input: AgentInput, _signal: AbortSignal): AsyncIterable<FakeRaw> {
      throw new Error('upstream-network-blew-up')
    },
    mapRawEvent(): AgentEvent | null {
      return null
    },
  }
}

describe('AdapterStreamRunner — H-25 LLM audit emission', () => {
  it('emits a completed record with usage when the source yields adapter:completed', async () => {
    const sink = vi.fn<(record: LlmInvocationRecord) => void>()
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-1',
      auditSink: sink,
      auditModel: 'gpt-4o-mini',
      auditRunId: 'run-42',
      auditTenantId: 'tenant-1',
    })

    const input: AgentInput = { prompt: 'hello world', systemPrompt: 'be brief' }
    const usage: TokenUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      costCents: 0.42,
    }

    const events = await collectEvents(runner.run(buildSuccessSource(usage), input))

    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)
    expect(sink).toHaveBeenCalledTimes(1)
    const record = sink.mock.calls[0]![0]
    expect(record.providerId).toBe('openai')
    expect(record.model).toBe('gpt-4o-mini')
    expect(record.runId).toBe('run-42')
    expect(record.tenantId).toBe('tenant-1')
    expect(record.status).toBe('completed')
    expect(record.errorCode).toBeUndefined()
    expect(record.promptCharCount).toBe('hello world'.length)
    expect(record.systemPromptCharCount).toBe('be brief'.length)
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
    expect(record.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    })
    expect(record.costCents).toBe(0.42)
    expect(typeof record.startedAt).toBe('string')
    // Valid ISO-8601
    expect(() => new Date(record.startedAt).toISOString()).not.toThrow()
  })

  it('emits a failed record when the source throws (non-aborted)', async () => {
    const sink = vi.fn<(record: LlmInvocationRecord) => void>()
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-2',
      auditSink: sink,
      auditModel: 'gpt-4o-mini',
    })

    const events = await collectEvents(runner.run(buildFailureSource(), { prompt: 'hi' }))

    expect(events.some((e) => e.type === 'adapter:failed')).toBe(true)
    expect(sink).toHaveBeenCalledTimes(1)
    const record = sink.mock.calls[0]![0]
    expect(record.status).toBe('failed')
    expect(record.errorCode).toBe('ADAPTER_EXECUTION_FAILED')
    expect(record.usage).toBeUndefined()
    expect(record.costCents).toBeUndefined()
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits exactly once even when multiple terminal events flow through', async () => {
    const sink = vi.fn<(record: LlmInvocationRecord) => void>()
    const source: AdapterStreamSource<FakeRaw> = {
      providerId: 'openai',
      async *open(): AsyncIterable<FakeRaw> {
        yield { kind: 'completed', result: 'first', durationMs: 1 }
        yield { kind: 'completed', result: 'second', durationMs: 2 }
      },
      mapRawEvent(raw: FakeRaw, ctx: StreamContext): AgentEvent | null {
        if (raw.kind !== 'completed') return null
        return {
          type: 'adapter:completed',
          providerId: 'openai',
          sessionId: ctx.sessionId,
          result: raw.result,
          durationMs: raw.durationMs,
          timestamp: Date.now(),
        }
      },
    }
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-3',
      auditSink: sink,
      auditModel: 'gpt-4o-mini',
    })

    await collectEvents(runner.run(source, { prompt: 'hi' }))
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no auditSink is configured', async () => {
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-4',
    })
    const events = await collectEvents(runner.run(buildSuccessSource(), { prompt: 'hi' }))
    // Should still produce the normal stream events.
    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)
  })

  it('swallows sink errors so audit failures never break the LLM call', async () => {
    const sink = vi.fn<(record: LlmInvocationRecord) => void>(() => {
      throw new Error('sink boom')
    })
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-5',
      auditSink: sink,
      auditModel: 'gpt-4o-mini',
    })

    // Must not reject — the LLM call path is preserved.
    const events = await collectEvents(runner.run(buildSuccessSource(), { prompt: 'hi' }))
    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('falls back to model from startedExtra when auditModel is not provided', async () => {
    const sink = vi.fn<(record: LlmInvocationRecord) => void>()
    const runner = new AdapterStreamRunner<FakeRaw>({
      emitStartedImmediately: true,
      initialSessionId: 's-6',
      auditSink: sink,
      startedExtra: { model: 'gpt-4o' },
    })
    await collectEvents(runner.run(buildSuccessSource(), { prompt: 'hi' }))
    expect(sink.mock.calls[0]![0].model).toBe('gpt-4o')
  })
})
