/**
 * Shared test helpers for the @dzupagent/codegen package.
 *
 * All factories return properly-typed objects so test files never need
 * `as never` or `as unknown as T` casts.
 */
import { vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelRegistry } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// LLM model mock
// ---------------------------------------------------------------------------

export interface MockLlmModel {
  invoke: ReturnType<typeof vi.fn>
  model: string
}

/**
 * Returns a minimal LLM mock whose `invoke()` resolves to the given content.
 * The returned object satisfies the structural requirements of BaseChatModel
 * as accessed by LessonExtractor / ReflectionNode (invoke + model).
 */
export function makeMockLlmModel(responseContent: string): MockLlmModel {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: responseContent,
      usage_metadata: { input_tokens: 100, output_tokens: 50 },
    }),
    model: 'test-model',
  }
}

// ---------------------------------------------------------------------------
// ModelRegistry mock
// ---------------------------------------------------------------------------

export interface MockCodegenRegistry
  extends Pick<ModelRegistry, 'getModel'> {
  getModel: ReturnType<typeof vi.fn>
}

/**
 * Returns a minimal ModelRegistry mock that always returns `model` from
 * `getModel()`. Typed as a Pick<ModelRegistry, 'getModel'> so it satisfies
 * the registry field on LessonExtractor and ReflectionNode without an
 * `as never` cast.
 */
export function makeMockCodegenRegistry(
  model: MockLlmModel,
): MockCodegenRegistry {
  return {
    getModel: vi.fn().mockReturnValue(model as unknown as BaseChatModel),
  }
}
