/**
 * Tests for `withTokenLifecycle` — the glue between a passive
 * {@link TokenLifecycleManager} and the agent's auto-compression path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { TokenLifecycleManager, createTokenBudget } from '@dzupagent/context'
import type { TokenUsage } from '@dzupagent/core'
import {
  withTokenLifecycle,
  type TokenLifecycleHooks,
} from '../context/token-lifecycle-integration.js'
import type * as AutoCompressModule from '../context/auto-compress.js'

// Hoisted spy for autoCompress so we can observe invocations without
// actually running the LLM-backed summarizer.
const { autoCompressSpy } = vi.hoisted(() => ({
  autoCompressSpy: vi.fn(),
}))

vi.mock('../context/auto-compress.js', async () => {
  const actual = await vi.importActual<typeof AutoCompressModule>(
    '../context/auto-compress.js',
  )
  return {
    ...actual,
    autoCompress: autoCompressSpy,
  }
})

function makeManager(total = 1_000, reserved = 0): TokenLifecycleManager {
  return new TokenLifecycleManager({
    budget: createTokenBudget(total, reserved),
    warnThresholdPct: 0.8,
    criticalThresholdPct: 0.95,
  })
}

function makeUsage(input: number, output: number): TokenUsage {
  return { model: 'test-model', inputTokens: input, outputTokens: output }
}

function makeModel(): BaseChatModel {
  // autoCompress is mocked, so the model is never actually invoked.
  return {} as BaseChatModel
}

describe('withTokenLifecycle', () => {
  beforeEach(() => {
    autoCompressSpy.mockReset()
    autoCompressSpy.mockResolvedValue({
      messages: [] as BaseMessage[],
      summary: null,
      compressed: false,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a hooks object with expected methods', () => {
    const manager = makeManager()
    const hooks = withTokenLifecycle(manager)

    expect(typeof hooks.onUsage).toBe('function')
    expect(typeof hooks.trackPhase).toBe('function')
    expect(typeof hooks.maybeCompress).toBe('function')
    expect(typeof hooks.onPressure).toBe('function')
    expect(typeof hooks.cleanup).toBe('function')
    expect(hooks.status).toBe('ok')
    expect(hooks.manager).toBe(manager)
  })

  it('onUsage tracks input and output tokens against the manager', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    hooks.onUsage(makeUsage(100, 50))

    expect(manager.usedTokens).toBe(150)
    const phases = manager.report.phases
    expect(phases).toHaveLength(2)
    expect(phases[0]).toMatchObject({ phase: 'input', tokens: 100 })
    expect(phases[1]).toMatchObject({ phase: 'output', tokens: 50 })
  })

  it('onUsage respects a phase override label', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    hooks.onUsage(makeUsage(10, 5), 'tool-output')

    const phases = manager.report.phases
    expect(phases.every(p => p.phase === 'tool-output')).toBe(true)
  })

  it('trackPhase charges arbitrary phases', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    hooks.trackPhase('system-prompt', 200)
    hooks.trackPhase('history', 300)

    expect(manager.usedTokens).toBe(500)
    expect(manager.report.phases.map(p => p.phase)).toEqual([
      'system-prompt',
      'history',
    ])
  })

  it('trackPhase ignores zero or negative token counts', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    hooks.trackPhase('noop', 0)
    hooks.trackPhase('negative', -50)

    expect(manager.usedTokens).toBe(0)
    expect(manager.report.phases).toHaveLength(0)
  })

  it('maybeCompress does NOT call autoCompress when status is ok', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    hooks.onUsage(makeUsage(100, 50)) // 15% — well below warn

    const result = await hooks.maybeCompress(
      [new HumanMessage('hi')],
      makeModel(),
      'summary',
    )

    expect(autoCompressSpy).not.toHaveBeenCalled()
    expect(result.compressed).toBe(false)
    expect(result.summary).toBe('summary')
  })

  it('maybeCompress calls autoCompress when status is warn', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    // 820/1000 = 82% -> warn
    hooks.trackPhase('history', 820)
    expect(manager.status).toBe('warn')

    const messages = [new HumanMessage('hi'), new AIMessage('hello')]
    await hooks.maybeCompress(messages, makeModel(), null)

    expect(autoCompressSpy).toHaveBeenCalledTimes(1)
    expect(autoCompressSpy).toHaveBeenCalledWith(
      messages,
      null,
      expect.anything(),
      undefined,
    )
  })

  it('maybeCompress calls autoCompress when status is critical', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    // 960/1000 = 96% -> critical
    hooks.trackPhase('history', 960)
    expect(manager.status).toBe('critical')

    await hooks.maybeCompress([new HumanMessage('hi')], makeModel())

    expect(autoCompressSpy).toHaveBeenCalledTimes(1)
  })

  it('maybeCompress calls autoCompress when status is exhausted', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    hooks.trackPhase('history', 1_500) // over budget
    expect(manager.status).toBe('exhausted')

    await hooks.maybeCompress([new HumanMessage('hi')], makeModel())

    expect(autoCompressSpy).toHaveBeenCalledTimes(1)
  })

  it('maybeCompress resets the manager after a successful compression', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    hooks.trackPhase('history', 850) // warn
    expect(manager.usedTokens).toBe(850)

    autoCompressSpy.mockResolvedValueOnce({
      messages: [new HumanMessage('trimmed')],
      summary: 'new summary',
      compressed: true,
    })

    const result = await hooks.maybeCompress(
      [new HumanMessage('a'), new HumanMessage('b')],
      makeModel(),
    )

    expect(result.compressed).toBe(true)
    expect(manager.usedTokens).toBe(0)
    expect(manager.status).toBe('ok')
  })

  it('maybeCompress does NOT reset when autoCompress returns compressed=false', async () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    hooks.trackPhase('history', 850) // warn

    autoCompressSpy.mockResolvedValueOnce({
      messages: [],
      summary: null,
      compressed: false,
    })

    await hooks.maybeCompress([new HumanMessage('a')], makeModel())

    // No reset — used count remains pinned.
    expect(manager.usedTokens).toBe(850)
  })

  it('onPressure listener fires on status transitions', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    const listener = vi.fn()
    hooks.onPressure(listener)

    hooks.trackPhase('history', 500) // still ok (50%)
    expect(listener).not.toHaveBeenCalled()

    hooks.trackPhase('history', 400) // 900 -> warn
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({
      status: 'warn',
      previousStatus: 'ok',
      usedTokens: 900,
      remainingTokens: 100,
    })

    hooks.trackPhase('history', 100) // 1000 -> exhausted (>= available)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({
      status: 'exhausted',
      previousStatus: 'warn',
      usedTokens: 1_000,
      remainingTokens: 0,
    })
  })

  it('onPressure returns an unsubscribe function', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    const listener = vi.fn()
    const unsubscribe = hooks.onPressure(listener)

    unsubscribe()
    hooks.trackPhase('history', 900) // would trigger warn

    expect(listener).not.toHaveBeenCalled()
  })

  it('pressure listener errors are swallowed', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    const good = vi.fn()
    hooks.onPressure(() => {
      throw new Error('boom')
    })
    hooks.onPressure(good)

    expect(() => hooks.trackPhase('history', 900)).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('cleanup stops future pressure notifications and onUsage becomes a no-op', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)
    const listener = vi.fn()
    hooks.onPressure(listener)

    hooks.cleanup()

    hooks.onUsage(makeUsage(900, 0))
    hooks.trackPhase('history', 900)

    expect(listener).not.toHaveBeenCalled()
    expect(manager.usedTokens).toBe(0) // post-cleanup tracking is dropped
  })

  it('cleanup is idempotent', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    hooks.cleanup()
    expect(() => hooks.cleanup()).not.toThrow()
  })

  it('status getter reflects live manager state', () => {
    const manager = makeManager(1_000)
    const hooks = withTokenLifecycle(manager)

    expect(hooks.status).toBe('ok')
    hooks.trackPhase('history', 850)
    expect(hooks.status).toBe('warn')
    hooks.trackPhase('history', 200)
    expect(hooks.status).toBe('exhausted')
  })

  it('maybeCompress forwards autoCompress config', async () => {
    const manager = makeManager(1_000)
    const hooks: TokenLifecycleHooks = withTokenLifecycle(manager)
    hooks.trackPhase('history', 850)

    const cfg = { keepRecentMessages: 5 }
    await hooks.maybeCompress([], makeModel(), 'prev', cfg)

    expect(autoCompressSpy).toHaveBeenCalledWith(
      [],
      'prev',
      expect.anything(),
      cfg,
    )
  })
})
