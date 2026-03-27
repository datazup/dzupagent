/**
 * ToolLoopLearningHook --- bridges the tool-loop lifecycle into the
 * self-learning system (SelfLearningPipelineHook, SkillLearner, SpecialistRegistry).
 *
 * This module is the glue between:
 *   - tool-loop.ts callbacks (onToolCall, onToolResult, onToolLatency)
 *   - SkillLearner from @forgeagent/core (per-tool execution stats)
 *   - SelfLearningPipelineHook (pipeline-level event dispatch)
 *   - SpecialistRegistry (feature-category routing)
 *
 * Design principles:
 *   - Opt-in: disabled by default, configured via ForgeAgentConfig.selfLearning
 *   - Non-blocking: all persistence is fire-and-forget (best-effort)
 *   - Zero-latency on hot path: learning hooks run AFTER tool execution completes
 *
 * @module agent/tool-loop-learning
 */

import { SkillLearner } from '@forgeagent/core'
import type { SkillMetrics } from '@forgeagent/core'
import type { SpecialistRegistry, SpecialistConfig, NodeConfig } from '../self-correction/specialist-registry.js'
import type { ToolStat, StopReason } from './tool-loop.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the self-learning integration in ForgeAgent. */
export interface ToolLoopLearningConfig {
  /** Enable self-learning hooks (default: false). */
  enabled?: boolean

  /**
   * SkillLearner instance for tracking per-tool execution statistics.
   * If not provided, a fresh in-memory instance is created.
   */
  skillLearner?: SkillLearner

  /**
   * SpecialistRegistry for feature-category-aware routing.
   * When provided, tool-loop learning will load specialist config
   * at the start of each run.
   */
  specialistRegistry?: SpecialistRegistry

  /**
   * Feature category for specialist routing (e.g. 'auth', 'crud', 'payments').
   * Used with specialistRegistry to look up category-specific config.
   */
  featureCategory?: string

  /**
   * Risk class for specialist config adjustment.
   */
  riskClass?: 'critical' | 'sensitive' | 'standard' | 'cosmetic'

  /**
   * Callback invoked after each run with aggregated learning signals.
   * Fire-and-forget --- errors are caught and never propagated.
   */
  onRunLearnings?: (learnings: RunLearnings) => Promise<void>

  /**
   * Callback invoked after each tool execution with the tool result signal.
   * Fire-and-forget --- errors are caught and never propagated.
   */
  onToolLearning?: (signal: ToolLearningSignal) => Promise<void>
}

// ---------------------------------------------------------------------------
// Signal Types
// ---------------------------------------------------------------------------

/** Learning signal extracted from a single tool execution. */
export interface ToolLearningSignal {
  toolName: string
  durationMs: number
  success: boolean
  error?: string
  /** Estimated token cost of the tool invocation (0 if unknown). */
  tokenCost: number
}

/** Aggregated learning signals from a full tool-loop run. */
export interface RunLearnings {
  /** Total LLM calls in the run. */
  llmCalls: number
  /** Total input tokens consumed. */
  totalInputTokens: number
  /** Total output tokens consumed. */
  totalOutputTokens: number
  /** Why the loop stopped. */
  stopReason: StopReason
  /** Per-tool execution stats. */
  toolStats: ToolStat[]
  /** Per-tool skill metrics from SkillLearner. */
  skillMetrics: SkillMetrics[]
  /** Skills that need review (success rate < 50%). */
  skillsNeedingReview: SkillMetrics[]
  /** Skills eligible for optimization (success rate > 80%). */
  optimizableSkills: SkillMetrics[]
  /** Specialist config used for this run (if available). */
  specialistConfig?: SpecialistConfig
  /** Whether the run was stuck. */
  wasStuck: boolean
}

// ---------------------------------------------------------------------------
// Hook Implementation
// ---------------------------------------------------------------------------

/**
 * Manages self-learning hooks for a single ForgeAgent run.
 *
 * Lifecycle:
 *   1. `create()` or `new ToolLoopLearningHook(config)` before the tool loop
 *   2. `recordToolExecution()` after each tool call (called by tool-loop callbacks)
 *   3. `onLoopComplete()` after the tool loop finishes
 *
 * All methods are safe to call even if learning is disabled (they no-op).
 */
