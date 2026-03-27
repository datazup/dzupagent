/**
 * LangGraph Learning Middleware -- bridges all self-correction modules to
 * LangGraph StateGraph node functions.
 *
 * Wraps individual node functions with before/after hooks that enrich prompts,
 * record trajectory steps, capture errors, and emit observability metrics.
 * All learning operations are best-effort and NEVER affect the wrapped node's
 * behavior -- errors from learning are caught and silently ignored.
 *
 * Usage:
 * ```typescript
 * const middleware = new LangGraphLearningMiddleware({ store })
 *
 * const graph = new StateGraph(Annotation)
 *   .addNode("gen_backend", middleware.wrapNode("gen_backend", genBackendFn))
 *   .addNode("gen_frontend", middleware.wrapNode("gen_frontend", genFrontendFn))
 *
 * await middleware.onPipelineStart(runId)
 * const result = await compiled.invoke(input)
 * await middleware.onPipelineEnd({ runId, overallScore: 0.9, approved: true })
 * ```
 *
 * @module self-correction/langgraph-middleware
 */

import type { BaseStore } from '@langchain/langgraph'
import { AdaptivePromptEnricher } from './adaptive-prompt-enricher.js'
import type { PromptEnrichment } from './adaptive-prompt-enricher.js'
import { TrajectoryCalibrator } from './trajectory-calibrator.js'
import { PostRunAnalyzer } from './post-run-analyzer.js'
import type { RunAnalysis } from './post-run-analyzer.js'
import { StrategySelector } from './strategy-selector.js'
import { ErrorDetectionOrchestrator } from './error-detector.js'
import { ObservabilityCorrectionBridge } from './observability-bridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the LangGraph learning middleware. */
export interface LangGraphLearningConfig {
  /** BaseStore for persisting learning data. */
  store: BaseStore
  /** Tenant ID for namespace isolation. */
  tenantId?: string
  /** Task type (e.g. 'crud', 'auth', 'dashboard'). */
  taskType?: string
  /** Risk class of the current task. */
  riskClass?: 'critical' | 'sensitive' | 'standard' | 'cosmetic'
  /** Enable prompt enrichment before node execution (default: true). */
  enableEnrichment?: boolean
  /** Enable trajectory step recording after node execution (default: true). */
  enableTrajectory?: boolean
  /** Enable post-run analysis on pipeline end (default: true). */
  enablePostRunAnalysis?: boolean
  /** Enable fix strategy advice via recommendFixStrategy (default: true). */
  enableStrategyAdvice?: boolean
  /** Max tokens for enrichment content (default: 500). */
  maxEnrichmentTokens?: number
}

/** Metrics accumulated during a pipeline run. */
export interface LearningRunMetrics {
  /** Number of nodes wrapped via wrapNode(). */
  nodesWrapped: number
  /** Number of wrapped nodes that executed. */
  nodesExecuted: number
  /** Number of wrapped nodes that threw an error. */
  nodesFailed: number
  /** Number of enrichments successfully applied. */
  enrichmentsApplied: number
  /** Number of trajectory steps recorded. */
  trajectoryStepsRecorded: number
  /** Total time across all wrapped node executions in ms. */
  totalDurationMs: number
}

/** Options for wrapNode(). */
export interface WrapNodeOptions {
  /** Human-readable description of the node. */
  description?: string
}

// ---------------------------------------------------------------------------
// LangGraphLearningMiddleware
// ---------------------------------------------------------------------------

/**
 * Middleware that bridges self-correction modules to LangGraph StateGraph.
 *
 * Instantiate once per pipeline run, wrap each node function via `wrapNode()`,
 * call `onPipelineStart()` before execution and `onPipelineEnd()` after.
 */
export class LangGraphLearningMiddleware {
  private readonly config: Required<
    Pick<
      LangGraphLearningConfig,
      | 'enableEnrichment'
      | 'enableTrajectory'
      | 'enablePostRunAnalysis'
      | 'enableStrategyAdvice'
      | 'maxEnrichmentTokens'
    >
  > & LangGraphLearningConfig

  // Sub-modules
  private readonly enricher: AdaptivePromptEnricher
  private readonly calibrator: TrajectoryCalibrator
  private readonly analyzer: PostRunAnalyzer
  private readonly strategySelector: StrategySelector
  private readonly errorDetector: ErrorDetectionOrchestrator
  private readonly observability: ObservabilityCorrectionBridge

  // Run tracking
  private currentRunId: string | undefined
  private runStartTime: number | undefined
  private readonly nodeScores = new Map<string, number>()
  private metrics: LearningRunMetrics = this.freshMetrics()

