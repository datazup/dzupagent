/**
 * SelfLearningRuntime --- a PipelineRuntime wrapper that auto-configures
 * all self-correction modules (stuck detection, prompt enrichment,
 * trajectory recording, post-run analysis, observability bridge) and
 * exposes the same execute/resume/cancel API.
 *
 * All learning operations are best-effort --- they never crash the pipeline.
 *
 * @module self-correction/self-learning-runtime
 */

import type { BaseStore } from '@langchain/langgraph'
import type { PipelineCheckpoint } from '@dzupagent/core'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import type {
  PipelineRuntimeConfig,
  PipelineRunResult,
  PipelineState,
  PipelineRuntimeEvent,
} from '../pipeline/pipeline-runtime-types.js'
import { PipelineStuckDetector } from './pipeline-stuck-detector.js'
import { SelfLearningPipelineHook } from './self-learning-hook.js'
import type { HookMetrics } from './self-learning-hook.js'
import { AdaptivePromptEnricher } from './adaptive-prompt-enricher.js'
import { TrajectoryCalibrator } from './trajectory-calibrator.js'
import { ErrorDetectionOrchestrator } from './error-detector.js'
import { ObservabilityCorrectionBridge } from './observability-bridge.js'
import { PostRunAnalyzer } from './post-run-analyzer.js'
import type { RunAnalysis, AnalysisResult } from './post-run-analyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelfLearningConfig {
  /** Store for all learning data (lessons, rules, trajectories, skills) */
  store: BaseStore
  /** Enable/disable learning (default: true) */
  enableLearning?: boolean
  /** Enable prompt enrichment before nodes (default: true) */
  enableEnrichment?: boolean
  /** Enable trajectory recording (default: true) */
  enableTrajectory?: boolean
  /** Enable post-run analysis (default: true) */
  enablePostRunAnalysis?: boolean
  /** Enable stuck detection (default: true) */
  enableStuckDetection?: boolean
  /** Enable observability signals (default: true) */
  enableObservability?: boolean
  /** Task type for this pipeline run */
  taskType?: string
  /** Risk class for this run */
  riskClass?: 'critical' | 'sensitive' | 'standard' | 'cosmetic'
  /** Namespace prefix for all learning data (default: ['self-learning']) */
  namespace?: string[]
}

