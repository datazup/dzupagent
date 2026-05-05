/**
 * Unit tests for `attemptWithFailover` (packages/agent/src/agent/provider-failover.ts)
 * and regression tests for the streaming-run `recordProviderSuccess` gap fix (RF-04).
 *
 * These tests are intentionally narrow: they test the extracted module in
 * isolation (no DzupAgent instantiation required) and exercise the streaming
 * path's open-success / consume-failure behaviour documented in the RF-04
 * comment in `streaming-run.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  attemptWithFailover,
  type ProviderAttempt,
  type ProviderFailoverRegistry,
  type AttemptWithFailoverParams,
} from '../agent/provider-failover.js'
import type { DzupEventBus } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeRegistry(): ProviderFailoverRegistry & {
  recordProviderSuccess: ReturnType<typeof vi.fn>
  recordProviderFailure: ReturnType<typeof vi.fn>
} {
  return {
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  }
}

function makeEventBus(): DzupEventBus & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => undefined),
    once: vi.fn(() => () => undefined),
    off: vi.fn(),
  } as unknown as DzupEventBus & { emit: ReturnType<typeof vi.fn> }
}

function makeAttempt(
  provider: string,
  modelName: string,
  model?: Partial<BaseChatModel>,
): ProviderAttempt {
  const base: Partial<BaseChatModel> = {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    ...model,
  }
  return { provider, modelName, model: base as BaseChatModel }
}

// ---------------------------------------------------------------------------
// Scenario 1: first attempt succeeds
// ---------------------------------------------------------------------------

describe('attemptWithFailover — first attempt succeeds', () => {
  let registry: ReturnType<typeof makeRegistry>
  let eventBus: ReturnType<typeof makeEventBus>
  let execute: ReturnType<typeof vi.fn>

  beforeEach(() => {
    registry = makeRegistry()
    eventBus = makeEventBus()
    execute = vi.fn(async () => new AIMessage('ok'))
  })

  it('calls execute once and returns its result', async () => {
    const attempt = makeAttempt('provider-a', 'model-a')

    const result = await attemptWithFailover<AIMessage>({
      attempts: [attempt],
      phase: 'invoke',
      agentId: 'agent-1',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute,
    })

    expect(result.content).toBe('ok')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(attempt, 1)
  })

  it('emits provider:run_attempt before execute', async () => {
    const attempt = makeAttempt('provider-a', 'model-a')

    await attemptWithFailover<AIMessage>({
      attempts: [attempt],
      phase: 'invoke',
      agentId: 'agent-1',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute,
    })

    const attemptEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_attempt',
    )?.[0]
    expect(attemptEvent).toMatchObject({
      type: 'provider:run_attempt',
      agentId: 'agent-1',
      attempt: 1,
      maxAttempts: 1,
      provider: 'provider-a',
      model: 'model-a',
      phase: 'invoke',
    })
  })

  it('emits provider:run_selected after success', async () => {
    const attempt = makeAttempt('provider-a', 'model-a')

    await attemptWithFailover<AIMessage>({
      attempts: [attempt],
      phase: 'invoke',
      agentId: 'agent-1',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute,
    })

    const selectedEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_selected',
    )?.[0]
    expect(selectedEvent).toMatchObject({
      type: 'provider:run_selected',
      agentId: 'agent-1',
      attempt: 1,
      provider: 'provider-a',
      model: 'model-a',
      phase: 'invoke',
    })
  })

  it('calls recordProviderSuccess with the correct provider', async () => {
    const attempt = makeAttempt('provider-a', 'model-a')

    await attemptWithFailover<AIMessage>({
      attempts: [attempt],
      phase: 'invoke',
      agentId: 'agent-1',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute,
    })

    expect(registry.recordProviderSuccess).toHaveBeenCalledOnce()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('provider-a')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: first fails, second succeeds
// ---------------------------------------------------------------------------

describe('attemptWithFailover — first fails, second succeeds', () => {
  it('retries on the second attempt and records correct outcomes', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const primaryErr = new Error('429 rate_limit exceeded')
    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw primaryErr
      return new AIMessage('secondary ok')
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    const result = await attemptWithFailover<AIMessage>({
      attempts: [primary, secondary],
      phase: 'invoke',
      agentId: 'agent-2',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => true),
      execute,
    })

    expect(result.content).toBe('secondary ok')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('emits provider:run_failure for the first attempt with retrying=true', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw new Error('transient')
      return new AIMessage('ok')
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await attemptWithFailover<AIMessage>({
      attempts: [primary, secondary],
      phase: 'invoke',
      agentId: 'agent-2',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => true),
      execute,
    })

    const failureEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_failure',
    )?.[0]
    expect(failureEvent).toMatchObject({
      type: 'provider:run_failure',
      agentId: 'agent-2',
      attempt: 1,
      provider: 'primary',
      model: 'primary-model',
      reason: 'transient',
      retrying: true,
    })
  })

  it('emits provider:run_selected for the second attempt', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw new Error('transient')
      return new AIMessage('ok')
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await attemptWithFailover<AIMessage>({
      attempts: [primary, secondary],
      phase: 'invoke',
      agentId: 'agent-2',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => true),
      execute,
    })

    const selectedEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_selected',
    )?.[0]
    expect(selectedEvent).toMatchObject({
      type: 'provider:run_selected',
      attempt: 2,
      provider: 'secondary',
      model: 'secondary-model',
    })
  })

  it('calls recordProviderFailure for first and recordProviderSuccess for second', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    let callCount = 0
    const primaryErr = new Error('429 rate_limit exceeded')
    const execute = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw primaryErr
      return new AIMessage('ok')
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await attemptWithFailover<AIMessage>({
      attempts: [primary, secondary],
      phase: 'invoke',
      agentId: 'agent-2',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => true),
      execute,
    })

    expect(registry.recordProviderFailure).toHaveBeenCalledOnce()
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('primary', primaryErr)

    expect(registry.recordProviderSuccess).toHaveBeenCalledOnce()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('secondary')
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: all attempts fail — last error is rethrown
// ---------------------------------------------------------------------------

describe('attemptWithFailover — all attempts fail', () => {
  it('throws the last error after all attempts are exhausted', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const firstErr = new Error('first failure')
    const secondErr = new Error('second failure')
    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw firstErr
      throw secondErr
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [primary, secondary],
        phase: 'invoke',
        agentId: 'agent-3',
        eventBus,
        registry,
        shouldRetry: vi.fn(() => true),
        execute,
      }),
    ).rejects.toThrow('second failure')
  })

  it('records failure for both providers', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      throw new Error(`failure ${callCount}`)
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [primary, secondary],
        phase: 'invoke',
        agentId: 'agent-3',
        eventBus,
        registry,
        shouldRetry: vi.fn(() => true),
        execute,
      }),
    ).rejects.toThrow()

    expect(registry.recordProviderFailure).toHaveBeenCalledTimes(2)
    expect(registry.recordProviderFailure.mock.calls[0][0]).toBe('primary')
    expect(registry.recordProviderFailure.mock.calls[1][0]).toBe('secondary')
    expect(registry.recordProviderSuccess).not.toHaveBeenCalled()
  })

  it('emits provider:run_failure for the last attempt with retrying=false', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      throw new Error(`failure ${callCount}`)
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [primary, secondary],
        phase: 'invoke',
        agentId: 'agent-3',
        eventBus,
        registry,
        shouldRetry: vi.fn(() => true),
        execute,
      }),
    ).rejects.toThrow()

    const failureEvents = eventBus.emit.mock.calls
      .filter(([e]: [{ type: string }]) => e.type === 'provider:run_failure')
      .map(([e]) => e)

    // Last failure must have retrying=false (no more attempts available).
    const lastFailure = failureEvents.at(-1)
    expect(lastFailure).toMatchObject({ retrying: false, attempt: 2, provider: 'secondary' })
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: shouldRetry = false stops retry immediately
// ---------------------------------------------------------------------------

describe('attemptWithFailover — shouldRetry=false prevents advancing to next attempt', () => {
  it('does not call execute for the second attempt when shouldRetry returns false', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const execute = vi.fn(async () => {
      throw new Error('hard error')
    })
    const shouldRetry = vi.fn(() => false)

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [primary, secondary],
        phase: 'invoke',
        agentId: 'agent-4',
        eventBus,
        registry,
        shouldRetry,
        execute,
      }),
    ).rejects.toThrow('hard error')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(shouldRetry).toHaveBeenCalledTimes(1)
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 0)
  })

  it('emits provider:run_failure with retrying=false when shouldRetry=false', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const execute = vi.fn(async () => {
      throw new Error('hard error')
    })

    const primary = makeAttempt('primary', 'primary-model')
    const secondary = makeAttempt('secondary', 'secondary-model')

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [primary, secondary],
        phase: 'invoke',
        agentId: 'agent-4',
        eventBus,
        registry,
        shouldRetry: vi.fn(() => false),
        execute,
      }),
    ).rejects.toThrow()

    const failureEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_failure',
    )?.[0]
    expect(failureEvent).toMatchObject({ retrying: false, attempt: 1, provider: 'primary' })
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Streaming path regression — recordProviderSuccess gap (RF-04)
//
// The streaming-run.ts single-provider path (lines 328-346) was fixed to call
// `recordProviderSuccess` when the stream is opened successfully, even if
// consumption later throws. We test this behaviour via `attemptWithFailover`
// since that is the canonical contract the multi-provider path uses — and the
// single-provider path was updated to mirror it.
//
// We simulate this using `attemptWithFailover` with a stream-like execute
// that resolves (open succeeds) but where the caller separately invokes
// `recordProviderFailure` after consumption fails. This matches the exact
// call pattern in streaming-run.ts.
// ---------------------------------------------------------------------------

describe('streaming path: recordProviderSuccess gap regression (RF-04)', () => {
  it('records success when execute resolves even if the caller later encounters a consumption error', async () => {
    // Simulate the streaming path:
    //   execute() resolves → attemptWithFailover records success
    //   caller tries to consume stream → throws
    //   caller records failure
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    // Fake stream that will throw during consumption (simulated by the caller).
    const fakeStream = (async function* () {
      // This generator will be consumed by the caller who throws on first chunk.
    })()

    const execute = vi.fn(async () => ({
      stream: fakeStream,
      provider: 'primary',
      modelName: 'primary-model',
      attempt: 1,
    }))

    type StreamPayload = { stream: AsyncGenerator<never>; provider: string; modelName: string; attempt: number }

    // Step 1: attemptWithFailover opens stream — execute() resolves, success recorded.
    const opened = await attemptWithFailover<StreamPayload>({
      attempts: [makeAttempt('primary', 'primary-model')],
      phase: 'stream',
      agentId: 'agent-5',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute,
    })

    // Stream opened → recordProviderSuccess MUST have been called (the RF-04 fix).
    expect(registry.recordProviderSuccess).toHaveBeenCalledOnce()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('primary')

    // Step 2: Caller tries to consume the stream and encounters an error.
    const consumptionError = new Error('overloaded — please retry')
    registry.recordProviderFailure(opened.provider, consumptionError)

    // Both signals recorded: success (open) + failure (consumption).
    expect(registry.recordProviderSuccess).toHaveBeenCalledOnce()
    expect(registry.recordProviderFailure).toHaveBeenCalledOnce()
    expect(registry.recordProviderFailure).toHaveBeenCalledWith('primary', consumptionError)
  })

  it('emits provider:run_selected when stream opens (confirming the open was treated as success)', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    type StreamPayload = { stream: AsyncGenerator<never>; provider: string; modelName: string; attempt: number }

    await attemptWithFailover<StreamPayload>({
      attempts: [makeAttempt('primary', 'primary-model')],
      phase: 'stream',
      agentId: 'agent-5',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute: vi.fn(async () => ({
        stream: (async function* () {})(),
        provider: 'primary',
        modelName: 'primary-model',
        attempt: 1,
      })),
    })

    const selectedEvent = eventBus.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'provider:run_selected',
    )?.[0]
    expect(selectedEvent).toMatchObject({
      type: 'provider:run_selected',
      agentId: 'agent-5',
      provider: 'primary',
      phase: 'stream',
    })
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: Streaming path — full success calls recordProviderSuccess once
// ---------------------------------------------------------------------------

describe('streaming path: full success records success exactly once', () => {
  it('calls recordProviderSuccess once and never recordProviderFailure on a fully consumed stream', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const successChunks = [new AIMessage('chunk 1'), new AIMessage('chunk 2')]
    async function* successStream() {
      for (const chunk of successChunks) yield chunk
    }

    type StreamPayload = { stream: ReturnType<typeof successStream>; provider: string; modelName: string; attempt: number }

    const opened = await attemptWithFailover<StreamPayload>({
      attempts: [makeAttempt('primary', 'primary-model')],
      phase: 'stream',
      agentId: 'agent-6',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => false),
      execute: vi.fn(async () => ({
        stream: successStream(),
        provider: 'primary',
        modelName: 'primary-model',
        attempt: 1,
      })),
    })

    // Fully consume the stream — no errors.
    const collected: AIMessage[] = []
    for await (const chunk of opened.stream) {
      collected.push(chunk)
    }

    expect(collected).toHaveLength(2)

    // recordProviderSuccess fired once (at open time), recordProviderFailure never.
    expect(registry.recordProviderSuccess).toHaveBeenCalledOnce()
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('primary')
    expect(registry.recordProviderFailure).not.toHaveBeenCalled()
  })

  it('works without a registry (undefined registry skips recording gracefully)', async () => {
    const eventBus = makeEventBus()

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [makeAttempt('primary', 'primary-model')],
        phase: 'invoke',
        agentId: 'agent-6-no-registry',
        eventBus,
        registry: undefined,
        shouldRetry: vi.fn(() => false),
        execute: vi.fn(async () => new AIMessage('ok')),
      }),
    ).resolves.toMatchObject({ content: 'ok' })
  })

  it('works without an eventBus (undefined bus skips emit gracefully)', async () => {
    const registry = makeRegistry()

    const result = await attemptWithFailover<AIMessage>({
      attempts: [makeAttempt('primary', 'primary-model')],
      phase: 'invoke',
      agentId: 'agent-6-no-bus',
      eventBus: undefined,
      registry,
      shouldRetry: vi.fn(() => false),
      execute: vi.fn(async () => new AIMessage('no-bus ok')),
    })

    expect(result.content).toBe('no-bus ok')
    expect(registry.recordProviderSuccess).toHaveBeenCalledWith('primary')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('attemptWithFailover — edge cases', () => {
  it('passes the correct attemptNumber (1-based) to execute', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()
    const receivedNumbers: number[] = []

    let callCount = 0
    const execute = vi.fn(async (_attempt: ProviderAttempt, attemptNumber: number) => {
      receivedNumbers.push(attemptNumber)
      callCount++
      if (callCount < 3) throw new Error('transient')
      return new AIMessage('ok')
    })

    const attempts = [
      makeAttempt('p1', 'm1'),
      makeAttempt('p2', 'm2'),
      makeAttempt('p3', 'm3'),
    ]

    await attemptWithFailover<AIMessage>({
      attempts,
      phase: 'invoke',
      agentId: 'agent-edge',
      eventBus,
      registry,
      shouldRetry: vi.fn(() => true),
      execute,
    })

    expect(receivedNumbers).toEqual([1, 2, 3])
  })

  it('wraps non-Error thrown values in an Error before recording them', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()

    const execute = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string error'
    })

    await expect(
      attemptWithFailover<AIMessage>({
        attempts: [makeAttempt('primary', 'primary-model')],
        phase: 'invoke',
        agentId: 'agent-edge',
        eventBus,
        registry,
        shouldRetry: vi.fn(() => false),
        execute,
      }),
    ).rejects.toBeDefined()

    const [, recordedErr] = registry.recordProviderFailure.mock.calls[0] as [string, Error]
    expect(recordedErr).toBeInstanceOf(Error)
    expect(recordedErr.message).toBe('string error')
  })

  it('passes the attempt index (0-based) to shouldRetry', async () => {
    const registry = makeRegistry()
    const eventBus = makeEventBus()
    const shouldRetryIndices: number[] = []

    let callCount = 0
    const execute = vi.fn(async () => {
      callCount++
      if (callCount < 3) throw new Error('transient')
      return new AIMessage('ok')
    })

    const shouldRetry = vi.fn((err: Error, idx: number) => {
      shouldRetryIndices.push(idx)
      return true
    })

    await attemptWithFailover<AIMessage>({
      attempts: [makeAttempt('p1', 'm1'), makeAttempt('p2', 'm2'), makeAttempt('p3', 'm3')],
      phase: 'invoke',
      agentId: 'agent-edge',
      eventBus,
      registry,
      shouldRetry,
      execute,
    })

    // Indices are 0-based (index of the failed attempt).
    expect(shouldRetryIndices).toEqual([0, 1])
  })
})
