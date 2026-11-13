/**
 * Image generation through the OpenAI Images API (`POST /v1/images/generations`).
 *
 * DZUP-OPENAI-IMAGES-20261113-R1 (Amendment 1). One text-to-image request per
 * call, against a pinned capability table. Everything is checked before the
 * network is touched; the reply is read with a byte cap and a deadline; errors
 * carry fixed messages and never copy provider reply text.
 *
 * The credential is resolved inside `generate` only. It is sent as the bearer
 * header and is never returned, logged, put in an error or attached to a result.
 *
 * This module deliberately uses `fetch` rather than LangChain or the `openai`
 * SDK: LangChain's `DallEAPIWrapper` is DALL-E shaped (sizes, quality values,
 * `response_format`), and its Responses `imageGeneration` tool cannot be capped
 * per image. The request is a single JSON POST.
 */
import { createHash } from 'node:crypto'
import { ForgeError } from '../errors/forge-error.js'
import type { ForgeErrorCode } from '../errors/error-codes.js'

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536'
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageComplexity = 'low' | 'medium' | 'high'
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'

/** Pinned route contract for one model. Never touches the network. */
export interface ImageCapabilities {
  provider: 'openai-images'
  model: string
  sizes: readonly ImageSize[]
  qualities: readonly ImageQuality[]
  /** Empty when the model takes no `complexity` parameter. */
  complexities: readonly ImageComplexity[]
  outputFormats: readonly ImageOutputFormat[]
  maxImagesPerRequest: 1
  maxPromptChars: number
}

export interface ImageGenerationRequest {
  model: string
  prompt: string
  /** Default `1024x1024`. */
  size?: ImageSize
  /** Default `auto`. */
  quality?: ImageQuality
  /** Sent only when set; only the GPT-Image-2.6 models accept it. */
  complexity?: ImageComplexity
  /** Default `png`. */
  outputFormat?: ImageOutputFormat
}

export interface ImageTokenDetails {
  imageTokens?: number
  textTokens?: number
}

/** The provider `usage` block, keeping only non-negative integer counters. */
export interface ImageUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokensDetails?: ImageTokenDetails
  outputTokensDetails?: ImageTokenDetails
}

export interface ImageGenerationResult {
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Lowercase hex sha256 of `bytes`. */
  sha256: string
  /** The model the provider reported, or the requested model when it reported none. */
  model: string
  size: ImageSize
  quality: ImageQuality
  complexity?: ImageComplexity
  outputFormat: ImageOutputFormat
  /** Present only when the provider returned one (GPT image models normally do not). */
  revisedPrompt?: string
  usage?: ImageUsage
}

export interface ImageGenerateOptions {
  signal?: AbortSignal
}

export interface ImageProvider {
  readonly id: string
  /** Throws `INVALID_CONFIG` for a model outside the pinned table. */
  capabilities(model: string): ImageCapabilities
  generate(request: ImageGenerationRequest, options?: ImageGenerateOptions): Promise<ImageGenerationResult>
}

export interface OpenAIImagesProviderOptions {
  /** Returns the API key. Called once per `generate`, after every local check passes. */
  resolveCredential: () => string | Promise<string>
  /** Default `https://api.openai.com/v1`. */
  baseUrl?: string
  /** Default `globalThis.fetch`. Inject a dispatcher-bound fetch for proxies or tests. */
  fetchImpl?: typeof fetch
  /** Deadline across dispatch and body consumption. Default 180 000 ms. */
  timeoutMs?: number
  /** Cap on the reply body in bytes. Default 32 MiB. */
  maxOutputBytes?: number
}

export const OPENAI_IMAGES_PROVIDER_ID = 'openai-images'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_PROMPT_CHARS = 32_000

const SIZES: readonly ImageSize[] = Object.freeze(['1024x1024', '1536x1024', '1024x1536'])
const QUALITIES: readonly ImageQuality[] = Object.freeze(['low', 'medium', 'high', 'auto'])
const COMPLEXITIES: readonly ImageComplexity[] = Object.freeze(['low', 'medium', 'high'])
const FORMATS: readonly ImageOutputFormat[] = Object.freeze(['png', 'jpeg', 'webp'])
const NO_COMPLEXITY: readonly ImageComplexity[] = Object.freeze([])

/** The pinned table (OpenAI Images reference and guide, read 2026-11-13). */
const MODELS: Readonly<Record<string, { complexities: readonly ImageComplexity[] }>> = Object.freeze({
  'gpt-image-2.6-flare': { complexities: COMPLEXITIES },
  'gpt-image-2.6-sunburst': { complexities: COMPLEXITIES },
  'gpt-image-2': { complexities: NO_COMPLEXITY },
})

/** Model ids in the pinned table. */
export const OPENAI_IMAGE_MODELS: readonly string[] = Object.freeze(Object.keys(MODELS))

const MIME: Record<ImageOutputFormat, ImageGenerationResult['mimeType']> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function fail(code: ForgeErrorCode, message: string, recoverable = false, context?: Record<string, unknown>): never {
  throw new ForgeError({ code, message, recoverable, ...(context ? { context } : {}) })
}