export interface SelfLearningRunResult extends PipelineRunResult {
  /** Post-run analysis (if enabled) */
  analysis?: {
    lessonsCreated: number
    rulesCreated: number
    suboptimalNodes: string[]
    summary: string
  }
  /** Learning metrics from the hook */
  learningMetrics?: {
    enrichmentsApplied: number
    stuckDetections: number
    recoveriesAttempted: number
  }
  /** Whether trajectory was stored */
  trajectoryStored?: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SelfLearningRuntime {
  private readonly pipelineRuntime: PipelineRuntime
  private readonly hook: SelfLearningPipelineHook
  private readonly postRunAnalyzer: PostRunAnalyzer | undefined
  // Reserved for Sprint 7 wiring (observability bridge)
  _observabilityBridge: ObservabilityCorrectionBridge | undefined
  private readonly trajectoryCalibrator: TrajectoryCalibrator | undefined
  private readonly errorDetector: ErrorDetectionOrchestrator | undefined
  // Reserved for Sprint 7 wiring (learning config access)
  _learningConfig: SelfLearningConfig
  private readonly taskType: string
  private readonly riskClass: 'critical' | 'sensitive' | 'standard' | 'cosmetic'

  constructor(
    pipelineConfig: PipelineRuntimeConfig,
    learningConfig: SelfLearningConfig,
  ) {
    this._learningConfig = learningConfig
    this.taskType = learningConfig.taskType ?? 'unknown'
    this.riskClass = learningConfig.riskClass ?? 'standard'

    const ns = learningConfig.namespace ?? ['self-learning']
    const isEnabled = learningConfig.enableLearning !== false

    // (a) Create PipelineStuckDetector
    let stuckDetector = pipelineConfig.stuckDetector
    if (isEnabled && learningConfig.enableStuckDetection !== false && !stuckDetector) {
      stuckDetector = new PipelineStuckDetector()
    }

    // (b) Create TrajectoryCalibrator
    if (isEnabled && learningConfig.enableTrajectory !== false) {
      this.trajectoryCalibrator = new TrajectoryCalibrator({
        store: learningConfig.store,
        namespace: [...ns, 'trajectories'],
      })
    }

    // (c) Create ErrorDetectionOrchestrator
    if (isEnabled) {
      this.errorDetector = new ErrorDetectionOrchestrator()
    }

    // (d) Create AdaptivePromptEnricher and wire into hook
    let enricher: AdaptivePromptEnricher | undefined
    if (isEnabled && learningConfig.enableEnrichment !== false) {
      enricher = new AdaptivePromptEnricher({
        store: learningConfig.store,
        namespaces: {
          lessons: [...ns, 'lessons'],
          rules: [...ns, 'rules'],
          trajectories: [...ns, 'trajectories'],
          errors: [...ns, 'errors'],
        },
      })
    }

    // (e) Create SelfLearningPipelineHook with callbacks
    this.hook = new SelfLearningPipelineHook({
      onBeforeNode: enricher
        ? async (nodeId: string) => {
            try {
              const result = await enricher.enrich({ nodeId, taskType: this.taskType, riskClass: this.riskClass })
              return result.content || undefined
            } catch {
              return undefined
            }
          }
        : undefined,

      onNodeCompleted: this.trajectoryCalibrator
        ? async (nodeId: string, durationMs: number) => {
            try {
              await this.trajectoryCalibrator!.recordStep({
                nodeId,
                runId: 'current',
                qualityScore: 1.0,
                durationMs,
                tokenCost: 0,
                errorCount: 0,
                timestamp: new Date(),
              })
            } catch {
              // best-effort
            }
          }
        : undefined,

      onNodeFailed: this.errorDetector
        ? async (nodeId: string, error: string) => {
            try {
              this.errorDetector!.recordError({
                source: 'pipeline_stuck',
                message: error,
                nodeId,
              })
            } catch {
              // best-effort
            }
          }
        : undefined,
    })

    // (f) Create ObservabilityCorrectionBridge
    if (isEnabled && learningConfig.enableObservability !== false) {
      this._observabilityBridge = new ObservabilityCorrectionBridge()
    }

    // (g) Create PostRunAnalyzer
    if (isEnabled && learningConfig.enablePostRunAnalysis !== false) {
      this.postRunAnalyzer = new PostRunAnalyzer({
        store: learningConfig.store,
        namespace: [...ns, 'post_run'],
      })
    }

    // (h) Wire event handler — chain with existing onEvent if present
    const existingOnEvent = pipelineConfig.onEvent
    const hookHandler = this.hook.createEventHandler()

    const chainedOnEvent = (event: PipelineRuntimeEvent): void => {
      // Always call existing handler first
      if (existingOnEvent) {
        try {
          existingOnEvent(event)
        } catch {
          // best-effort
        }
      }
      // Then call self-learning handler
      try {
        hookHandler(event)
      } catch {
        // best-effort
      }
    }

    // (i) Build the enhanced pipeline config and create PipelineRuntime
    const enhancedConfig: PipelineRuntimeConfig = {
      ...pipelineConfig,
      stuckDetector,
      onEvent: chainedOnEvent,
    }

    this.pipelineRuntime = new PipelineRuntime(enhancedConfig)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Execute the pipeline with self-learning. Same API as PipelineRuntime.execute() */
  async execute(initialState?: Record<string, unknown>): Promise<SelfLearningRunResult> {
    this.hook.reset()

    const baseResult = await this.pipelineRuntime.execute(initialState)

    return this.enrichResult(baseResult)
  }

  /** Resume a suspended pipeline */
  async resume(checkpoint: PipelineCheckpoint, additionalState?: Record<string, unknown>): Promise<SelfLearningRunResult> {
    const baseResult = await this.pipelineRuntime.resume(checkpoint, additionalState)

    return this.enrichResult(baseResult)
  }

  /** Cancel the pipeline */
  cancel(reason?: string): void {
    this.pipelineRuntime.cancel(reason)
  }

  /** Get the current pipeline state */
  getRunState(): PipelineState {
    return this.pipelineRuntime.getRunState()
  }

  /** Get accumulated learning metrics */
  getLearningMetrics(): {
    enrichmentsApplied: number
    stuckDetections: number
    recoveriesAttempted: number
    recoveriesSucceeded: number
  } {
    const m = this.hook.getMetrics()
    return {
      enrichmentsApplied: m.enrichmentsApplied,
      stuckDetections: m.stuckDetections,
      recoveriesAttempted: m.recoveriesAttempted,
      recoveriesSucceeded: m.recoveriesSucceeded,
    }
  }

  /** Get the underlying PipelineRuntime (for advanced use) */
  get runtime(): PipelineRuntime {
    return this.pipelineRuntime
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * After pipeline completion (success or failure), run post-run analysis
   * and enrich the result with learning data.
   */
  private async enrichResult(baseResult: PipelineRunResult): Promise<SelfLearningRunResult> {
    const metrics = this.hook.getMetrics()

    const result: SelfLearningRunResult = {
      ...baseResult,
      learningMetrics: {
        enrichmentsApplied: metrics.enrichmentsApplied,
        stuckDetections: metrics.stuckDetections,
        recoveriesAttempted: metrics.recoveriesAttempted,
      },
    }

    // Run post-run analysis (best-effort)
    if (this.postRunAnalyzer) {
      try {
        const analysis = await this.runPostRunAnalysis(baseResult, metrics)
        if (analysis) {
          result.analysis = {
            lessonsCreated: analysis.lessonsCreated,
            rulesCreated: analysis.rulesCreated,
            suboptimalNodes: analysis.suboptimalNodes,
            summary: analysis.summary,
          }
          result.trajectoryStored = analysis.trajectoryStored
        }
      } catch {
        // best-effort — analysis failure never crashes the pipeline
      }
    }

    return result
  }

  /**
   * Build a RunAnalysis from the pipeline result and run the PostRunAnalyzer.
   */
  private async runPostRunAnalysis(
    baseResult: PipelineRunResult,
    _metrics: HookMetrics,
  ): Promise<AnalysisResult | undefined> {
    if (!this.postRunAnalyzer) return undefined

    // Build node scores from node results
    const nodeScores = new Map<string, number>()
    const errors: RunAnalysis['errors'] = []

    for (const [nodeId, nodeResult] of baseResult.nodeResults) {
      if (nodeResult.error) {
        nodeScores.set(nodeId, 0)
        errors.push({
          nodeId,
          error: nodeResult.error,
          resolved: false,
        })
      } else {
        nodeScores.set(nodeId, 1.0)
      }
    }

    // Compute overall score
    const scores = [...nodeScores.values()]
    const overallScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0

    const runAnalysis: RunAnalysis = {
      runId: baseResult.runId,
      nodeScores,
      errors,
      overallScore,
      totalCostCents: baseResult.budgetUsed?.costCents ?? 0,
      totalDurationMs: baseResult.totalDurationMs,
      taskType: this.taskType,
      riskClass: this.riskClass,
      approved: baseResult.state === 'completed',
    }

    return this.postRunAnalyzer.analyze(runAnalysis)
  }
}
