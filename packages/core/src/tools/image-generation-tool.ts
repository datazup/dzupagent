/**
 * Agent tool for one-image generation (DZUP-OPENAI-IMAGES-20261113-R1).
 *
 * The tool calls an {@link ImageProvider}, hands the bytes to the caller's
 * `store`, and returns only a reference and metadata to the model, never the
 * image data. `maxImages` caps provider calls per tool instance: a slot is taken
 * before the provider is called and is not returned when the call fails, since a
 * failed call may still have been billed.
 *
 * DZUP-OPENAI-IMAGES-20261113-R2 adds a dollar threshold. With `maxUsd`, each
 * call first holds `max(reserveUsdPerImage, largest usage-based cost settled so
 * far)`; the call is refused when settled spend plus open holds plus the new
 * hold would pass `maxUsd`. When the call returns, its hold becomes the
 * usage-based cost from the pinned price table, or is charged in full when
 * usage is missing or the call failed.
 *
 * `maxUsd` is an admission threshold, not a guaranteed spend cap: the tool
 * cannot bound what the vendor charges for a call it already admitted, so
 * settled spend can pass `maxUsd` by the amount in-flight calls cost above
 * their holds. Set `reserveUsdPerImage` at or above the worst case for the
 * size and quality, and use a metering proxy when a hard cap is required.
 */
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createForgeTool } from './create-tool.js'
import { ForgeError } from '../errors/forge-error.js'
import { resolveImageRequest } from '../llm/image-generation.js'
import { OPENAI_IMAGE_PRICES, estimateImageCostUsd } from '../llm/image-cost.js'
import type {
  ImageComplexity,
  ImageGenerationResult,
  ImageOutputFormat,
  ImageProvider,
  ImageQuality,
  ImageSize,
  ImageUsage,
} from '../llm/image-generation.js'

export interface ImageGenerationToolDefaults {
  size?: ImageSize
  quality?: ImageQuality
  complexity?: ImageComplexity
  outputFormat?: ImageOutputFormat
}

/** What the caller's store receives: the generated image plus the prompt that produced it. */
export interface StoredImageInput extends ImageGenerationResult {
  prompt: string
}

export interface ImageGenerationToolOptions {
  provider: ImageProvider
  /** Required: no model is chosen silently. */
  model: string
  /** Positive integer; provider calls allowed for this tool instance. */
  maxImages: number
  /** Persists the image and returns a reference the model can cite. */
  store: (image: StoredImageInput) => Promise<{ ref: string }>
  defaults?: ImageGenerationToolDefaults
  /** Optional dollar admission threshold (not a hard cap; see the module note). Requires `reserveUsdPerImage`. */
  maxUsd?: number
  /** Held per call until its cost is known; charged in full when usage is missing or the call fails. */
  reserveUsdPerImage?: number
  /** Receives each settled charge. A hook that throws does not change the tool result. */
  onCost?: (event: ImageCostEvent) => void
  /** Default `generate_image`. */
  id?: string
  description?: string
}

/** One settled charge. `basis` says where `costUsd` came from; `unknown` means no usage and no reserve. */
export interface ImageCostEvent {
  model: string
  size: ImageSize
  quality: ImageQuality
  complexity?: ImageComplexity
  outcome: 'generated' | 'failed'
  basis: 'usage' | 'reserve' | 'unknown'
  costUsd?: number
  usage?: ImageUsage
  sha256?: string
}

export interface ImageGenerationToolOutput {
  ref: string
  model: string
  size: ImageSize
  quality: ImageQuality
  complexity?: ImageComplexity
  outputFormat: ImageOutputFormat
  mimeType: string
  bytes: number
  sha256: string
  /** Present when usage or a reserve priced the call. */
  costUsd?: number
}

const MICROS = 1_000_000

function positiveUsd(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ForgeError({ code: 'INVALID_CONFIG', message: `image tool ${name} must be a positive number` })
  }
  return value
}

function asEnum<T extends string>(values: readonly T[]): z.ZodType<T> {
  return z.enum(values as unknown as [T, ...T[]]) as unknown as z.ZodType<T>
}

