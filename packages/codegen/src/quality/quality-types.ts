/**
 * Quality scoring types for evaluating generated code.
 */

export interface QualityContext {
  plan?: Record<string, unknown>
  techStack?: Record<string, string>
  testResults?: { passed: number; failed: number; errors: string[] }
}

export interface DimensionResult {
  name: string
  score: number
  maxScore: number
  passed: boolean
  errors: string[]
  warnings: string[]
}

export interface QualityResult {
  /** Normalized score 0-100 */
  quality: number
  /** True if no errors across all dimensions */
  success: boolean
  dimensions: DimensionResult[]
  errors: string[]
  warnings: string[]
}

export interface QualityDimension {
  name: string
  maxPoints: number
  evaluate(vfs: Record<string, string>, context?: QualityContext): Promise<DimensionResult>
}
