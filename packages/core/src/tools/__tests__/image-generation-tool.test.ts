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
