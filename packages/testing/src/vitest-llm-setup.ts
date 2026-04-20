/**
 * Vitest global setup helper for LlmRecorder.
 *
 * Usage — in vitest.config.ts:
 *
 *   import { defineConfig } from 'vitest/config'
 *   export default defineConfig({
 *     test: {
 *       setupFiles: ['@dzupagent/testing/vitest-llm-setup'],
 *     },
 *   })
 *
 * This module exports `withRecordedRegistry` — a per-test factory that wires
 * a fresh ModelRegistry with an LlmRecorder pre-attached and tears it down
 * cleanly after each test.
 *
 * Example:
 *
 *   import { withRecordedRegistry } from '@dzupagent/testing'
 *
 *   describe('my test', () => {
 *     it('replays a saved response', async () => {
 *       const { registry, recorder } = withRecordedRegistry({
 *         fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
 *       })
 *       // recorder.seedFixture(...) or rely on existing fixture files
 *       const model = registry.getModel('chat')
 *       // ... invoke model
 *     })
 *   })
 */

import { LlmRecorder } from './llm-recorder.js'
import type { LlmRecorderOptions } from './llm-recorder.js'
import { ModelRegistry } from '@dzupagent/core'
import type { LLMProviderConfig } from '@dzupagent/core'

export interface RecordedRegistry {
  registry: ModelRegistry
  recorder: LlmRecorder
}

/**
 * Creates a ModelRegistry wired with an LlmRecorder.
 * Registers a no-op stub provider so `getModel()` resolves without real keys.
 * The recorder intercepts all calls before they reach the network.
 */
export function withRecordedRegistry(options: LlmRecorderOptions): RecordedRegistry {
  const recorder = new LlmRecorder(options)
  const registry = new ModelRegistry()

  // Stub provider — keys are never used in replay mode because the recorder
  // short-circuits in beforeInvoke. In record mode real keys must be in env.
  const stubProvider: LLMProviderConfig = {
    provider: 'anthropic',
    apiKey: process.env['ANTHROPIC_API_KEY'] ?? 'test-key',
    priority: 1,
    models: {
      chat: { name: 'claude-haiku-4-5-20251001', maxTokens: 1024 },
      codegen: { name: 'claude-sonnet-4-6', maxTokens: 8192 },
      reasoning: { name: 'claude-opus-4-5', maxTokens: 4096 },
    },
  }

  registry.addProvider(stubProvider).use(recorder)
  return { registry, recorder }
}

export { LlmRecorder }
export type { LlmRecorderOptions }