/** Create the image generation tool. Validates the model and defaults up front. */
export function createImageGenerationTool(options: ImageGenerationToolOptions): StructuredToolInterface {
  if (!options || typeof options.store !== 'function' || !options.provider) {
    throw new ForgeError({ code: 'INVALID_CONFIG', message: 'image tool needs a provider and a store function' })
  }
  if (!Number.isSafeInteger(options.maxImages) || options.maxImages <= 0) {
    throw new ForgeError({ code: 'INVALID_CONFIG', message: 'image tool maxImages must be a positive integer' })
  }
  const reserveMicros =
    options.reserveUsdPerImage === undefined
      ? undefined
      : Math.ceil(positiveUsd(options.reserveUsdPerImage, 'reserveUsdPerImage') * MICROS)
  let maxMicros: number | undefined
  if (options.maxUsd !== undefined) {
    maxMicros = Math.floor(positiveUsd(options.maxUsd, 'maxUsd') * MICROS)
    if (reserveMicros === undefined || reserveMicros > maxMicros) {
      throw new ForgeError({
        code: 'INVALID_CONFIG',
        message: 'image tool maxUsd needs a reserveUsdPerImage no larger than maxUsd',
      })
    }
  }
  if (options.onCost !== undefined && typeof options.onCost !== 'function') {
    throw new ForgeError({ code: 'INVALID_CONFIG', message: 'image tool onCost must be a function' })
  }
  const caps = options.provider.capabilities(options.model)
  const priced = Object.prototype.hasOwnProperty.call(OPENAI_IMAGE_PRICES, caps.model)
  const defaults = options.defaults ?? {}
  // Reject defaults outside the pinned table now, not on the first spend.
  resolveImageRequest({ model: caps.model, prompt: 'x', ...defaults })

  const shape: Record<string, z.ZodTypeAny> = {
    prompt: z.string().min(1).max(caps.maxPromptChars).describe('What the image should show'),
    size: asEnum(caps.sizes).optional().describe('Image size, WIDTHxHEIGHT'),
    quality: asEnum(caps.qualities).optional().describe('Rendering quality'),
  }
  if (caps.complexities.length > 0) {
    shape['complexity'] = asEnum(caps.complexities).optional().describe('Visual complexity')
  }
  const inputSchema = z.object(shape).strict()

  let used = 0
  let spentMicros = 0
  let heldMicros = 0
  let largestMicros = 0
  const report = (event: ImageCostEvent): void => {
    if (!options.onCost) return
    try {
      options.onCost(event)
    } catch {
      // The charge is already counted here; a failing ledger hook must not hide the image or the error.
    }
  }
  return createForgeTool({
    id: options.id ?? 'generate_image',
    description:
      options.description ??
      `Generate one image with ${caps.model} from a text prompt. Returns a stored reference, not the image data.`,
    inputSchema,
    execute: async (input, context): Promise<ImageGenerationToolOutput> => {
      const args = input as { prompt: string; size?: ImageSize; quality?: ImageQuality; complexity?: ImageComplexity }
      if (used >= options.maxImages) {
        throw new ForgeError({ code: 'BUDGET_EXCEEDED', message: 'image tool reached its maxImages limit' })
      }
      const request = resolveImageRequest({
        model: caps.model,
        prompt: args.prompt,
        ...defaults,
        ...(args.size ? { size: args.size } : {}),
        ...(args.quality ? { quality: args.quality } : {}),
        ...(args.complexity ? { complexity: args.complexity } : {}),
      })
      const hold = reserveMicros === undefined ? 0 : Math.max(reserveMicros, largestMicros)
      if (maxMicros !== undefined && spentMicros + heldMicros + hold > maxMicros) {
        throw new ForgeError({ code: 'BUDGET_EXCEEDED', message: 'image tool reached its maxUsd limit' })
      }
      used += 1
      heldMicros += hold
      const charge = {
        model: caps.model,
        size: request.size,
        quality: request.quality,
        ...(request.complexity ? { complexity: request.complexity } : {}),
      }
      let image: ImageGenerationResult
      try {
        image = await options.provider.generate(request, { signal: context.signal })
      } catch (error) {
        heldMicros -= hold
        spentMicros += hold
        report({
          ...charge,
          outcome: 'failed',
          basis: reserveMicros === undefined ? 'unknown' : 'reserve',
          ...(reserveMicros === undefined ? {} : { costUsd: hold / MICROS }),
        })
        throw error
      }
      heldMicros -= hold
      const estimate = priced ? estimateImageCostUsd(caps.model, image.usage) : undefined
      if (estimate) largestMicros = Math.max(largestMicros, estimate.micros)
      const costMicros = estimate?.micros ?? (reserveMicros === undefined ? undefined : hold)
      spentMicros += costMicros ?? 0
      report({
        ...charge,
        outcome: 'generated',
        basis: estimate ? 'usage' : reserveMicros === undefined ? 'unknown' : 'reserve',
        ...(costMicros === undefined ? {} : { costUsd: costMicros / MICROS }),
        ...(image.usage ? { usage: image.usage } : {}),
        sha256: image.sha256,
      })
      const stored = await options.store({ ...image, prompt: request.prompt })
      if (!stored || typeof stored.ref !== 'string' || stored.ref.length === 0) {
        throw new ForgeError({ code: 'INVALID_CONFIG', message: 'image store returned no reference' })
      }
      return {
        ref: stored.ref,
        model: image.model,
        size: image.size,
        quality: image.quality,
        ...(image.complexity ? { complexity: image.complexity } : {}),
        outputFormat: image.outputFormat,
        mimeType: image.mimeType,
        bytes: image.bytes.byteLength,
        sha256: image.sha256,
        ...(costMicros === undefined ? {} : { costUsd: costMicros / MICROS }),
      }
    },
  })
}
