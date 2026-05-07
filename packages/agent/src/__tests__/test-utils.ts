/**
 * Shared test helpers for the @dzupagent/agent package.
 *
 * All factories return properly-typed objects so test files never need
 * `as never` or scattered `as unknown as T` casts.  Each factory does a
 * single structural cast internally so the call sites are clean.
 */
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { vi } from 'vitest'
import type { DzupEventBus, ModelRegistry } from '@dzupagent/core'
import type { MemoryService } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// BaseChatModel mock
// ---------------------------------------------------------------------------

/**
 * Returns a minimal BaseChatModel mock whose `invoke()` resolves to an
 * AIMessage with the given content.  The `invoke` spy is exposed on the
 * returned object so callers can assert on it directly.
 */
export function makeMockModel(content = 'ok'): BaseChatModel & { invoke: ReturnType<typeof vi.fn> } {
  const mock = {
    invoke: vi.fn(async () => new AIMessage({ content })),
  }
  return mock as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

// ---------------------------------------------------------------------------
// MemoryService mock
// ---------------------------------------------------------------------------

/**
 * Returns a minimal MemoryService mock with spied `get` and `put`.
 * Optionally, pre-seed the records returned by `get`.
 */
export function makeMockMemoryService(
  records: Array<Record<string, unknown>> = [],
): MemoryService & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const mock = {
    get: vi.fn(async () => records),
    put: vi.fn(async () => undefined),
  }
  return mock as unknown as MemoryService & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
}

// ---------------------------------------------------------------------------
// ModelRegistry mock
// ---------------------------------------------------------------------------

/**
 * Returns a mock ModelRegistry that always resolves to the given model.
 * All circuit-breaker methods are exposed as vi.fn() spies.
 */
export function makeMockRegistry(
  model: BaseChatModel,
  provider = 'mock-provider',
): ModelRegistry & {
  getModel: ReturnType<typeof vi.fn>
  getModelByName: ReturnType<typeof vi.fn>
  getModelWithFallback: ReturnType<typeof vi.fn>
  getModelFallbackCandidates: ReturnType<typeof vi.fn>
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
} {
  const mock = {
    getModel: vi.fn(() => model),
    getModelByName: vi.fn(() => model),
    getModelWithFallback: vi.fn(() => ({ model, provider })),
    getModelFallbackCandidates: vi.fn(() => [{ model, provider, modelName: `${provider}-model` }]),
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
  return mock as unknown as ReturnType<typeof makeMockRegistry>
}

// ---------------------------------------------------------------------------
// DzupEventBus mock
// ---------------------------------------------------------------------------

/**
 * Returns a mock DzupEventBus with all methods as vi.fn() spies.
 */
export function makeMockEventBus(): DzupEventBus & {
  emit: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  onAny: ReturnType<typeof vi.fn>
} {
  const mock = {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
  }
  return mock as unknown as ReturnType<typeof makeMockEventBus>
}

// ---------------------------------------------------------------------------
// StructuredToolInterface mock
// ---------------------------------------------------------------------------

/**
 * Returns a minimal StructuredToolInterface mock with a proper Zod schema
 * (avoids `schema: {} as never`).
 */
export function makeMockTool(
  name: string,
  result: string | Record<string, unknown> = 'ok',
): StructuredToolInterface {
  return {
    name,
    description: `Mock tool: ${name}`,
    schema: z.object({}),
    lc_namespace: ['dzupagent', 'test', 'tools'],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}
