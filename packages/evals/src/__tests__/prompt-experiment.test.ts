import { describe, expect, it } from 'vitest'
import { PromptExperiment, EvalDataset } from '../index.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

describe('PromptExperiment', () => {
  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
  ])('rejects %s as concurrency', async (_, concurrency) => {
    const experiment = new PromptExperiment({
      model: {} as BaseChatModel,
      scorers: [],
      concurrency,
    })

    const variants = [
      { id: 'a', name: 'A', systemPrompt: 'prompt a' },
      { id: 'b', name: 'B', systemPrompt: 'prompt b' },
    ]

    const dataset = EvalDataset.from([
      { id: 'entry-1', input: 'hello' },
    ])

    await expect(experiment.run(variants, dataset)).rejects.toThrow(
      `PromptExperiment concurrency must be a finite positive integer; received ${String(concurrency)}`,
    )
  })
})