function openAIImageCapabilities(model: string): ImageCapabilities {
  const entry = Object.prototype.hasOwnProperty.call(MODELS, model) ? MODELS[model] : undefined
  if (!entry) fail('INVALID_CONFIG', 'image model is not in the pinned capability table')
  return {
    provider: 'openai-images',
    model,
    sizes: SIZES,
    qualities: QUALITIES,
    complexities: entry.complexities,
    outputFormats: FORMATS,
    maxImagesPerRequest: 1,
    maxPromptChars: MAX_PROMPT_CHARS,
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail('INVALID_CONFIG', `image ${what} is not supported by the selected model`)
  }
  return value as T
}

function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('INVALID_CONFIG', 'image baseUrl is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('INVALID_CONFIG', 'image baseUrl must be http or https')
  if (url.username || url.password || url.search || url.hash) {
    fail('INVALID_CONFIG', 'image baseUrl must not carry credentials, a query or a fragment')
  }
  return url.href.replace(/\/+$/, '')
}

function positiveInt(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_CONFIG', `image ${what} must be a positive integer`)
  return value
}

function statusError(status: number): never {
  const context = { status }
  if (status === 401 || status === 403) fail('PROVIDER_AUTH_FAILED', 'image provider rejected the credential', false, context)
  if (status === 429) fail('PROVIDER_RATE_LIMITED', 'image provider rate limit reached', true, context)
  if (status >= 500) fail('PROVIDER_UNAVAILABLE', 'image provider is unavailable', true, context)
  fail('PROVIDER_REJECTED_REQUEST', 'image provider rejected the request', false, context)
}

/** Cancel a body or reader without waiting: a cancellation that never settles must not hold the call. */
function discard(target: { cancel(): Promise<void> } | null | undefined): void {
  try {
    void target?.cancel().catch(() => undefined)
  } catch {
    // a locked or already-errored stream: nothing more to release
  }
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response.body)
    fail('PROVIDER_UNAVAILABLE', 'image reply exceeded the size limit')
  }
  if (!response.body) fail('PROVIDER_UNAVAILABLE', 'image reply had no body')
  const reader = response.body.getReader()
  // Release a stream that is not wired to the request signal once the call is over.
  signal.addEventListener('abort', () => discard(reader), { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      discard(reader)
      fail('PROVIDER_UNAVAILABLE', 'image reply exceeded the size limit')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function hasMagic(bytes: Uint8Array, format: ImageOutputFormat): boolean {
  const at = (i: number, values: number[]) => values.every((v, k) => bytes[i + k] === v)
  if (format === 'png') return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (format === 'jpeg') return at(0, [0xff, 0xd8, 0xff])
  return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

function readDetails(value: unknown): ImageTokenDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const details: ImageTokenDetails = {}
  if (count(source['image_tokens'])) details.imageTokens = source['image_tokens']
  if (count(source['text_tokens'])) details.textTokens = source['text_tokens']
  return Object.keys(details).length > 0 ? details : undefined
}

function readUsage(value: unknown): ImageUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const usage: ImageUsage = {}
  if (count(source['input_tokens'])) usage.inputTokens = source['input_tokens']
  if (count(source['output_tokens'])) usage.outputTokens = source['output_tokens']
  if (count(source['total_tokens'])) usage.totalTokens = source['total_tokens']
  const input = readDetails(source['input_tokens_details'])
  if (input) usage.inputTokensDetails = input
  const output = readDetails(source['output_tokens_details'])
  if (output) usage.outputTokensDetails = output
  return Object.keys(usage).length > 0 ? usage : undefined
}

interface DecodedImage {
  bytes: Uint8Array
  model?: string
  revisedPrompt?: string
  usage?: ImageUsage
}

function decodeImage(raw: Uint8Array, format: ImageOutputFormat, maxBytes: number): DecodedImage {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    fail('PROVIDER_UNAVAILABLE', 'image reply was not valid JSON')
  }
  const reply = parsed as { data?: unknown; model?: unknown; usage?: unknown } | null
  const data = reply && typeof reply === 'object' ? reply.data : undefined
  if (!Array.isArray(data) || data.length !== 1) fail('PROVIDER_UNAVAILABLE', 'image reply did not contain exactly one image')
  const item = data[0] as { b64_json?: unknown; revised_prompt?: unknown } | null
  const b64 = item?.b64_json
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !BASE64.test(b64)) {
    fail('PROVIDER_UNAVAILABLE', 'image reply did not contain base64 image data')
  }
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  if (bytes.byteLength > maxBytes) fail('PROVIDER_UNAVAILABLE', 'image reply exceeded the size limit')
  if (!hasMagic(bytes, format)) fail('PROVIDER_UNAVAILABLE', 'image reply did not match the requested format')
  const usage = readUsage(reply?.usage)
  const model = typeof reply?.model === 'string' && reply.model.length > 0 && reply.model.length <= 200 ? reply.model : undefined
  const revised = item?.revised_prompt
  const revisedPrompt = typeof revised === 'string' && revised.length > 0 && revised.length <= MAX_PROMPT_CHARS ? revised : undefined
  return { bytes, ...(model ? { model } : {}), ...(revisedPrompt ? { revisedPrompt } : {}), ...(usage ? { usage } : {}) }
}

