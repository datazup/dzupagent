/**
 * Generic validate tool — runs QualityScorer on current VFS.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { QualityScorer } from '../quality/quality-scorer.js'
import type { QualityContext } from '../quality/quality-types.js'

const qualityContextSchema = z.object({
  plan: z.record(z.string(), z.unknown()).optional(),
  techStack: z.record(z.string(), z.string()).optional(),
  testResults: z
    .object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      errors: z.array(z.string()),
    })
    .optional(),
})

export function createValidateTool(scorer: QualityScorer) {
  return tool(
    async ({ featureId, vfsSnapshot, context }) => {
      const qualityContext = context as QualityContext | undefined
      const result = await scorer.evaluate(vfsSnapshot, qualityContext)

      return JSON.stringify({
        action: 'validate',
        featureId,
        quality: result.quality,
        success: result.success,
        dimensions: result.dimensions,
        errors: result.errors,
        warnings: result.warnings,
      })
    },
    {
      name: 'validate_feature',
      description: 'Run quality validation on the generated feature. Returns a quality score and list of errors/warnings.',
      schema: z.object({
        featureId: z.string().describe('Feature ID to validate'),
        vfsSnapshot: z
          .record(z.string(), z.string())
          .describe('Current file-system snapshot: path -> file content'),
        context: qualityContextSchema
          .optional()
          .describe('Optional quality-evaluation context (plan, tech stack, test results).'),
      }),
    },
  )
}
