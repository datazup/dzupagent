import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from '../../errors/forge-error.js'
import {
  OPENAI_IMAGE_MODELS,
  createOpenAIImagesProvider,
  resolveImageRequest,
} from '../image-generation.js'
import type { ImageGenerationRequest } from '../image-generation.js'

const CREDENTIAL = 'test-credential-0000'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function reply(bytes: Uint8Array = PNG, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64(bytes) }], ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function setup(fetchImpl: typeof fetch = vi.fn(async () => reply()) as unknown as typeof fetch, extra = {}) {
  const resolveCredential = vi.fn(async () => CREDENTIAL)
  const provider = createOpenAIImagesProvider({ resolveCredential, fetchImpl, ...extra })
  return { provider, resolveCredential, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> }
}

async function codeOf(promise: Promise<unknown>): Promise<ForgeError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ForgeError)
    return err as ForgeError
  }
  throw new Error('expected a ForgeError')
}

const base: ImageGenerationRequest = { model: 'gpt-image-2.6-flare', prompt: 'a settings screen' }

describe('createOpenAIImagesProvider capabilities', () => {
  it('pins the 2.6 models with complexity and gpt-image-2 without', () => {
    const { provider } = setup()
    expect(OPENAI_IMAGE_MODELS).toEqual(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2'])
    expect(provider.capabilities('gpt-image-2.6-sunburst').complexities).toEqual(['low', 'medium', 'high'])
    expect(provider.capabilities('gpt-image-2').complexities).toEqual([])
    expect(provider.capabilities('gpt-image-2').sizes).toEqual(['1024x1024', '1536x1024', '1024x1536'])
    expect(() => provider.capabilities('dall-e-3')).toThrow(ForgeError)
    expect(() => provider.capabilities('__proto__')).toThrow(ForgeError)
  })
})

describe('createOpenAIImagesProvider refusals before any network call', () => {
  const cases: Array<[string, Partial<ImageGenerationRequest> & Record<string, unknown>]> = [
    ['unknown model', { model: 'gpt-image-1' }],
    ['unsupported size', { size: '1792x1024' as never }],
    ['quality xhigh', { quality: 'xhigh' as never }],
    ['quality max', { quality: 'max' as never }],
    ['svg output', { outputFormat: 'svg' as never }],
    ['gif output', { outputFormat: 'gif' as never }],
    ['complexity on gpt-image-2', { model: 'gpt-image-2', complexity: 'low' }],
    ['bad complexity', { complexity: 'extreme' as never }],
    ['empty prompt', { prompt: '   ' }],
    ['too long prompt', { prompt: 'x'.repeat(32_001) }],
  ]
  for (const [name, patch] of cases) {
    it(`refuses ${name}`, async () => {
      const { provider, fetchImpl, resolveCredential } = setup()
      const err = await codeOf(provider.generate({ ...base, ...patch } as ImageGenerationRequest))
      expect(err.code).toBe('INVALID_CONFIG')
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(resolveCredential).not.toHaveBeenCalled()
    })
  }

  it('refuses a pre-aborted signal without dispatch', async () => {
    const { provider, fetchImpl } = setup()
    const controller = new AbortController()
    controller.abort()
    const err = await codeOf(provider.generate(base, { signal: controller.signal }))
    expect(err.code).toBe('PROVIDER_TIMEOUT')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not dispatch when the caller aborts while the credential is resolving', async () => {
    let release: (value: string) => void = () => undefined
    const resolveCredential = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const fetchImpl = vi.fn(async () => reply())
    const provider = createOpenAIImagesProvider({ resolveCredential, fetchImpl: fetchImpl as never })
    const controller = new AbortController()
    const pending = provider.generate(base, { signal: controller.signal })
    await Promise.resolve()
    expect(resolveCredential).toHaveBeenCalledTimes(1)
    controller.abort()
    release(CREDENTIAL)
    const err = await codeOf(pending)
    expect(err.code).toBe('PROVIDER_TIMEOUT')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('aborts an in-flight request when the caller aborts', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { provider } = setup(hanging as never)
    const controller = new AbortController()
    const pending = provider.generate(base, { signal: controller.signal })
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1))
    controller.abort()
    expect((await codeOf(pending)).code).toBe('PROVIDER_TIMEOUT')
  })

  it('validates options', () => {
    const resolveCredential = async () => CREDENTIAL
    expect(() => createOpenAIImagesProvider({ resolveCredential, baseUrl: 'ftp://x' })).toThrow(ForgeError)
    expect(() => createOpenAIImagesProvider({ resolveCredential, baseUrl: 'https://u:p@api.example.test/v1' })).toThrow(ForgeError)
    expect(() => createOpenAIImagesProvider({ resolveCredential, baseUrl: 'https://api.example.test/v1?k=1' })).toThrow(ForgeError)
    expect(() => createOpenAIImagesProvider({ resolveCredential, timeoutMs: 0 })).toThrow(ForgeError)
    expect(() => createOpenAIImagesProvider({ resolveCredential, maxOutputBytes: 1.5 })).toThrow(ForgeError)
    expect(() => createOpenAIImagesProvider({} as never)).toThrow(ForgeError)
  })
})

