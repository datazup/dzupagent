/**
 * Shared types for pre-built agent templates.
 *
 * Templates define the configuration shape for an agent but do NOT instantiate
 * one — the consumer is responsible for resolving model instances and tool
 * implementations based on the `modelTier` and `suggestedTools` hints.
 */

/** Broad category buckets for agent templates. */
export type AgentTemplateCategory =
  | 'code'
  | 'data'
  | 'infrastructure'
  | 'content'
  | 'research'
  | 'automation'

/** A pre-built agent template describing a reusable agent persona. */
export interface AgentTemplate {
  /** Unique template identifier (kebab-case). */
  id: string
  /** Human-readable name. */
  name: string
  /** Short description of the agent's purpose. */
  description: string
  /** Category bucket for discovery and filtering. */
  category: AgentTemplateCategory
  /** System-level instructions injected as the agent's persona. */
  instructions: string
  /** Recommended model tier — helps the consumer pick the right model. */
  modelTier: 'fast' | 'balanced' | 'powerful'
  /**
   * Suggested tool names the agent works best with.
   * These are *hints* — actual `StructuredToolInterface` instances must be
   * supplied by the consumer when constructing the `DzupAgent`.
   */
  suggestedTools?: string[]
  /** Guardrail presets (sensible defaults per use-case). */
  guardrails?: {
    maxTokens?: number
    maxCostCents?: number
    maxIterations?: number
  }
  /** Tags for categorization and discovery. */
  tags: string[]
}
