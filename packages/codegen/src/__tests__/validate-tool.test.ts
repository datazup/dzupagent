import { describe, it, expect, vi } from 'vitest'
import { createValidateTool } from '../tools/validate.tool.js'
import type { QualityScorer } from '../quality/quality-scorer.js'
import type { QualityResult } from '../quality/quality-types.js'

describe('createValidateTool', () => {
  it('runs scorer.evaluate against provided vfs snapshot', async () => {
    const mockResult: QualityResult = {
      quality: 88,
      success: true,
      dimensions: [],
      errors: [],
      warnings: ['minor style issue'],
    }
    const evaluate = vi.fn().mockResolvedValue(mockResult)
    const scorer = { evaluate } as unknown as QualityScorer
    const tool = createValidateTool(scorer)

    const output = await tool.invoke({
      featureId: 'feat-123',
      vfsSnapshot: { 'src/index.ts': 'export const value = 1' },
      context: {
        techStack: { runtime: 'node' },
      },
    })
    const parsed = JSON.parse(String(output))

    expect(evaluate).toHaveBeenCalledWith(
      { 'src/index.ts': 'export const value = 1' },
      { techStack: { runtime: 'node' } },
    )
    expect(parsed).toMatchObject({
      action: 'validate',
      featureId: 'feat-123',
      quality: 88,
      success: true,
      errors: [],
      warnings: ['minor style issue'],
    })
  })
})