export class ToolLoopLearningHook {
  private readonly config: ToolLoopLearningConfig
  private readonly skillLearner: SkillLearner
  private readonly toolSignals: ToolLearningSignal[] = []
  private specialistConfig: SpecialistConfig | undefined

  constructor(config: ToolLoopLearningConfig) {
    this.config = config
    this.skillLearner = config.skillLearner ?? new SkillLearner()
  }

  /** Whether learning is enabled. */
  get enabled(): boolean {
    return this.config.enabled === true
  }

  /** Get the underlying SkillLearner. */
  get learner(): SkillLearner {
    return this.skillLearner
  }

  /**
   * Load specialist config for the current run (async, best-effort).
   * Should be called once before the tool loop starts.
   */
  async loadSpecialistConfig(): Promise<SpecialistConfig | undefined> {
    if (!this.config.specialistRegistry || !this.config.featureCategory) {
      return undefined
    }

    try {
      this.specialistConfig = await this.config.specialistRegistry.getConfig(
        this.config.featureCategory,
        this.config.riskClass,
      )
      return this.specialistConfig
    } catch {
      // Best-effort --- specialist lookup failure is non-fatal
      return undefined
    }
  }

  /**
   * Get node-specific config from the specialist registry.
   * Returns undefined if no specialist registry is configured.
   */
  async getNodeConfig(nodeId: string): Promise<NodeConfig | undefined> {
    if (!this.config.specialistRegistry || !this.config.featureCategory) {
      return undefined
    }

    try {
      return await this.config.specialistRegistry.getNodeConfig(
        this.config.featureCategory,
        nodeId,
        this.config.riskClass,
      )
    } catch {
      return undefined
    }
  }

  /**
   * Record a single tool execution result.
   *
   * Called after each tool invocation in the tool loop.
   * Updates both the internal signal list and the SkillLearner.
   * Fires the onToolLearning callback (fire-and-forget).
   */
  recordToolExecution(
    toolName: string,
    durationMs: number,
    error?: string,
  ): void {
    if (!this.enabled) return

    const success = error === undefined
    const signal: ToolLearningSignal = {
      toolName,
      durationMs,
      success,
      error,
      tokenCost: 0,
    }

    this.toolSignals.push(signal)

    // Update SkillLearner with this execution
    this.skillLearner.recordExecution(toolName, {
      success,
      tokens: 0,
      latencyMs: durationMs,
    })

    // Fire-and-forget callback
    if (this.config.onToolLearning) {
      void this.config.onToolLearning(signal).catch(() => {
        // Swallow errors --- learning must never crash the hot path
      })
    }
  }

  /**
   * Called after the tool loop completes.
   *
   * Aggregates all learning signals from the run and invokes the
   * onRunLearnings callback (fire-and-forget).
   *
   * @returns The aggregated RunLearnings (useful for testing/inspection).
   */
  async onLoopComplete(result: {
    llmCalls: number
    totalInputTokens: number
    totalOutputTokens: number
    stopReason: StopReason
    toolStats: ToolStat[]
  }): Promise<RunLearnings> {
    const learnings: RunLearnings = {
      llmCalls: result.llmCalls,
      totalInputTokens: result.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens,
      stopReason: result.stopReason,
      toolStats: result.toolStats,
      skillMetrics: this.skillLearner.getAllMetrics(),
      skillsNeedingReview: this.skillLearner.getSkillsNeedingReview(),
      optimizableSkills: this.skillLearner.getOptimizableSkills(),
      specialistConfig: this.specialistConfig,
      wasStuck: result.stopReason === 'stuck',
    }

    // Fire-and-forget persistence callback
    if (this.config.onRunLearnings) {
      void this.config.onRunLearnings(learnings).catch(() => {
        // Swallow errors --- persistence failure is non-fatal
      })
    }

    return learnings
  }

  /**
   * Get all tool signals recorded during this run.
   */
  getToolSignals(): ReadonlyArray<ToolLearningSignal> {
    return this.toolSignals
  }

  /**
   * Reset state for a new run.
   */
  reset(): void {
    this.toolSignals.length = 0
    this.specialistConfig = undefined
  }
}

/**
 * Factory: create a ToolLoopLearningHook from config.
 * Returns undefined if learning is disabled.
 */
export function createToolLoopLearningHook(
  config: ToolLoopLearningConfig | undefined,
): ToolLoopLearningHook | undefined {
  if (!config?.enabled) return undefined
  return new ToolLoopLearningHook(config)
}
