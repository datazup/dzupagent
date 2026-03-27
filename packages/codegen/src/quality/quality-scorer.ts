/**
 * Evaluates generated code quality across multiple dimensions.
 * Each dimension contributes a weighted score; the final result
 * is normalized to 0-100.
 */

import type { QualityDimension, QualityResult, QualityContext } from './quality-types.js'

export class QualityScorer {
  private dimensions: QualityDimension[] = []

  addDimension(dimension: QualityDimension): this {
    this.dimensions.push(dimension)
    return this
  }

  addDimensions(dimensions: QualityDimension[]): this {
    this.dimensions.push(...dimensions)
    return this
  }

  async evaluate(vfs: Record<string, string>, context?: QualityContext): Promise<QualityResult> {
    const results = await Promise.all(
      this.dimensions.map(d => d.evaluate(vfs, context))
    )

    const totalMax = results.reduce((sum, r) => sum + r.maxScore, 0)
    const totalScore = results.reduce((sum, r) => sum + r.score, 0)
    const quality = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0
    const errors = results.flatMap(r => r.errors)
    const warnings = results.flatMap(r => r.warnings)
    const success = errors.length === 0

    return { quality, success, dimensions: results, errors, warnings }
  }
}
