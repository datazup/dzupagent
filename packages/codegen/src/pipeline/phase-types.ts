/**
 * Phase and state types for code generation pipelines.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { ModelTier } from '@dzipagent/core'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { SubAgentConfig } from '@dzipagent/core'
import type { QualityDimension } from '../quality/quality-types.js'
import type { EscalationConfig } from './fix-escalation.js'

/** Phase configuration for a generation node */
export interface PhaseConfig {
  name: string
  promptType: string
  modelTier?: ModelTier
  tools?: StructuredToolInterface[]
  skills?: string[]
  /** Condition to skip this phase (e.g., scope check) */
  skipCondition?: (state: BaseGenState) => boolean
}

/** Sub-agent phase — delegates to an isolated child agent */
export interface SubAgentPhaseConfig extends PhaseConfig {
  subagent: SubAgentConfig
}

/** Validation phase — runs quality scoring */
export interface ValidationPhaseConfig {
  name?: string
  dimensions: QualityDimension[]
  threshold: number
}

/** Fix phase — auto-corrects validation/test failures */
export interface FixPhaseConfig {
  name?: string
  maxAttempts: number
  escalation?: EscalationConfig
}

/** Review phase — human-in-the-loop checkpoint */
export interface ReviewPhaseConfig {
  name?: string
  autoApprove?: boolean
}

/** Base state shared by all code generation pipelines */
export interface BaseGenState {
  messages: BaseMessage[]
  vfsSnapshot: Record<string, string>
  phase: string
  fixAttempts: number
  fixStrategy: 'targeted' | 'expanded' | 'escalated'
  validationResult: {
    quality: number
    success: boolean
    errors: string[]
    warnings: string[]
  } | null
  testResults: {
    passed: number
    failed: number
    errors: string[]
    failedTests: Array<{ name: string; error: string; file: string }>
  } | null
  conversationSummary: string | null
  memoryContext: Record<string, string>
  toolCallCount: number
}
