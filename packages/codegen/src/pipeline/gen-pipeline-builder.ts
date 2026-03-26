/**
 * Fluent builder for code generation pipelines.
 *
 * Creates a LangGraph StateGraph from a declarative configuration
 * of phases, validation, fix loops, and review checkpoints.
 *
 * NOTE: This is a configuration builder, not a full graph compiler.
 * The actual graph compilation happens in the domain layer (e.g., @starterforge/ai)
 * because graph topology requires domain-specific routing functions.
 * This builder captures the pipeline CONFIGURATION that the domain layer uses.
 */
import type { ModelTier } from '@forgeagent/core'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { QualityDimension } from '../quality/quality-types.js'
import type { EscalationConfig } from './fix-escalation.js'
import { DEFAULT_ESCALATION } from './fix-escalation.js'
import type { GuardrailGateConfig } from './guardrail-gate.js'

/** Configured phase in the pipeline */
export interface PipelinePhase {
  name: string
  type: 'generation' | 'subagent' | 'validation' | 'fix' | 'review' | 'guardrail'
  promptType?: string
  modelTier?: ModelTier
  tools?: StructuredToolInterface[]
  skills?: string[]
  skipCondition?: (state: Record<string, unknown>) => boolean
  // Validation-specific
  dimensions?: QualityDimension[]
  threshold?: number
  // Fix-specific
  maxAttempts?: number
  escalation?: EscalationConfig
  // Review-specific
  autoApprove?: boolean
  // Sub-agent-specific
  subagentConfig?: Record<string, unknown>
  // Guardrail-specific
  guardrailGate?: GuardrailGateConfig
}

/**
 * Fluent pipeline builder. Captures the configuration of a multi-phase
 * code generation pipeline for use by the domain layer's graph compiler.
 */
export class GenPipelineBuilder {
  private phases: PipelinePhase[] = []
  private guardrailConfig?: GuardrailGateConfig

  /**
   * Configure a guardrail gate for this pipeline. This inserts a guardrail
   * validation phase between the last generation/subagent phase and the
   * first review phase. The gate config is also stored so that consumers
   * (e.g., PipelineExecutor) can retrieve it via `getGuardrailConfig()`.
   */
  withGuardrails(config: GuardrailGateConfig): this {
    this.guardrailConfig = config
    this.phases.push({
      name: 'guardrail-gate',
      type: 'guardrail',
      guardrailGate: config,
    })
    return this
  }

  /** Get the configured guardrail gate config, if any */
  getGuardrailConfig(): GuardrailGateConfig | undefined {
    return this.guardrailConfig
  }

  /** Add a standard generation phase */
  addPhase(config: {
    name: string
    promptType: string
    modelTier?: ModelTier
    tools?: StructuredToolInterface[]
    skills?: string[]
    skipCondition?: (state: Record<string, unknown>) => boolean
  }): this {
    this.phases.push({ ...config, type: 'generation' })
    return this
  }

  /** Add a sub-agent-based generation phase */
  addSubAgentPhase(config: {
    name: string
    promptType: string
    modelTier?: ModelTier
    tools?: StructuredToolInterface[]
    skills?: string[]
    subagentConfig?: Record<string, unknown>
  }): this {
    this.phases.push({ ...config, type: 'subagent' })
    return this
  }

  /** Add a validation phase with quality scoring */
  addValidationPhase(config: {
    name?: string
    dimensions: QualityDimension[]
    threshold: number
  }): this {
    this.phases.push({
      name: config.name ?? 'validate',
      type: 'validation',
      dimensions: config.dimensions,
      threshold: config.threshold,
    })
    return this
  }

  /** Add a fix phase with escalation strategy */
  addFixPhase(config?: {
    name?: string
    maxAttempts?: number
    escalation?: EscalationConfig
  }): this {
    this.phases.push({
      name: config?.name ?? 'fix',
      type: 'fix',
      maxAttempts: config?.maxAttempts ?? 3,
      escalation: config?.escalation ?? DEFAULT_ESCALATION,
    })
    return this
  }

  /** Add a review/approval phase */
  addReviewPhase(config?: {
    name?: string
    autoApprove?: boolean
  }): this {
    this.phases.push({
      name: config?.name ?? 'review',
      type: 'review',
      autoApprove: config?.autoApprove ?? false,
    })
    return this
  }

  /** Get the built pipeline configuration */
  getPhases(): readonly PipelinePhase[] {
    return this.phases
  }

  /** Get phase by name */
  getPhase(name: string): PipelinePhase | undefined {
    return this.phases.find(p => p.name === name)
  }

  /** Get all phase names in order */
  getPhaseNames(): string[] {
    return this.phases.map(p => p.name)
  }

  /** Get generation phases only */
  getGenerationPhases(): PipelinePhase[] {
    return this.phases.filter(p => p.type === 'generation' || p.type === 'subagent')
  }
}