  constructor(config: LangGraphLearningConfig) {
    this.config = {
      ...config,
      enableEnrichment: config.enableEnrichment ?? true,
      enableTrajectory: config.enableTrajectory ?? true,
      enablePostRunAnalysis: config.enablePostRunAnalysis ?? true,
      enableStrategyAdvice: config.enableStrategyAdvice ?? true,
      maxEnrichmentTokens: config.maxEnrichmentTokens ?? 500,
    }

    const namespacePrefix = config.tenantId ? [config.tenantId] : []

    this.enricher = new AdaptivePromptEnricher({
      store: config.store,
      maxTokenBudget: this.config.maxEnrichmentTokens,
      namespaces: {
        lessons: [...namespacePrefix, 'lessons'],
        rules: [...namespacePrefix, 'rules'],
        trajectories: [...namespacePrefix, 'trajectories'],
        errors: [...namespacePrefix, 'errors'],
      },
    })

    this.calibrator = new TrajectoryCalibrator({
      store: config.store,
      namespace: [...namespacePrefix, 'trajectories'],
    })

    this.analyzer = new PostRunAnalyzer({
      store: config.store,
      namespace: [...namespacePrefix, 'post_run'],
    })

    this.strategySelector = new StrategySelector({
      store: config.store,
      namespace: [...namespacePrefix, 'strategy-selector'],
    })

    this.errorDetector = new ErrorDetectionOrchestrator()
    this.observability = new ObservabilityCorrectionBridge()
  }

  // -------------------------------------------------------------------------
  // wrapNode
  // -------------------------------------------------------------------------

