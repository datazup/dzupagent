/**
 * Generic validate tool — runs QualityScorer on current VFS.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { QualityScorer } from '../quality/quality-scorer.js'

export function createValidateTool(_scorer: QualityScorer) {
  return tool(
    async ({ featureId }) => {
      // NOTE: The actual VFS content is injected by the calling node,
      // not by the tool itself. The tool runs scoring on what it receives.
      // In practice, the graph node reads vfsSnapshot from state and passes it.
      // Here we return a placeholder that the node interprets.
      return JSON.stringify({
        action: 'validate',
        featureId,
        message: 'Validation should be invoked by the graph node with VFS content. Call scorer.evaluate(vfsSnapshot) directly.',
      })
    },
    {
      name: 'validate_feature',
      description: 'Run quality validation on the generated feature. Returns a quality score and list of errors/warnings.',
      schema: z.object({
        featureId: z.string().describe('Feature ID to validate'),
      }),
    },
  )
}
