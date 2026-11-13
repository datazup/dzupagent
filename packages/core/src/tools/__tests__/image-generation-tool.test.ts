import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from '../../errors/forge-error.js'
import { createOpenAIImagesProvider } from '../../llm/image-generation.js'
import type { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from '../../llm/image-generation.js'
import { createImageGenerationTool } from '../image-generation-tool.js'
import type { StoredImageInput } from '../image-generation-tool.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7, 7, 7])

function fakeProvider() {
  const real = createOpenAIImagesProvider({ resolveCredential: () => 'unused', fetchImpl: vi.fn() as never })
  const generate = vi.fn(async (request: ImageGenerationRequest): Promise<ImageGenerationResult> => ({
    bytes: PNG,
    mimeType: 'image/png',
    sha256: 'f'.repeat(64),
    model: request.model,
    size: request.size ?? '1024x1024',
    quality: request.quality ?? 'auto',
    ...(request.complexity ? { complexity: request.complexity } : {}),
    outputFormat: request.outputFormat ?? 'png',
  }))
  const provider: ImageProvider = { id: 'fake', capabilities: real.capabilities, generate }
  return { provider, generate }
}

function store() {
  return vi.fn(async (_image: StoredImageInput) => ({ ref: 'images/0001.png' }))
}

describe('createImageGenerationTool', () => {
  it('stores the bytes and returns only a reference and metadata', async () => {
    const { provider, generate } = fakeProvider()
    const save = store()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2.6-flare', maxImages: 2, store: save, defaults: { quality: 'low' } })
    const out = await tool.invoke({ prompt: 'a dashboard', size: '1536x1024', complexity: 'medium' })
    const parsed = JSON.parse(String(out))
    expect(parsed).toEqual({
      ref: 'images/0001.png',
      model: 'gpt-image-2.6-flare',
      size: '1536x1024',
      quality: 'low',
      complexity: 'medium',
      outputFormat: 'png',
      mimeType: 'image/png',
      bytes: PNG.byteLength,
      sha256: 'f'.repeat(64),
    })
    expect(String(out)).not.toContain(Buffer.from(PNG).toString('base64'))
    expect(generate).toHaveBeenCalledWith(
      { model: 'gpt-image-2.6-flare', prompt: 'a dashboard', size: '1536x1024', quality: 'low', outputFormat: 'png', complexity: 'medium' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(save).toHaveBeenCalledTimes(1)
    const stored = save.mock.calls[0]![0]
    expect(stored.prompt).toBe('a dashboard')
    expect(Array.from(stored.bytes)).toEqual(Array.from(PNG))
  })

  it('refuses beyond maxImages before calling the provider', async () => {
    const { provider, generate } = fakeProvider()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 1, store: store() })
    await tool.invoke({ prompt: 'one' })
    const err = await tool.invoke({ prompt: 'two' }).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(ForgeError)
    expect((err as ForgeError).code).toBe('BUDGET_EXCEEDED')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('counts a failed provider call against maxImages', async () => {
    const { provider, generate } = fakeProvider()
    generate.mockRejectedValueOnce(new ForgeError({ code: 'PROVIDER_UNAVAILABLE', message: 'down' }))
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 1, store: store() })
    await expect(tool.invoke({ prompt: 'one' })).rejects.toThrow('down')
    await expect(tool.invoke({ prompt: 'two' })).rejects.toThrow('maxImages')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('offers complexity only for models that take it', async () => {
    const { provider, generate } = fakeProvider()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 3, store: store() })
    await expect(tool.invoke({ prompt: 'p', complexity: 'low' })).rejects.toThrow()
    await expect(tool.invoke({ prompt: 'p', quality: 'max' })).rejects.toThrow()
    await expect(tool.invoke({ prompt: 'p', size: '1792x1024' })).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })

  it('validates its options at creation', () => {
    const { provider } = fakeProvider()
    const ok = { provider, model: 'gpt-image-2.6-sunburst', maxImages: 1, store: store() }
    expect(() => createImageGenerationTool({ ...ok, maxImages: 0 })).toThrow(ForgeError)
    expect(() => createImageGenerationTool({ ...ok, maxImages: 1.5 })).toThrow(ForgeError)
    expect(() => createImageGenerationTool({ ...ok, model: 'dall-e-3' })).toThrow(ForgeError)
    expect(() => createImageGenerationTool({ ...ok, model: 'gpt-image-2', defaults: { complexity: 'low' } })).toThrow(ForgeError)
    expect(() => createImageGenerationTool({ ...ok, defaults: { outputFormat: 'svg' as never } })).toThrow(ForgeError)
    expect(() => createImageGenerationTool({ ...ok, store: undefined as never })).toThrow(ForgeError)
  })

  it('fails when the store returns no reference', async () => {
    const { provider } = fakeProvider()
    const tool = createImageGenerationTool({
      provider, model: 'gpt-image-2', maxImages: 1, store: vi.fn(async () => ({ ref: '' })),
    })
    await expect(tool.invoke({ prompt: 'p' })).rejects.toThrow('no reference')
  })
})

describe('createImageGenerationTool dollar threshold (R2)', () => {
  type Usage = ImageGenerationResult['usage']
  function costedProvider(plan: Array<Usage | Error | Promise<Usage>>) {
    const real = createOpenAIImagesProvider({ resolveCredential: () => 'unused', fetchImpl: vi.fn() as never })
    let i = 0
    const generate = vi.fn(async (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
      const step = await plan[i++]
      if (step instanceof Error) throw step
      return {
        bytes: PNG,
        mimeType: 'image/png',
        sha256: 'e'.repeat(64),
        model: request.model,
        size: request.size ?? '1024x1024',
        quality: request.quality ?? 'auto',
        outputFormat: 'png',
        ...(step ? { usage: step } : {}),
      }
    })
    const provider: ImageProvider = { id: 'fake', capabilities: real.capabilities, generate }
    return { provider, generate }
  }
  // 100 text input tokens and 5000 output tokens: 100 * 5 + 5000 * 30 = 150,500 micro-USD.
  const usage = { inputTokens: 100, outputTokens: 5000, inputTokensDetails: { textTokens: 100, imageTokens: 0 } }
  const code = (e: unknown) => (e as ForgeError).code

  it('validates maxUsd, reserveUsdPerImage and onCost at creation', () => {
    const { provider } = costedProvider([])
    const base = { provider, model: 'gpt-image-2', maxImages: 5, store: store() }
    for (const bad of [
      { maxUsd: 1 },
      { maxUsd: 0, reserveUsdPerImage: 0.1 },
      { maxUsd: -1, reserveUsdPerImage: 0.1 },
      { maxUsd: Number.NaN, reserveUsdPerImage: 0.1 },
      { maxUsd: 1, reserveUsdPerImage: 0 },
      { maxUsd: 1, reserveUsdPerImage: 2 },
      { reserveUsdPerImage: Number.POSITIVE_INFINITY },
      { onCost: 'x' as never },
    ]) {
      expect(() => createImageGenerationTool({ ...base, ...bad }), JSON.stringify(bad)).toThrow(ForgeError)
    }
    expect(() => createImageGenerationTool({ ...base, reserveUsdPerImage: 0.2 })).not.toThrow()
  })

  it('reports the usage-based cost in the output and to onCost', async () => {
    const { provider } = costedProvider([usage])
    const onCost = vi.fn()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2.6-sunburst', maxImages: 3, store: store(), maxUsd: 1, reserveUsdPerImage: 0.3, onCost })
    const out = JSON.parse(String(await tool.invoke({ prompt: 'p', quality: 'high' })))
    expect(out.costUsd).toBe(0.1505)
    expect(onCost).toHaveBeenCalledWith({
      model: 'gpt-image-2.6-sunburst', size: '1024x1024', quality: 'high', outcome: 'generated', basis: 'usage',
      costUsd: 0.1505, usage, sha256: 'e'.repeat(64),
    })
  })

  it('refuses a call whose hold would pass maxUsd, before calling the provider', async () => {
    const { provider, generate } = costedProvider([usage, usage, usage])
    // Holds 0.2; settles 0.1505 each. After two calls 0.301 + 0.2 > 0.5.
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 10, store: store(), maxUsd: 0.5, reserveUsdPerImage: 0.2 })
    await tool.invoke({ prompt: 'a' })
    await tool.invoke({ prompt: 'b' })
    const err = await tool.invoke({ prompt: 'c' }).then(() => undefined, (e: unknown) => e)
    expect(code(err)).toBe('BUDGET_EXCEEDED')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('counts open holds of concurrent calls', async () => {
    let release!: (u: Usage) => void
    const pending = new Promise<Usage>((resolve) => { release = resolve })
    const { provider, generate } = costedProvider([pending, usage])
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 10, store: store(), maxUsd: 0.5, reserveUsdPerImage: 0.3 })
    const first = tool.invoke({ prompt: 'a' })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    const err = await tool.invoke({ prompt: 'b' }).then(() => undefined, (e: unknown) => e)
    expect(code(err)).toBe('BUDGET_EXCEEDED')
    release(usage)
    await first
    // 0.1505 settled + 0.3 hold <= 0.5: admitted now.
    await tool.invoke({ prompt: 'c' })
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('raises later holds to the largest cost seen, and documents the overshoot of an admitted call', async () => {
    const dear = { inputTokens: 10, outputTokens: 20_000 } // 10 * 8 + 20000 * 30 = 600,080 micro-USD
    const { provider, generate } = costedProvider([dear, usage])
    const onCost = vi.fn()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 10, store: store(), maxUsd: 1, reserveUsdPerImage: 0.1, onCost })
    const out = JSON.parse(String(await tool.invoke({ prompt: 'a' })))
    // The admitted call cost six times its hold: the threshold is not a hard cap.
    expect(out.costUsd).toBe(0.60008)
    // The next hold is 0.60008, and 0.60008 + 0.60008 > 1, so the call is refused although 0.1 would fit.
    const err = await tool.invoke({ prompt: 'b' }).then(() => undefined, (e: unknown) => e)
    expect(code(err)).toBe('BUDGET_EXCEEDED')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('charges the hold for a failed call and for a reply without usage', async () => {
    const { provider } = costedProvider([new ForgeError({ code: 'PROVIDER_UNAVAILABLE', message: 'x' }), undefined, usage])
    const onCost = vi.fn()
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 10, store: store(), maxUsd: 0.75, reserveUsdPerImage: 0.25, onCost })
    const err = await tool.invoke({ prompt: 'a' }).then(() => undefined, (e: unknown) => e)
    expect(code(err)).toBe('PROVIDER_UNAVAILABLE')
    expect(onCost).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failed', basis: 'reserve', costUsd: 0.25 }))
    const out = JSON.parse(String(await tool.invoke({ prompt: 'b' })))
    expect(out.costUsd).toBe(0.25)
    expect(onCost).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'generated', basis: 'reserve', costUsd: 0.25 }))
    // 0.5 settled + 0.25 hold = 0.75: still admitted.
    await tool.invoke({ prompt: 'c' })
    const refused = await tool.invoke({ prompt: 'd' }).then(() => undefined, (e: unknown) => e)
    expect(code(refused)).toBe('BUDGET_EXCEEDED')
  })

  it('keeps the result and raises no unhandled rejection when an async onCost rejects', async () => {
    const { provider } = costedProvider([usage])
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let rejected!: () => void
      const hookDone = new Promise<void>((resolve) => { rejected = resolve })
      const tool = createImageGenerationTool({
        provider, model: 'gpt-image-2', maxImages: 1, store: store(),
        onCost: async () => { rejected(); throw new Error('ledger down') },
      })
      const out = JSON.parse(String(await tool.invoke({ prompt: 'a' })))
      await hookDone
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(out.costUsd).toBe(0.1505)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the result when onCost throws, and has no cost without usage or reserve', async () => {
    const { provider } = costedProvider([usage, undefined])
    const tool = createImageGenerationTool({ provider, model: 'gpt-image-2', maxImages: 3, store: store(), onCost: () => { throw new Error('ledger down') } })
    const out = JSON.parse(String(await tool.invoke({ prompt: 'a' })))
    expect(out.costUsd).toBe(0.1505)
    const bare = JSON.parse(String(await tool.invoke({ prompt: 'b' })))
    expect(bare.costUsd).toBeUndefined()
    expect(bare.ref).toBe('images/0001.png')
  })
})
