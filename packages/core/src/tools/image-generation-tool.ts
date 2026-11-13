/**
 * Agent tool for one-image generation (DZUP-OPENAI-IMAGES-20261113-R1).
 *
 * The tool calls an {@link ImageProvider}, hands the bytes to the caller's
 * `store`, and returns only a reference and metadata to the model, never the
 * image data. `maxImages` caps provider calls per tool instance: a slot is taken
 * before the provider is called and is not returned when the call fails, since a
 * failed call may still have been billed.
 */
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createForgeTool } from './create-tool.js'
import { ForgeError } from '../errors/forge-error.js'
import { resolveImageRequest } from '../llm/image-generation.js'
import type {
  ImageComplexity,
  ImageGenerationResult,
  ImageOutputFormat,
  ImageProvider,
  ImageQuality,
  ImageSize,
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
  /** Default `generate_image`. */
  id?: string
  description?: string
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
  const caps = options.provider.capabilities(options.model)
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
      used += 1
      const image = await options.provider.generate(request, { signal: context.signal })
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
      }
    },
  })
}
