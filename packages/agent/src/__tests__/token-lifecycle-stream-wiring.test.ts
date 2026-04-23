/**
 * Tests for DzupAgent.stream() — tokenLifecyclePlugin integration.
 *
 * Verifies that when a `tokenLifecyclePlugin` is present on the agent
 * config, `plugin.onUsage()` is invoked with the real LLM token counts
 * returned from the model. Covers both streaming code paths:
 *
 *   1. Native streaming (model exposes `.stream()`, no model-wrapper
 *      middleware) — the plugin is called inline from the generator.
 *   2. Fallback path (no `.stream()` or a `wrapModelCall` middleware is
 *      active) — the plugin is wired through `executeGenerateRun` via
 *      the wrapped `options.onUsage` callback.
 *
 * Both paths must preserve any user-supplied `options.onUsage` callback.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { GenerateOptions } from '../agent/agent-types.js'
import type { AgentLoopPlugin } from '../token-lifecycle-wiring.js'

/**
 * Build a minimal `AgentLoopPlugin` whose methods are all `vi.fn()` spies.
 * `shouldHalt` defaults to `false` so the loop terminates naturally.
 */
function makeSpyPlugin(): AgentLoopPlugin & {
  onUsage: ReturnType<typeof vi.fn>
  shouldHalt: ReturnType<typeof vi.fn>
} {
  const onUsage = vi.fn()
  const shouldHalt = vi.fn(() => false)
  return {
    onUsage,
    trackPhase: vi.fn(),
    maybeCompress: vi.fn(async (messages, _model, existingSummary = null) => ({
      messages,
      summary: existingSummary,
      compressed: false,
    })),
    shouldHalt,
    status: 'ok',
    hooks: null,
    manager: null,
    reset: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as AgentLoopPlugin & {
    onUsage: ReturnType<typeof vi.fn>
    shouldHalt: ReturnType<typeof vi.fn>
  }
}

/**
 * Model that supports `.stream()`. Used to exercise the native streaming
 * path in `DzupAgent.stream()`.
 */
function createStreamingModel(
  responseText: string,
  usageMetadata: Record<string, unknown>,
): BaseChatModel {
  const mockModel = {
    invoke: vi.fn().mockResolvedValue(new AIMessage(responseText)),
    stream: vi.fn().mockImplementation(async function* () {
      const finalChunk = new AIMessage(responseText)
      ;(finalChunk as AIMessage & { usage_metadata: Record<string, unknown> }).usage_metadata =
        usageMetadata
      yield finalChunk
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'test-model',
  } as unknown as BaseChatModel
  return mockModel
}

/**
 * Model that does NOT expose `.stream()`. This forces `DzupAgent.stream()`
 * down the fallback path that delegates to `executeGenerateRun`.
 */
function createInvokeOnlyModel(
  responseText: string,
  usageMetadata: Record<string, unknown>,
): BaseChatModel {
  const response = new AIMessage(responseText)
  ;(response as AIMessage & { usage_metadata: Record<string, unknown> }).usage_metadata =
    usageMetadata
  const mockModel = {
    invoke: vi.fn().mockResolvedValue(response),
    bindTools: vi.fn().mockReturnThis(),
    model: 'test-model',
  } as unknown as BaseChatModel
  return mockModel
}

async function drainStream(
  agent: DzupAgent,
  messages: BaseMessage[],
  options?: GenerateOptions,
) {
  const events = []
  for await (const event of agent.stream(messages, options)) {
    events.push(event)
  }
  return events
}

describe('DzupAgent.stream() — tokenLifecyclePlugin wiring', () => {
  it('invokes plugin.onUsage with real token counts on the native streaming path', async () => {
    const plugin = makeSpyPlugin()
    const model = createStreamingModel('Hello world', {
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
    })

    const agent = new DzupAgent({
      id: 'token-plugin-native',
      instructions: 'Test agent.',
      model,
      tokenLifecyclePlugin: plugin,
    })

    await drainStream(agent, [new HumanMessage('Hi')])

    expect(plugin.onUsage).toHaveBeenCalledTimes(1)
    const usage = plugin.onUsage.mock.calls[0][0] as TokenUsage
    expect(usage.inputTokens).toBe(123)
    expect(usage.outputTokens).toBe(45)
    expect(typeof usage.model).toBe('string')
  })

  it('invokes plugin.onUsage on the fallback (non-streaming) path', async () => {
    const plugin = makeSpyPlugin()
    const model = createInvokeOnlyModel('Hello fallback', {
      input_tokens: 77,
      output_tokens: 11,
      total_tokens: 88,
    })

    const agent = new DzupAgent({
      id: 'token-plugin-fallback',
      instructions: 'Test agent.',
      model,
      tokenLifecyclePlugin: plugin,
    })

    await drainStream(agent, [new HumanMessage('Hi')])

    expect(plugin.onUsage).toHaveBeenCalled()
    const usage = plugin.onUsage.mock.calls[0][0] as TokenUsage
    expect(usage.inputTokens).toBe(77)
    expect(usage.outputTokens).toBe(11)
  })

  it('preserves the user-supplied options.onUsage callback', async () => {
    const plugin = makeSpyPlugin()
    const model = createStreamingModel('Hi back', {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    })

    const agent = new DzupAgent({
      id: 'token-plugin-user-callback',
      instructions: 'Test agent.',
      model,
      tokenLifecyclePlugin: plugin,
    })

    const userCallback = vi.fn()
    await drainStream(agent, [new HumanMessage('Hi')], { onUsage: userCallback })

    expect(plugin.onUsage).toHaveBeenCalledTimes(1)
    expect(userCallback).toHaveBeenCalledTimes(1)
    expect(userCallback.mock.calls[0][0]).toEqual(plugin.onUsage.mock.calls[0][0])
  })

  it('does not require a plugin to call user-supplied onUsage', async () => {
    // No tokenLifecyclePlugin configured — user callback should still fire.
    const model = createStreamingModel('ok', {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
    })

    const agent = new DzupAgent({
      id: 'no-plugin',
      instructions: 'Test agent.',
      model,
    })

    const userCallback = vi.fn()
    await drainStream(agent, [new HumanMessage('Hi')], { onUsage: userCallback })

    expect(userCallback).toHaveBeenCalledTimes(1)
    const usage = userCallback.mock.calls[0][0] as TokenUsage
    expect(usage.inputTokens).toBe(3)
    expect(usage.outputTokens).toBe(2)
  })
})
