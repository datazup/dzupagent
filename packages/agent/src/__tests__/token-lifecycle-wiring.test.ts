/**
 * Tests for `createTokenLifecyclePlugin` — the default-loop wiring that
 * drives compression hints, auto-compression, and halt signals from a
 * TokenLifecycleManager's pressure transitions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { TokenLifecycleManager, createTokenBudget } from '@dzupagent/context'
import type { TokenUsage } from '@dzupagent/core'
import { createTokenLifecyclePlugin } from '../token-lifecycle-wiring.js'
import type * as AutoCompressModule from '../context/auto-compress.js'

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
  return {} as BaseChatModel
}

describe('createTokenLifecyclePlugin', () => {
  beforeEach(() => {
    autoCompressSpy.mockReset()
    autoCompressSpy.mockResolvedValue({
      messages: [] as BaseMessage[],
      summary: 'compressed-summary',
      compressed: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a no-op plugin when no manager is provided', async () => {
    const plugin = createTokenLifecyclePlugin(undefined)
    expect(plugin.status).toBe('ok')
    expect(plugin.manager).toBeNull()
    expect(plugin.hooks).toBeNull()
    expect(plugin.shouldHalt()).toBe(false)

    plugin.onUsage(makeUsage(100, 50))
    plugin.trackPhase('tool-output', 200)

    const result = await plugin.maybeCompress([], makeModel(), null)
    expect(result.compressed).toBe(false)
    expect(autoCompressSpy).not.toHaveBeenCalled()
  })

  it('exposes the underlying manager and hooks when attached', () => {
    const manager = makeManager()
    const plugin = createTokenLifecyclePlugin(manager)
    expect(plugin.manager).toBe(manager)
    expect(plugin.hooks).not.toBeNull()
    expect(plugin.status).toBe('ok')
  })

  it('ok status triggers neither hint nor compression', async () => {
    const manager = makeManager(1_000)
    const onCompressionHint = vi.fn()
    const onPressure = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, {
      onCompressionHint,
      onPressure,
    })

    plugin.onUsage(makeUsage(100, 50))
    expect(plugin.status).toBe('ok')
    expect(onCompressionHint).not.toHaveBeenCalled()
    expect(onPressure).not.toHaveBeenCalled()

    const result = await plugin.maybeCompress([], makeModel(), null)
    expect(result.compressed).toBe(false)
    expect(autoCompressSpy).not.toHaveBeenCalled()
  })

  it('warn status emits a compression hint but does not compress', async () => {
    const manager = makeManager(1_000)
    const onCompressionHint = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, { onCompressionHint })

    plugin.onUsage(makeUsage(820, 0))
    expect(plugin.status).toBe('warn')
    expect(onCompressionHint).toHaveBeenCalledTimes(1)
    expect(onCompressionHint).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'warn' }),
    )

    const result = await plugin.maybeCompress([], makeModel(), null)
    expect(result.compressed).toBe(false)
    expect(autoCompressSpy).not.toHaveBeenCalled()
  })

  it('critical status triggers auto-compression', async () => {
    const manager = makeManager(1_000)
    const onPressure = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, { onPressure })

    plugin.onUsage(makeUsage(970, 0))
    expect(plugin.status).toBe('critical')
    expect(onPressure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'critical' }),
    )

    const result = await plugin.maybeCompress([], makeModel(), null)
    expect(autoCompressSpy).toHaveBeenCalledTimes(1)
    expect(result.compressed).toBe(true)
    expect(result.summary).toBe('compressed-summary')
  })

  it('exhausted status signals halt and fires pressure callback', async () => {
    const manager = makeManager(1_000)
    const onPressure = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, { onPressure })

    plugin.onUsage(makeUsage(1_100, 0))
    expect(plugin.status).toBe('exhausted')
    expect(plugin.shouldHalt()).toBe(true)
    expect(onPressure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'exhausted' }),
    )
  })

  it('trackPhase routes non-LLM charges into the manager', () => {
    const manager = makeManager(1_000)
    const plugin = createTokenLifecyclePlugin(manager)

    plugin.trackPhase('tool-output', 300)
    expect(manager.usedTokens).toBe(300)
    plugin.trackPhase('system-prompt', 0)
    expect(manager.usedTokens).toBe(300)
  })

  it('reset clears tracked usage and drops back to ok', () => {
    const manager = makeManager(1_000)
    const plugin = createTokenLifecyclePlugin(manager)

    plugin.onUsage(makeUsage(900, 0))
    expect(plugin.status).toBe('warn')

    plugin.reset()
    expect(manager.usedTokens).toBe(0)
    expect(plugin.status).toBe('ok')
    expect(plugin.shouldHalt()).toBe(false)
  })

  it('cleanup stops further tracking and is idempotent', () => {
    const manager = makeManager(1_000)
    const onCompressionHint = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, { onCompressionHint })

    plugin.cleanup()
    plugin.onUsage(makeUsage(820, 0))
    expect(manager.usedTokens).toBe(0)
    expect(onCompressionHint).not.toHaveBeenCalled()

    // Second cleanup must not throw.
    expect(() => plugin.cleanup()).not.toThrow()
  })

  it('maybeCompress resets the manager after a successful compression', async () => {
    const manager = makeManager(1_000)
    const plugin = createTokenLifecyclePlugin(manager)

    plugin.onUsage(makeUsage(970, 0))
    expect(plugin.status).toBe('critical')

    await plugin.maybeCompress([], makeModel(), null)
    expect(manager.usedTokens).toBe(0)
    expect(plugin.status).toBe('ok')
  })

  it('compression hint fires only on ok->warn transition, not repeatedly', () => {
    const manager = makeManager(1_000)
    const onCompressionHint = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, { onCompressionHint })

    plugin.onUsage(makeUsage(820, 0))
    plugin.onUsage(makeUsage(10, 0))
    // Still in warn after the second track — no new transition into warn.
    expect(plugin.status).toBe('warn')
    expect(onCompressionHint).toHaveBeenCalledTimes(1)
  })

  it('status moves ok -> warn -> critical -> exhausted with matching callbacks', () => {
    const manager = makeManager(1_000)
    const onCompressionHint = vi.fn()
    const onPressure = vi.fn()
    const plugin = createTokenLifecyclePlugin(manager, {
      onCompressionHint,
      onPressure,
    })

    plugin.onUsage(makeUsage(800, 0))
    expect(plugin.status).toBe('warn')
    plugin.onUsage(makeUsage(160, 0))
    expect(plugin.status).toBe('critical')
    plugin.onUsage(makeUsage(100, 0))
    expect(plugin.status).toBe('exhausted')

    expect(onCompressionHint).toHaveBeenCalledTimes(1)
    // Critical + exhausted transitions both notify onPressure.
    expect(onPressure).toHaveBeenCalledTimes(2)
  })
})