describe('createOpenAIImagesProvider request', () => {
  it('sends the exact body, headers and endpoint for a 2.6 model with complexity', async () => {
    const { provider, fetchImpl } = setup(undefined, { baseUrl: 'https://proxy.example.test/v1/' })
    await provider.generate({ ...base, size: '1536x1024', quality: 'medium', complexity: 'low' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.example.test/v1/images/generations')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2.6-flare',
      prompt: 'a settings screen',
      size: '1536x1024',
      quality: 'medium',
      output_format: 'png',
      n: 1,
      complexity: 'low',
    })
  })

  it('omits complexity when unset and fills defaults', async () => {
    const { provider, fetchImpl } = setup()
    await provider.generate({ model: 'gpt-image-2.6-sunburst', prompt: 'p' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(['model', 'n', 'output_format', 'prompt', 'quality', 'size'])
    expect(body).toMatchObject({ size: '1024x1024', quality: 'auto', output_format: 'png' })
    expect(body).not.toHaveProperty('response_format')
  })

  it('returns bytes, sha256, mime type, reported model and usage with details', async () => {
    const usage = {
      input_tokens: 12,
      output_tokens: 3000,
      total_tokens: 3012,
      input_tokens_details: { text_tokens: 12, image_tokens: 0, junk: 'x' },
      output_tokens_details: { image_tokens: 3000, text_tokens: -1 },
      unknown_field: { nested: true },
    }
    const { provider } = setup(vi.fn(async () => reply(PNG, { model: 'gpt-image-2.6-flare-x', usage })) as never)
    const result = await provider.generate({ ...base, complexity: 'high' })
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG))
    expect(result.sha256).toBe(createHash('sha256').update(PNG).digest('hex'))
    expect(result).toMatchObject({
      mimeType: 'image/png',
      model: 'gpt-image-2.6-flare-x',
      size: '1024x1024',
      quality: 'auto',
      complexity: 'high',
      outputFormat: 'png',
    })
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3000,
      totalTokens: 3012,
      inputTokensDetails: { textTokens: 12, imageTokens: 0 },
      outputTokensDetails: { imageTokens: 3000 },
    })
    expect(result).not.toHaveProperty('revisedPrompt')
  })

  it('keeps revised_prompt when the provider returns one', async () => {
    const body = JSON.stringify({ data: [{ b64_json: b64(PNG), revised_prompt: 'a tidy settings screen' }] })
    const { provider } = setup(vi.fn(async () => new Response(body, { status: 200 })) as never)
    const result = await provider.generate(base)
    expect(result.revisedPrompt).toBe('a tidy settings screen')
  })

  it('accepts jpeg with a jpeg signature', async () => {
    const { provider } = setup(vi.fn(async () => reply(JPEG)) as never)
    const result = await provider.generate({ ...base, outputFormat: 'jpeg' })
    expect(result.mimeType).toBe('image/jpeg')
  })
})

