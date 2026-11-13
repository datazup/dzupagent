/**
 * USD cost of one OpenAI image call from its `usage` block
 * (DZUP-OPENAI-IMAGES-20261113-R2).
 *
 * Prices are pinned per model, in micro-USD per token, as read from OpenAI's
 * pricing page on 2026-11-13: text input USD 5, image input USD 8 and image
 * output USD 30 per 1M tokens for gpt-image-2, gpt-image-2.6-flare and
 * gpt-image-2.6-sunburst. The estimate never undercounts: input tokens without
 * a text/image split are priced at the dearer image-input rate, cached tokens
 * get no discount, and every output token is priced as an image token.
 */
import { ForgeError } from '../errors/forge-error.js'
import type { ImageUsage } from './image-generation.js'

export interface ImagePriceRow {
  textInputMicrosPerToken: number
  imageInputMicrosPerToken: number
  imageOutputMicrosPerToken: number
}

/** The date the pinned prices were read. */
export const OPENAI_IMAGE_PRICES_AS_OF = '2026-11-13'

const STANDARD: ImagePriceRow = Object.freeze({
  textInputMicrosPerToken: 5,
  imageInputMicrosPerToken: 8,
  imageOutputMicrosPerToken: 30,
})

export const OPENAI_IMAGE_PRICES: Readonly<Record<string, ImagePriceRow>> = Object.freeze({
  'gpt-image-2': STANDARD,
  'gpt-image-2.6-flare': STANDARD,
  'gpt-image-2.6-sunburst': STANDARD,
})

export interface ImageCostEstimate {
  /** Integer micro-USD (1e-6 USD). */
  micros: number
  /** `micros / 1e6`. */
  usd: number
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Pinned price row for `model`; `INVALID_CONFIG` when the model has none. */
export function imagePriceRow(model: string): ImagePriceRow {
  const row = Object.prototype.hasOwnProperty.call(OPENAI_IMAGE_PRICES, model) ? OPENAI_IMAGE_PRICES[model] : undefined
  if (!row) throw new ForgeError({ code: 'INVALID_CONFIG', message: 'no pinned image price for this model' })
  return row
}

/**
 * Cost of one call. Returns `undefined` when `usage` lacks a valid input or
 * output token count, so the caller can fall back to its own reservation.
 */
export function estimateImageCostUsd(model: string, usage: ImageUsage | undefined): ImageCostEstimate | undefined {
  const row = imagePriceRow(model)
  const input = count(usage?.inputTokens)
  const output = count(usage?.outputTokens)
  if (input === undefined || output === undefined) return undefined
  const text = count(usage?.inputTokensDetails?.textTokens) ?? 0
  const image = count(usage?.inputTokensDetails?.imageTokens) ?? 0
  // Details that claim more tokens than the total are not trusted: all input is then priced at the image rate.
  const split = text + image <= input
  const textPart = split ? text : 0
  const imagePart = input - textPart
  const micros =
    textPart * row.textInputMicrosPerToken +
    imagePart * row.imageInputMicrosPerToken +
    output * row.imageOutputMicrosPerToken
  if (!Number.isSafeInteger(micros)) return undefined
  return { micros, usd: micros / 1_000_000 }
}