  /**
   * Wrap a LangGraph node function with learning hooks.
   * Returns a function with the same signature.
   *
   * Before: enriches state with learned context (if enabled).
   * After success: records trajectory step + observability metrics.
   * After error: records error for analysis, then re-throws.
   *
   * All learning operations are try/catch guarded and NEVER affect the
   * wrapped node's execution or error propagation.
   */
  wrapNode<S extends Record<string, unknown>>(
    nodeId: string,
    fn: (state: S, config?: unknown) => Promise<Partial<S>>,
    _options?: WrapNodeOptions,
  ): (state: S, config?: unknown) => Promise<Partial<S>> {
    this.metrics.nodesWrapped++

    return async (state: S, nodeConfig?: unknown): Promise<Partial<S>> => {
      this.metrics.nodesExecuted++

      // --- Before: enrich state ---
      let enrichedState = state
      if (this.config.enableEnrichment) {
        try {
          const enrichment = await this.enricher.enrich({
            nodeId,
            taskType: this.config.taskType,
            riskClass: this.config.riskClass,
          })

          if (enrichment.content.length > 0) {
            enrichedState = this.applyEnrichment(state, enrichment)
            this.metrics.enrichmentsApplied++
          }
        } catch {
          // Learning errors never affect the node
        }
      }

      // --- Execute the original node function ---
      const startTime = Date.now()
      let result: Partial<S>
      try {
        result = await fn(enrichedState, nodeConfig)
      } catch (error: unknown) {
        const durationMs = Date.now() - startTime
        this.metrics.nodesFailed++
        this.metrics.totalDurationMs += durationMs

        // Record error (best-effort)
        try {
          const message = error instanceof Error ? error.message : String(error)
          this.errorDetector.recordError({
            source: 'build_failure',
            message,
            nodeId,
          })
        } catch {
          // Never affect the node
        }

        // Re-throw the original error
        throw error
      }

      // --- After success ---
      const durationMs = Date.now() - startTime
      this.metrics.totalDurationMs += durationMs

      // Record trajectory step (best-effort)
      if (this.config.enableTrajectory) {
        try {
          await this.calibrator.recordStep({
            nodeId,
            runId: this.currentRunId ?? 'unknown',
            qualityScore: 1.0, // Default score; real scoring happens at pipeline end
            durationMs,
            tokenCost: 0,
            errorCount: 0,
            timestamp: new Date(),
          })
          this.metrics.trajectoryStepsRecorded++
        } catch {
          // Never affect the node
        }
      }

      // Record observability metric (best-effort)
      try {
        this.observability.recordNodeMetric({
          nodeId,
          durationMs,
          costCents: 0,
          tokenUsage: { input: 0, output: 0, budget: 100_000 },
          success: true,
        })
      } catch {
        // Never affect the node
      }

      return result
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline lifecycle
  // -------------------------------------------------------------------------

  /** Call at pipeline start to initialize run tracking. */
  async onPipelineStart(runId: string): Promise<void> {
    this.currentRunId = runId
    this.runStartTime = Date.now()
    this.nodeScores.clear()
    this.errorDetector.reset()
    this.observability.reset()
  }

  /**
   * Call at pipeline end to run post-run analysis.
   * Returns a summary of lessons/rules created.
   */
  async onPipelineEnd(params: {
    runId: string
    overallScore: number
    approved?: boolean
    feedback?: string
    errors?: Array<{
      nodeId: string
      error: string
      resolved: boolean
      resolution?: string
    }>
  }): Promise<{ lessonsCreated: number; rulesCreated: number; summary: string }> {
    if (!this.config.enablePostRunAnalysis) {
      return { lessonsCreated: 0, rulesCreated: 0, summary: 'Post-run analysis disabled.' }
    }

    try {
      const analysis: RunAnalysis = {
        runId: params.runId,
        nodeScores: this.nodeScores,
        errors: (params.errors ?? []).map((e) => ({
          nodeId: e.nodeId,
          error: e.error,
          resolved: e.resolved,
          resolution: e.resolution,
        })),
        overallScore: params.overallScore,
        totalCostCents: 0,
        totalDurationMs: this.runStartTime
          ? Date.now() - this.runStartTime
          : this.metrics.totalDurationMs,
        taskType: this.config.taskType ?? 'unknown',
        riskClass: this.config.riskClass ?? 'standard',
        approved: params.approved ?? false,
        feedback: params.feedback,
      }

      const result = await this.analyzer.analyze(analysis)
      return {
        lessonsCreated: result.lessonsCreated,
        rulesCreated: result.rulesCreated,
        summary: result.summary,
      }
    } catch {
      return { lessonsCreated: 0, rulesCreated: 0, summary: 'Post-run analysis failed.' }
    }
  }

  // -------------------------------------------------------------------------
  // Strategy recommendation
  // -------------------------------------------------------------------------

  /**
   * Get a fix strategy recommendation for a given error type at a node.
   * Delegates to StrategySelector.
   */
  async recommendFixStrategy(
    errorType: string,
    nodeId: string,
  ): Promise<{ strategy: string; confidence: number; reasoning: string }> {
    if (!this.config.enableStrategyAdvice) {
      return {
        strategy: 'targeted',
        confidence: 0.3,
        reasoning: 'Strategy advice disabled.',
      }
    }

    try {
      const recommendation = await this.strategySelector.recommend({
        errorType,
        nodeId,
      })
      return {
        strategy: recommendation.strategy,
        confidence: recommendation.confidence,
        reasoning: recommendation.reasoning,
      }
    } catch {
      return {
        strategy: 'targeted',
        confidence: 0.1,
        reasoning: 'Strategy recommendation failed; defaulting to targeted.',
      }
    }
  }

  // -------------------------------------------------------------------------
  // Enrichment (standalone)
  // -------------------------------------------------------------------------

  /**
   * Get enrichment content for a node without wrapping it.
   * Useful for manual prompt composition.
   */
  async enrichPrompt(nodeId: string): Promise<string> {
    try {
      const enrichment = await this.enricher.enrich({
        nodeId,
        taskType: this.config.taskType,
        riskClass: this.config.riskClass,
      })
      return enrichment.content
    } catch {
      return ''
    }
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /** Get accumulated run metrics. */
  getMetrics(): LearningRunMetrics {
    return { ...this.metrics }
  }

  /** Reset metrics for a new run. */
  resetMetrics(): void {
    this.metrics = this.freshMetrics()
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Apply enrichment content to state. Injects into `_learningContext` or
   * `systemPromptAddendum` if that key already exists in the state.
   */
  private applyEnrichment<S extends Record<string, unknown>>(
    state: S,
    enrichment: PromptEnrichment,
  ): S {
    if ('systemPromptAddendum' in state) {
      const existing = typeof state['systemPromptAddendum'] === 'string'
        ? state['systemPromptAddendum'] as string
        : ''
      return {
        ...state,
        systemPromptAddendum: existing.length > 0
          ? `${existing}\n\n${enrichment.content}`
          : enrichment.content,
      }
    }
    return {
      ...state,
      _learningContext: enrichment.content,
    }
  }

  private freshMetrics(): LearningRunMetrics {
    return {
      nodesWrapped: 0,
      nodesExecuted: 0,
      nodesFailed: 0,
      enrichmentsApplied: 0,
      trajectoryStepsRecorded: 0,
      totalDurationMs: 0,
    }
  }
}
