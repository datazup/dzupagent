import { describe, it, expect } from 'vitest'
import { createLLMJudge, PINNED_JUDGE } from '../scorers/llm-judge-enhanced.js'

describe('llm-judge-enhanced — pinned prompt/model (QF-23)', () => {
  it('does not warn when promptVersion + modelId match the pinned snapshot', () => {
    const warnings: string[] = []
    createLLMJudge({
      criteria: 'overall quality',
      llm: async () => '[]',
      promptVersion: PINNED_JUDGE.promptVersion,
      modelId: PINNED_JUDGE.modelId,
      warn: (msg) => warnings.push(msg),
    })
    expect(warnings).toEqual([])
  })

  it('warns when promptVersion drifts from PINNED_JUDGE', () => {
    const warnings: string[] = []
    createLLMJudge({
      criteria: 'overall quality',
      llm: async () => '[]',
      promptVersion: 'v0.0.0-experimental',
      warn: (msg) => warnings.push(msg),
    })
    expect(warnings.some((w) => w.includes('promptVersion drift'))).toBe(true)
  })

  it('warns when modelId drifts from PINNED_JUDGE', () => {
    const warnings: string[] = []
    createLLMJudge({
      criteria: 'overall quality',
      llm: async () => '[]',
      modelId: 'gpt-3.5-turbo',
      warn: (msg) => warnings.push(msg),
    })
    expect(warnings.some((w) => w.includes('modelId drift'))).toBe(true)
  })
})
