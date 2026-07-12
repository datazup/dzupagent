import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ResilientModelInvoker } from '../llm/resilient-invoker.js'
import type { ModelFallbackCandidate } from '../llm/model-registry.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockModelOptions {
  /** If set, invoke() rejects with this error each call. */
  rejectWith?: Error
  /** If set, invoke() resolves with this message. */
  resolveWith?: BaseMessage
}

function createModel(opts: MockModelOptions): BaseChatModel {
  const fn = vi.fn(async () => {
    if (opts.rejectWith) throw opts.rejectWith
    return opts.resolveWith ?? new AIMessage({ content: 'ok' })
  })
  return { invoke: fn } as unknown as BaseChatModel
}

function candidate(
  provider: string,
  modelName: string,
  modelOpts: MockModelOptions,
): ModelFallbackCandidate {
  return {
    provider,
    modelName,
    model: createModel(modelOpts),
  }
}

interface RegistryStub {
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
}

function makeRegistryStub(): RegistryStub {
  return {
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
}

// Cast helper that does not use `any`/`as never`.
function asRegistry(stub: RegistryStub) {
  // ResilientModelInvoker only calls recordProviderSuccess / recordProviderFailure.
  // A structural stub satisfies that surface; we cast through `unknown` to
  // present it as the full ModelRegistry shape.
  return stub as unknown as ConstructorParameters<typeof ResilientModelInvoker>[1]
}

const MESSAGES = [new AIMessage({ content: 'hello' })]
const RETRY_FAST = { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 1 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResilientModelInvoker', () => {
  it('returns response from first candidate on success', async () => {
    const ok = new AIMessage({ content: 'first-ok' })
    const candidates = [
      candidate('a', 'model-a', { resolveWith: ok }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'should-not-call' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, { retry: RETRY_FAST })

    const result = await invoker.invoke(MESSAGES)

    expect(result.content).toBe('first-ok')
    expect(candidates[1]!.model.invoke).not.toHaveBeenCalled()
  })

  it('falls back to second candidate on transient error from first', async () => {
    const onFallback = vi.fn()
    const success = new AIMessage({ content: 'recovered' })
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 service unavailable') }),
      candidate('b', 'model-b', { resolveWith: success }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      onFallback,
      retry: RETRY_FAST,
    })

    const result = await invoker.invoke(MESSAGES)

    expect(result.content).toBe('recovered')
    expect(candidates[0]!.model.invoke).toHaveBeenCalled()
    expect(candidates[1]!.model.invoke).toHaveBeenCalled()
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  it('throws ALL_PROVIDERS_EXHAUSTED when all candidates fail with transient errors', async () => {
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('rate_limit hit') }),
      candidate('b', 'model-b', { rejectWith: new Error('overloaded') }),
      candidate('c', 'model-c', { rejectWith: new Error('429 too many requests') }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, { retry: RETRY_FAST })

    await expect(invoker.invoke(MESSAGES)).rejects.toMatchObject({
      code: 'ALL_PROVIDERS_EXHAUSTED',
    })
    for (const c of candidates) {
      expect(c.model.invoke).toHaveBeenCalled()
    }
  })

  it('throws ALL_PROVIDERS_EXHAUSTED when constructed with empty candidates', async () => {
    const invoker = new ResilientModelInvoker([], undefined, { retry: RETRY_FAST })
    await expect(invoker.invoke(MESSAGES)).rejects.toBeInstanceOf(ForgeError)
  })

  it('does not fallback on non-transient error (CONTEXT_LENGTH_EXCEEDED)', async () => {
    // invokeWithTimeout converts context-length errors into ForgeError(CONTEXT_LENGTH_EXCEEDED).
    // The underlying message must trip isContextLengthError() in retry.ts.
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('context_length_exceeded for prompt') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'should-not-call' }) }),
    ]
    const onFallback = vi.fn()
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      onFallback,
      retry: RETRY_FAST,
    })

    await expect(invoker.invoke(MESSAGES)).rejects.toMatchObject({
      code: 'CONTEXT_LENGTH_EXCEEDED',
    })
    expect(candidates[1]!.model.invoke).not.toHaveBeenCalled()
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('does not fallback on non-transient error (auth)', async () => {
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('Invalid API key') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'should-not-call' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, { retry: RETRY_FAST })

    await expect(invoker.invoke(MESSAGES)).rejects.toThrow('Invalid API key')
    expect(candidates[1]!.model.invoke).not.toHaveBeenCalled()
  })

  it('calls onFallback with failing and next provider names', async () => {
    const onFallback = vi.fn()
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 unavailable') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'ok' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      onFallback,
      retry: RETRY_FAST,
    })

    await invoker.invoke(MESSAGES)

    expect(onFallback).toHaveBeenCalledTimes(1)
    const [failingProvider, nextProvider, error] = onFallback.mock.calls[0]!
    expect(failingProvider).toBe('a')
    expect(nextProvider).toBe('b')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/503/)
  })

  it('does not call onFallback for the final failing candidate (no next)', async () => {
    const onFallback = vi.fn()
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 unavailable') }),
      candidate('b', 'model-b', { rejectWith: new Error('overloaded') }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      onFallback,
      retry: RETRY_FAST,
    })

    await expect(invoker.invoke(MESSAGES)).rejects.toMatchObject({
      code: 'ALL_PROVIDERS_EXHAUSTED',
    })
    // Hop emitted between a→b, but not after b (no next candidate).
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  it('updates registry breakers on success', async () => {
    const registry = makeRegistryStub()
    const candidates = [
      candidate('a', 'model-a', { resolveWith: new AIMessage({ content: 'ok' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, asRegistry(registry), { retry: RETRY_FAST })

    await invoker.invoke(MESSAGES)

    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('a')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('updates registry breakers on transient failure and success', async () => {
    const registry = makeRegistryStub()
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 unavailable') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'recovered' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, asRegistry(registry), { retry: RETRY_FAST })

    await invoker.invoke(MESSAGES)

    expect(registry.recordProviderFailure).toHaveBeenCalledTimes(1)
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('a', expect.any(Error))
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('b')
  })

  it('records failure for non-transient error before re-throwing', async () => {
    const registry = makeRegistryStub()
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('Invalid API key') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'never' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, asRegistry(registry), { retry: RETRY_FAST })

    await expect(invoker.invoke(MESSAGES)).rejects.toThrow('Invalid API key')
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('a', expect.any(Error))
    expect(registry.recordProviderSuccess).not.toHaveBeenCalled()
  })

  it('skips breaker updates when updateBreakers is false', async () => {
    const registry = makeRegistryStub()
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 unavailable') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'ok' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, asRegistry(registry), {
      updateBreakers: false,
      retry: RETRY_FAST,
    })

    await invoker.invoke(MESSAGES)

    expect(registry.recordProviderSuccess).not.toHaveBeenCalled()
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('survives onFallback callback throwing', async () => {
    const onFallback = vi.fn(() => { throw new Error('observer boom') })
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error('503 unavailable') }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'ok' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      onFallback,
      retry: RETRY_FAST,
    })

    const result = await invoker.invoke(MESSAGES)
    expect(result.content).toBe('ok')
    expect(onFallback).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// DZUPAGENT-ERR-H-06 — provider fallback error redaction
// ---------------------------------------------------------------------------

describe('ResilientModelInvoker — raw SDK error redaction (DZUPAGENT-ERR-H-06)', () => {
  // A transient ("503") error that also embeds a credentialed endpoint URL and
  // a bare host:port — exactly the shape provider SDKs surface.
  const LEAKY_TRANSIENT =
    '503 upstream error from https://api-key-abc123def456@llm.internal.example.com:8443/v1/chat and 10.9.8.7:8443'
  const LEAK_FRAGMENTS = [
    'llm.internal.example.com',
    'api-key-abc123def456',
    'https://',
    '10.9.8.7',
    '8443',
  ]

  it('sanitizes the ALL_PROVIDERS_EXHAUSTED message and context (no host/URL/key)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error(LEAKY_TRANSIENT) }),
      candidate('b', 'model-b', { rejectWith: new Error(LEAKY_TRANSIENT) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, { retry: RETRY_FAST })

    let caught: unknown
    try {
      await invoker.invoke(MESSAGES)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ForgeError)
    const fe = caught as ForgeError
    expect(fe.code).toBe('ALL_PROVIDERS_EXHAUSTED')

    // Caller-facing message must not leak the raw endpoint / key.
    for (const frag of LEAK_FRAGMENTS) {
      expect(fe.message).not.toContain(frag)
    }
    // context.errors must also be sanitized.
    const ctxErrors = (fe.context as { errors: Array<{ error: string }> }).errors
    for (const entry of ctxErrors) {
      for (const frag of LEAK_FRAGMENTS) {
        expect(entry.error).not.toContain(frag)
      }
    }
    errSpy.mockRestore()
  })

  it('logs full raw provider error admin-side (structured stderr)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const candidates = [
      candidate('a', 'model-a', { rejectWith: new Error(LEAKY_TRANSIENT) }),
      candidate('b', 'model-b', { resolveWith: new AIMessage({ content: 'ok' }) }),
    ]
    const invoker = new ResilientModelInvoker(candidates, undefined, { retry: RETRY_FAST })

    await invoker.invoke(MESSAGES)

    expect(errSpy).toHaveBeenCalled()
    const logged = JSON.parse(errSpy.mock.calls[0]![0] as string)
    expect(logged.component).toBe('resilient-invoker')
    expect(logged.provider).toBe('a')
    // Full raw detail is preserved admin-side for debugging.
    expect(logged.error.message).toContain('llm.internal.example.com')
    errSpy.mockRestore()
  })
})
