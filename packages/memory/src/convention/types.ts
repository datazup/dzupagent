/**
 * Convention detection and conformance checking types.
 *
 * Used by ConventionExtractor to detect project coding conventions
 * from code samples and check conformance of new code against them.
 */
import type { MemoryService } from '../memory-service.js'
import type { SemanticStoreAdapter } from '../memory-types.js'

export type ConventionCategory =
  | 'naming'
  | 'structure'
  | 'imports'
  | 'error-handling'
  | 'typing'
  | 'testing'
  | 'api'
  | 'database'
  | 'styling'
  | 'general'

export const ALL_CONVENTION_CATEGORIES: readonly ConventionCategory[] = [
  'naming',
  'structure',
  'imports',
  'error-handling',
  'typing',
  'testing',
  'api',
  'database',
  'styling',
  'general',
] as const

export interface DetectedConvention {
  id: string
  name: string
  category: ConventionCategory
  description: string
  /** Regex or glob pattern that identifies this convention */
  pattern?: string | undefined
  /** Code examples demonstrating the convention */
  examples: string[]
  /** Confidence 0.0-1.0 */
  confidence: number
  /** Number of occurrences observed */
  occurrences: number
  /** Which tech stack this applies to (e.g., 'vue3', 'react', 'express') */
  techStack?: string | undefined
  /** Human verdict: true = confirmed, false = rejected, undefined = pending */
  humanVerified?: boolean | undefined
}

export interface ConventionFollowed {
  convention: DetectedConvention
  evidence: string
}

export interface ConventionViolated {
  convention: DetectedConvention
  evidence: string
  suggestion: string
}

export interface ConventionCheckResult {
  /** Overall conformance score 0.0-1.0 */
  conformanceScore: number
  followed: ConventionFollowed[]
  violated: ConventionViolated[]
}

export interface ConventionExtractorConfig {
  memoryService: MemoryService
  /** LLM function for analyzing code. Accepts prompt, returns string. */
  llm?: ((prompt: string) => Promise<string>) | undefined
  /** Namespace for storing conventions (default: '__conventions') */
  namespace?: string | undefined
  /** Optional semantic store for auto-embedding and semantic retrieval of conventions */
  semanticStore?: SemanticStoreAdapter | undefined
}

export interface ConventionFilter {
  category?: ConventionCategory | undefined
  techStack?: string | undefined
  minConfidence?: number | undefined
  /** Semantic query for ranking conventions by relevance (requires semanticStore) */
  query?: string | undefined
}

export interface ConsolidateOptions {
  /** Minimum confidence to keep (default: 0.3) */
  minConfidence?: number | undefined
  /** Similarity threshold for merging 0.0-1.0 (default: 0.8) */
  mergeSimilarity?: number | undefined
}
