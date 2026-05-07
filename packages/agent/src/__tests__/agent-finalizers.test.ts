/**
 * Direct unit tests for the agent post-run finalizer helpers:
 *
 *  - maybeUpdateSummary
 *  - maybeWriteBackMemory
 *
 * Both functions live in agent-finalizers.ts and are critical to the
 * agent's memory lifecycle. They have zero direct test coverage; they
 * are only exercised indirectly through DzupAgent integration tests.
 *
 * These tests mock their heavy dependencies (shouldSummarize, summarizeAndTrim,
 * MemoryService) to keep the suite fast and deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type * as ContextModule from '@dzupagent/context'
import {
  maybeUpdateSummary,
  maybeWriteBackMemory,
} from '../agent/agent-finalizers.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockShouldSummarize,
  mockSummarizeAndTrim,
} = vi.hoisted(() => ({
  mockShouldSummarize: vi.fn(),
  mockSummarizeAndTrim: vi.fn(),
}))

vi.mock('@dzupagent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>()
  return {
    ...actual,
    shouldSummarize: mockShouldSummarize,
    summarizeAndTrim: mockSummarizeAndTrim,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('summary')),
    model: 'gpt-4',
  } as unknown as BaseChatModel
}

const baseMessages = [new HumanMessage('hello'), new AIMessage('world')]

function makeConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'finalizer-test-agent',
    instructions: 'Test agent.',
    model: 'gpt-4',
    ...overrides,
  } satisfies DzupAgentConfig
}

// ---------------------------------------------------------------------------
// maybeUpdateSummary
// ---------------------------------------------------------------------------

describe('maybeUpdateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns previous summary unchanged when shouldSummarize returns false', async () => {
    mockShouldSummarize.mockReturnValue(false)

    const result = await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: 'previous summary',
      messages: baseMessages,
    })

    expect(result).toBe('previous summary')
    expect(mockSummarizeAndTrim).not.toHaveBeenCalled()
  })

  it('returns null when shouldSummarize is false and no previous summary', async () => {
    mockShouldSummarize.mockReturnValue(false)

    const result = await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: null,
      messages: baseMessages,
    })

    expect(result).toBeNull()
  })

  it('calls summarizeAndTrim when shouldSummarize returns true', async () => {
    mockShouldSummarize.mockReturnValue(true)
    mockSummarizeAndTrim.mockResolvedValue({ summary: 'new summary', messages: baseMessages })

    await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: null,
      messages: baseMessages,
    })

    expect(mockSummarizeAndTrim).toHaveBeenCalledOnce()
  })

  it('returns the new summary from summarizeAndTrim', async () => {
    mockShouldSummarize.mockReturnValue(true)
    mockSummarizeAndTrim.mockResolvedValue({ summary: 'updated summary', messages: baseMessages })

    const result = await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: 'old summary',
      messages: baseMessages,
    })

    expect(result).toBe('updated summary')
  })

  it('returns previous summary when summarizeAndTrim throws (non-fatal)', async () => {
    mockShouldSummarize.mockReturnValue(true)
    mockSummarizeAndTrim.mockRejectedValue(new Error('context window exceeded'))

    const result = await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: 'safe previous',
      messages: baseMessages,
    })

    expect(result).toBe('safe previous')
  })

  it('uses registry model for summarization when registry is configured', async () => {
    mockShouldSummarize.mockReturnValue(true)
    const registryModel = mockModel()
    mockSummarizeAndTrim.mockResolvedValue({ summary: 'registry summary', messages: baseMessages })

    const registry = { getModel: vi.fn(() => registryModel) }

    await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig({ registry: registry as never }),
      resolvedModel: mockModel(),
      conversationSummary: null,
      messages: baseMessages,
    })

    expect(registry.getModel).toHaveBeenCalledWith('chat')
    // summarizeAndTrim should be called with the registry's model
    expect(mockSummarizeAndTrim).toHaveBeenCalledWith(
      baseMessages,
      null,
      registryModel,
      expect.anything(),
    )
  })

  it('uses resolvedModel directly when no registry is configured', async () => {
    mockShouldSummarize.mockReturnValue(true)
    mockSummarizeAndTrim.mockResolvedValue({ summary: 'direct', messages: baseMessages })

    const model = mockModel()
    await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: model,
      conversationSummary: null,
      messages: baseMessages,
    })

    expect(mockSummarizeAndTrim).toHaveBeenCalledWith(
      baseMessages,
      null,
      model,
      expect.anything(),
    )
  })

  it('passes memoryFrame through to summarizeAndTrim config', async () => {
    mockShouldSummarize.mockReturnValue(true)
    mockSummarizeAndTrim.mockResolvedValue({ summary: 'with frame', messages: baseMessages })
    const frame = { snapshot: 'frame-data' }

    await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig(),
      resolvedModel: mockModel(),
      conversationSummary: null,
      messages: baseMessages,
      memoryFrame: frame,
    })

    expect(mockSummarizeAndTrim).toHaveBeenCalledWith(
      baseMessages,
      null,
      expect.anything(),
      expect.objectContaining({ memoryFrame: frame }),
    )
  })

  it('wires onFallback to eventBus when onFallback callback not set', async () => {
    mockShouldSummarize.mockReturnValue(true)

    const emittedEvents: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => emittedEvents.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    }

    let capturedOnFallback: ((reason: string, before: number, after: number) => void) | undefined
    mockSummarizeAndTrim.mockImplementation(async (
      _messages: unknown,
      _summary: unknown,
      _model: unknown,
      opts: { onFallback?: (reason: string, before: number, after: number) => void },
    ) => {
      capturedOnFallback = opts.onFallback
      opts.onFallback?.('compression', 100, 50)
      return { summary: 'compressed', messages: [] }
    })

    await maybeUpdateSummary({
      agentId: 'agent-1',
      config: makeConfig({ eventBus: eventBus as never }),
      resolvedModel: mockModel(),
      conversationSummary: null,
      messages: baseMessages,
    })

    expect(capturedOnFallback).toBeDefined()
    const contextFallback = emittedEvents.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['type'] === 'agent:context_fallback',
    )
    expect(contextFallback).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// maybeWriteBackMemory
// ---------------------------------------------------------------------------

describe('maybeWriteBackMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeMemoryConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
    return makeConfig({
      memoryNamespace: 'test-ns',
      memoryScope: { userId: 'user-1' },
      memory: {
        put: vi.fn(async () => undefined),
        get: vi.fn(async () => []),
        search: vi.fn(async () => []),
        delete: vi.fn(async () => false),
      } as never,
      ...overrides,
    })
  }

  it('is a no-op when content is empty string', async () => {
    const config = makeMemoryConfig()

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: '',
    })

    expect((config.memory as { put: ReturnType<typeof vi.fn> }).put).not.toHaveBeenCalled()
  })

  it('is a no-op when memoryWriteBack is false', async () => {
    const config = makeMemoryConfig({ memoryWriteBack: false })

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'Important result',
    })

    expect((config.memory as { put: ReturnType<typeof vi.fn> }).put).not.toHaveBeenCalled()
  })

  it('is a no-op when memory is not configured', async () => {
    const config = makeConfig({
      memoryNamespace: 'ns',
      memoryScope: { userId: 'u1' },
    })

    // Should not throw
    await expect(
      maybeWriteBackMemory({ agentId: 'agent-1', config, content: 'result' }),
    ).resolves.toBeUndefined()
  })

  it('is a no-op when memoryNamespace is not configured', async () => {
    const config = makeConfig({
      memoryScope: { userId: 'u1' },
      memory: { put: vi.fn(), get: vi.fn(), search: vi.fn(), delete: vi.fn() } as never,
    })

    await maybeWriteBackMemory({ agentId: 'agent-1', config, content: 'result' })

    expect((config.memory as { put: ReturnType<typeof vi.fn> }).put).not.toHaveBeenCalled()
  })

  it('is a no-op when memoryScope is not configured', async () => {
    const config = makeConfig({
      memoryNamespace: 'ns',
      memory: { put: vi.fn(), get: vi.fn(), search: vi.fn(), delete: vi.fn() } as never,
    })

    await maybeWriteBackMemory({ agentId: 'agent-1', config, content: 'result' })

    expect((config.memory as { put: ReturnType<typeof vi.fn> }).put).not.toHaveBeenCalled()
  })

  it('writes content to memory store with correct namespace and scope', async () => {
    const config = makeMemoryConfig()

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'Agent final response.',
    })

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    expect(put).toHaveBeenCalledOnce()
    const [namespace, scope] = put.mock.calls[0]!
    expect(namespace).toBe('test-ns')
    expect(scope).toEqual({ userId: 'user-1' })
  })

  it('stores agentId and timestamp in the memory record', async () => {
    const config = makeMemoryConfig()

    await maybeWriteBackMemory({
      agentId: 'my-agent',
      config,
      content: 'Content to persist.',
    })

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    const [,, , record] = put.mock.calls[0]!
    expect(record.agentId).toBe('my-agent')
    expect(typeof record.timestamp).toBe('number')
    expect(record.text).toBe('Content to persist.')
  })

  it('emits memory:written event after successful write', async () => {
    const emittedEvents: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => emittedEvents.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    }

    const config = makeMemoryConfig({ eventBus: eventBus as never })

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'Write-back content.',
    })

    const written = emittedEvents.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['type'] === 'memory:written',
    )
    expect(written).toBeDefined()
    if (written) {
      expect((written as Record<string, unknown>)['agentId']).toBe('agent-1')
      expect((written as Record<string, unknown>)['namespace']).toBe('test-ns')
    }
  })

  it('does not throw when memory.put rejects (non-fatal)', async () => {
    const config = makeMemoryConfig({
      memory: {
        put: vi.fn(async () => { throw new Error('store offline') }),
        get: vi.fn(async () => []),
        search: vi.fn(async () => []),
        delete: vi.fn(async () => false),
      } as never,
    })

    await expect(
      maybeWriteBackMemory({ agentId: 'agent-1', config, content: 'result' }),
    ).resolves.toBeUndefined()
  })

  it('stores expiresAt when ttlMs is configured', async () => {
    const config = makeMemoryConfig({ ttlMs: 60_000 })

    const tsBefore = Date.now()
    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'Expiring content.',
    })
    const tsAfter = Date.now()

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    const [,, , record] = put.mock.calls[0]!
    expect(record.expiresAt).toBeGreaterThanOrEqual(tsBefore + 60_000)
    expect(record.expiresAt).toBeLessThanOrEqual(tsAfter + 60_000)
  })

  it('does not include expiresAt when ttlMs is not configured', async () => {
    const config = makeMemoryConfig()

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'Non-expiring content.',
    })

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    const [,, , record] = put.mock.calls[0]!
    expect('expiresAt' in record).toBe(false)
  })

  it('emits memory:error and skips write when pii is block and PII detected', async () => {
    const emittedEvents: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => emittedEvents.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    }

    const config = makeMemoryConfig({
      security: { pii: 'block' },
      eventBus: eventBus as never,
    })

    // SSN is a PII pattern that should be detected
    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'User SSN is 123-45-6789.',
    })

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    expect(put).not.toHaveBeenCalled()

    const errorEvent = emittedEvents.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['type'] === 'memory:error',
    )
    expect(errorEvent).toBeDefined()
  })

  it('sanitizes PII before write when pii is redact', async () => {
    const config = makeMemoryConfig({ security: { pii: 'redact' } })

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      config,
      content: 'User credit card 4111111111111111.',
    })

    const put = (config.memory as { put: ReturnType<typeof vi.fn> }).put
    expect(put).toHaveBeenCalledOnce()
    const [,, , record] = put.mock.calls[0]!
    expect(record.text).not.toContain('4111111111111111')
  })

  it('includes runId in memory:written event when provided', async () => {
    const emittedEvents: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => emittedEvents.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    }

    const config = makeMemoryConfig({ eventBus: eventBus as never })

    await maybeWriteBackMemory({
      agentId: 'agent-1',
      runId: 'run-42',
      config,
      content: 'Some content.',
    })

    const written = emittedEvents.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['type'] === 'memory:written',
    )
    expect((written as Record<string, unknown> | undefined)?.['runId']).toBe('run-42')
  })
})
