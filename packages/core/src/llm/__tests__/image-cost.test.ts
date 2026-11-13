import { describe, expect, it } from 'vitest'
import { ForgeError } from '../../errors/forge-error.js'
import { OPENAI_IMAGE_MODELS } from '../image-generation.js'
import { OPENAI_IMAGE_PRICES, estimateImageCostUsd, imagePriceRow } from '../image-cost.js'

describe('estimateImageCostUsd', () => {
  it('has a pinned price row for every provider model', () => {
    for (const model of OPENAI_IMAGE_MODELS) expect(imagePriceRow(model)).toEqual(OPENAI_IMAGE_PRICES[model])
    expect(imagePriceRow('gpt-image-2.6-flare')).toEqual({ textInputMicrosPerToken: 5, imageInputMicrosPerToken: 8, imageOutputMicrosPerToken: 30 })
  })

  it('prices split input and all output at the image-output rate', () => {
    const usage = { inputTokens: 300, outputTokens: 4000, inputTokensDetails: { textTokens: 200, imageTokens: 100 } }
    // 200 * 5 + 100 * 8 + 4000 * 30 = 121,800
    expect(estimateImageCostUsd('gpt-image-2.6-sunburst', usage)).toEqual({ micros: 121_800, usd: 0.1218 })
  })

  it('prices unsplit input at the dearer image-input rate', () => {
    expect(estimateImageCostUsd('gpt-image-2', { inputTokens: 100, outputTokens: 0 })).toEqual({ micros: 800, usd: 0.0008 })
    // Only a text split: the rest is image-priced.
    expect(estimateImageCostUsd('gpt-image-2', { inputTokens: 100, outputTokens: 0, inputTokensDetails: { textTokens: 60 } })?.micros).toBe(60 * 5 + 40 * 8)
  })

  it('does not trust details that exceed the input total', () => {
    const usage = { inputTokens: 10, outputTokens: 1, inputTokensDetails: { textTokens: 50, imageTokens: 0 } }
    expect(estimateImageCostUsd('gpt-image-2', usage)?.micros).toBe(10 * 8 + 30)
  })

  it('returns undefined without valid input and output counts', () => {
    for (const usage of [undefined, {}, { inputTokens: 1 }, { outputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 1 }]) {
      expect(estimateImageCostUsd('gpt-image-2', usage as never), JSON.stringify(usage)).toBeUndefined()
    }
  })

  it('refuses a model without a pinned price', () => {
    expect(() => estimateImageCostUsd('gpt-image-1', { inputTokens: 1, outputTokens: 1 })).toThrow(ForgeError)
    expect(() => imagePriceRow('__proto__')).toThrow(ForgeError)
  })
})
