import { describe, expect, it, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import {
  InMemoryRunStore,
  createEventBus,
  type ModelRegistry,
} from '@dzupagent/core'

import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'
import type { RunExecutionContext } from '../runtime/run-worker.js'

describe('dzip-agent-run-executor native stream model gates', () => {
  it('forwards the server run signal through the real DzupAgent native stream', async () => {
    let markOpened: (() => void) | undefined
    let providerSignal: AbortSignal | undefined
    const opened = new Promise<void>(resolve => {
      markOpened = resolve
    })
    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(
        (
          _messages: BaseMessage[],
          options?: { signal?: AbortSignal },
        ) => {
          providerSignal = options?.signal
          markOpened?.()
          return new Promise<AsyncIterable<AIMessage>>(() => {})
        },
      ),
    } as unknown as BaseChatModel
    const registry = {
      getModel: vi.fn(() => model),
      getModelByName: vi.fn(() => model),
      getModelWithFallback: vi.fn(() => ({ model, provider: 'primary' })),
      getModelFallbackCandidates: vi.fn(() => [
        { model, provider: 'primary', modelName: 'primary-model' },
      ]),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    } as unknown as ModelRegistry
    const controller = new AbortController()
    const context: RunExecutionContext = {
      runId: 'run-native-stream-gates',
      agentId: 'agent-native-stream-gates',
      input: { message: 'hello' },
      metadata: {},
      agent: {
        id: 'agent-native-stream-gates',
        name: 'Native stream gates',
        instructions: 'Exercise the server streaming consumer.',
        modelTier: 'chat',
      },
      runStore: new InMemoryRunStore(),
      eventBus: createEventBus(),
      modelRegistry: registry,
      signal: controller.signal,
    }
    const executor = createDzupAgentRunExecutor({
      // Keeps the failure finite if the server ever drops the caller signal.
      guardrails: { modelTimeoutMs: 500 },
    })

    const pending = executor(context)
    await opened
    expect(providerSignal).toBeInstanceOf(AbortSignal)

    controller.abort()
    const error = await pending.catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MODEL_CANCELLED' })
    expect(providerSignal?.aborted).toBe(true)
    expect(model.stream).toHaveBeenCalledTimes(1)
  }, 5_000)
})