const ABORTED = Symbol('aborted')

/**
 * Settle with `work`, or reject with {@link ABORTED} as soon as `signal`
 * aborts. A late result or rejection of `work` is ignored.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(ABORTED)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Validate a request against the pinned table and fill its defaults. Exported
 * for the image tool so both reject the same inputs before any spend.
 */
export function resolveImageRequest(request: ImageGenerationRequest): Required<Omit<ImageGenerationRequest, 'complexity'>> & { complexity?: ImageComplexity } {
  if (!request || typeof request !== 'object') fail('INVALID_CONFIG', 'image request must be an object')
  const caps = openAIImageCapabilities(request.model)
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    fail('INVALID_CONFIG', 'image prompt must be a non-empty string')
  }
  if (request.prompt.length > caps.maxPromptChars) fail('INVALID_CONFIG', 'image prompt is too long')
  const size = oneOf(request.size ?? '1024x1024', caps.sizes, 'size')
  const quality = oneOf(request.quality ?? 'auto', caps.qualities, 'quality')
  const outputFormat = oneOf(request.outputFormat ?? 'png', caps.outputFormats, 'output format')
  const complexity = request.complexity === undefined ? undefined : oneOf(request.complexity, caps.complexities, 'complexity')
  return { model: caps.model, prompt: request.prompt, size, quality, outputFormat, ...(complexity ? { complexity } : {}) }
}

/** Create the OpenAI Images text-to-image provider. */
export function createOpenAIImagesProvider(options: OpenAIImagesProviderOptions): ImageProvider {
  if (!options || typeof options.resolveCredential !== 'function') {
    fail('INVALID_CONFIG', 'image provider needs a resolveCredential function')
  }
  const endpoint = `${normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)}/images/generations`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('INVALID_CONFIG', 'image provider needs a fetch implementation')
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const maxOutputBytes = positiveInt(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
  const resolveCredential = options.resolveCredential

  return {
    id: OPENAI_IMAGES_PROVIDER_ID,
    capabilities: openAIImageCapabilities,
    async generate(request, generateOptions = {}) {
      const resolved = resolveImageRequest(request)
      const callerSignal = generateOptions.signal
      if (callerSignal?.aborted) fail('PROVIDER_TIMEOUT', 'image request was aborted before dispatch')

      let credential: unknown
      try {
        credential = await untilAborted(Promise.resolve().then(resolveCredential), callerSignal)
      } catch (err) {
        if (err === ABORTED) fail('PROVIDER_TIMEOUT', 'image request was aborted before dispatch')
        fail('PROVIDER_AUTH_FAILED', 'image credential could not be resolved')
      }
      if (typeof credential !== 'string' || !/^[\x21-\x7e]+$/.test(credential)) {
        fail('PROVIDER_AUTH_FAILED', 'image credential could not be resolved')
      }
      // The caller may have aborted while the credential was being resolved;
      // a listener added to an already-aborted signal never fires.
      if (callerSignal?.aborted) fail('PROVIDER_TIMEOUT', 'image request was aborted before dispatch')

      const body: Record<string, unknown> = {
        model: resolved.model,
        prompt: resolved.prompt,
        size: resolved.size,
        quality: resolved.quality,
        output_format: resolved.outputFormat,
        n: 1,
      }
      if (resolved.complexity) body['complexity'] = resolved.complexity

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      callerSignal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        let raw: Uint8Array
        try {
          // The deadline is enforced here, not delegated to fetchImpl: dispatch
          // and body consumption race the controller, so a transport or stream
          // that ignores the signal cannot hold the call past timeoutMs.
          raw = await untilAborted((async () => {
            const response = await fetchImpl(endpoint, {
              method: 'POST',
              headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
              body: JSON.stringify(body),
              redirect: 'error',
              signal: controller.signal,
            })
            if (!response.ok) {
              discard(response.body)
              statusError(response.status)
            }
            return readCapped(response, maxOutputBytes, controller.signal)
          })(), controller.signal)
        } catch (err) {
          if (err instanceof ForgeError) throw err
          if (err === ABORTED || controller.signal.aborted) fail('PROVIDER_TIMEOUT', 'image request timed out or was aborted', true)
          fail('PROVIDER_UNAVAILABLE', 'image provider could not be reached', true)
        }
        const decoded = decodeImage(raw, resolved.outputFormat, maxOutputBytes)
        return {
          bytes: decoded.bytes,
          mimeType: MIME[resolved.outputFormat],
          sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
          model: decoded.model ?? resolved.model,
          size: resolved.size,
          quality: resolved.quality,
          ...(resolved.complexity ? { complexity: resolved.complexity } : {}),
          outputFormat: resolved.outputFormat,
          ...(decoded.revisedPrompt ? { revisedPrompt: decoded.revisedPrompt } : {}),
          ...(decoded.usage ? { usage: decoded.usage } : {}),
        }
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onAbort)
        // Ends the reader listener and any stream still attached to the request.
        controller.abort()
      }
    },
  }
}