describe('createOpenAIImagesProvider failures', () => {
  const statuses: Array<[number, string]> = [
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [400, 'PROVIDER_REJECTED_REQUEST'],
    [422, 'PROVIDER_REJECTED_REQUEST'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ]
  for (const [status, code] of statuses) {
    it(`maps HTTP ${status} to ${code} without copying the reply`, async () => {
      const text = `provider says ${CREDENTIAL} secret detail`
      const { provider } = setup(vi.fn(async () => new Response(JSON.stringify({ error: { message: text } }), { status })) as never)
      const err = await codeOf(provider.generate(base))
      expect(err.code).toBe(code)
      expect(err.context).toEqual({ status })
      expect(err.message).not.toContain('secret detail')
      expect(JSON.stringify(err)).not.toContain(CREDENTIAL)
    })
  }

  it('maps a network failure to PROVIDER_UNAVAILABLE', async () => {
    const { provider } = setup(vi.fn(async () => { throw new TypeError(`connect failed ${CREDENTIAL}`) }) as never)
    const err = await codeOf(provider.generate(base))
    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(err.message).not.toContain(CREDENTIAL)
    expect(err.cause).toBeUndefined()
  })

  it('times out across dispatch', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { provider } = setup(hanging as never, { timeoutMs: 20 })
    const err = await codeOf(provider.generate(base))
    expect(err.code).toBe('PROVIDER_TIMEOUT')
  })

  it('times out during body consumption', async () => {
    const slowBody = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'))
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }), { status: 200 }))
    const { provider } = setup(slowBody as never, { timeoutMs: 20 })
    const err = await codeOf(provider.generate(base))
    expect(err.code).toBe('PROVIDER_TIMEOUT')
  })

  it('refuses an oversize body, declared or streamed', async () => {
    const { provider } = setup(vi.fn(async () => reply()) as never, { maxOutputBytes: 16 })
    expect((await codeOf(provider.generate(base))).message).toBe('image reply exceeded the size limit')
    const declared = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-length': '999' } }))
    const second = setup(declared as never, { maxOutputBytes: 16 }).provider
    expect((await codeOf(second.generate(base))).message).toBe('image reply exceeded the size limit')
  })

  it('refuses a reply whose bytes do not match the format', async () => {
    const { provider } = setup(vi.fn(async () => reply(JPEG)) as never)
    const err = await codeOf(provider.generate(base))
    expect(err.message).toBe('image reply did not match the requested format')
  })

  it('refuses replies without exactly one base64 image', async () => {
    const bodies = ['not json', '{"data":[]}', '{"data":[{"b64_json":"%%%%"}]}', `{"data":[{"b64_json":"${b64(PNG)}"},{"b64_json":"${b64(PNG)}"}]}`]
    for (const body of bodies) {
      const { provider } = setup(vi.fn(async () => new Response(body, { status: 200 })) as never)
      expect((await codeOf(provider.generate(base))).code).toBe('PROVIDER_UNAVAILABLE')
    }
  })

  it('never exposes the credential and fails closed when it cannot be resolved', async () => {
    const { provider } = setup()
    const result = await provider.generate(base)
    expect(JSON.stringify({ ...result, bytes: Array.from(result.bytes) })).not.toContain(CREDENTIAL)

    const throwing = createOpenAIImagesProvider({
      resolveCredential: () => { throw new Error(`vault said ${CREDENTIAL}`) },
      fetchImpl: vi.fn() as never,
    })
    const err = await codeOf(throwing.generate(base))
    expect(err.code).toBe('PROVIDER_AUTH_FAILED')
    expect(JSON.stringify(err) + err.message).not.toContain(CREDENTIAL)

    const fetchImpl = vi.fn()
    const bad = createOpenAIImagesProvider({ resolveCredential: () => 'two words', fetchImpl: fetchImpl as never })
    expect((await codeOf(bad.generate(base))).code).toBe('PROVIDER_AUTH_FAILED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('resolveImageRequest', () => {
  it('fills defaults and keeps complexity only when set', () => {
    expect(resolveImageRequest({ model: 'gpt-image-2', prompt: 'p' })).toEqual({
      model: 'gpt-image-2', prompt: 'p', size: '1024x1024', quality: 'auto', outputFormat: 'png',
    })
  })
})
