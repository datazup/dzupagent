/**
 * SelfLearningPipelineHook — event-driven self-learning pipeline integration.
 *
 * Subscribes to PipelineRuntimeEvents and drives the self-learning loop
 * in real-time by dispatching to user-supplied callbacks. All callbacks
 * are optional and best-effort (errors are caught and never propagated).
 *
 * @module self-correction/self-learning-hook
 */

import type { PipelineRuntimeEvent } from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SelfLearningHookConfig {
  /** Callback to enrich prompt before node execution. Optional. */
  onBeforeNode?: (nodeId: string, nodeType: string) => Promise<string | undefined>
  /** Callback to record node completion metrics. Optional. */
  onNodeCompleted?: (nodeId: string, durationMs: number, output: unknown) => Promise<void>
  /** Callback to record node failure. Optional. */
  onNodeFailed?: (nodeId: string, error: string) => Promise<void>
  /** Callback when pipeline completes. Optional. */
  onPipelineCompleted?: (runId: string, totalDurationMs: number) => Promise<void>
  /** Callback when pipeline fails. Optional. */
  onPipelineFailed?: (runId: string, error: string) => Promise<void>
  /** Callback when stuck is detected. Optional. */
  onStuckDetected?: (nodeId: string, reason: string) => Promise<void>
  /** Callback when recovery is attempted/succeeded/failed. Optional. */
  onRecovery?: (nodeId: string, attempt: number, success: boolean, summary?: string) => Promise<void>
  /** Whether to log events (default: false) */
  enableLogging?: boolean
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface HookMetrics {
  nodesStarted: number
  nodesCompleted: number
  nodesFailed: number
  enrichmentsApplied: number
  stuckDetections: number
  recoveriesAttempted: number
  recoveriesSucceeded: number
  totalDurationMs: number
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export class SelfLearningPipelineHook {
  private readonly config: SelfLearningHookConfig
  private metrics: HookMetrics

  constructor(config: SelfLearningHookConfig) {
    this.config = config
    this.metrics = this.freshMetrics()
  }

  /**
   * Create an event handler function compatible with PipelineRuntimeConfig.onEvent.
   * Returns a function that can be passed directly to the pipeline runtime.
   */
  createEventHandler(): (event: PipelineRuntimeEvent) => void {
    return (event: PipelineRuntimeEvent) => {
      // Fire-and-forget — we intentionally do not await.
      // Errors are caught inside handleEvent.
      void this.handleEvent(event)
    }
  }

  /**
   * Get accumulated metrics for this hook's lifetime.
   */
  getMetrics(): HookMetrics {
    return { ...this.metrics }
  }

  /**
   * Reset metrics.
   */
  reset(): void {
    this.metrics = this.freshMetrics()
  }

  /**
   * Create a pre-configured hook with all self-correction modules wired in.
   * This is a convenience factory that creates the hook with all callbacks.
   */
  static createWithDefaults(config: {
    enricher?: { enrich: (params: { nodeId: string }) => Promise<{ content: string }> }
    onCompleted?: (runId: string) => Promise<void>
  }): SelfLearningPipelineHook {
    const hookConfig: SelfLearningHookConfig = {}

    if (config.enricher) {
      const enricher = config.enricher
      hookConfig.onBeforeNode = async (nodeId: string) => {
        const result = await enricher.enrich({ nodeId })
        return result.content
      }
    }

    if (config.onCompleted) {
      hookConfig.onPipelineCompleted = async (runId: string) => {
        await config.onCompleted!(runId)
      }
    }

    return new SelfLearningPipelineHook(hookConfig)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async handleEvent(event: PipelineRuntimeEvent): Promise<void> {
    if (this.config.enableLogging) {
      this.log(event.type, event)
    }

    try {
      switch (event.type) {
        case 'pipeline:node_started':
          this.metrics.nodesStarted++
          if (this.config.onBeforeNode) {
            const enrichment = await this.config.onBeforeNode(event.nodeId, event.nodeType)
            if (enrichment !== undefined) {
              this.metrics.enrichmentsApplied++
            }
          }
          break

        case 'pipeline:node_completed':
          this.metrics.nodesCompleted++
          if (this.config.onNodeCompleted) {
            await this.config.onNodeCompleted(event.nodeId, event.durationMs, undefined)
          }
          break

        case 'pipeline:node_failed':
          this.metrics.nodesFailed++
          if (this.config.onNodeFailed) {
            await this.config.onNodeFailed(event.nodeId, event.error)
          }
          break

        case 'pipeline:completed':
          this.metrics.totalDurationMs = event.totalDurationMs
          if (this.config.onPipelineCompleted) {
            await this.config.onPipelineCompleted(event.runId, event.totalDurationMs)
          }
          break

        case 'pipeline:failed':
          if (this.config.onPipelineFailed) {
            await this.config.onPipelineFailed(event.runId, event.error)
          }
          break

        case 'pipeline:stuck_detected':
          this.metrics.stuckDetections++
          if (this.config.onStuckDetected) {
            await this.config.onStuckDetected(event.nodeId, event.reason)
          }
          break

        case 'pipeline:recovery_attempted':
          this.metrics.recoveriesAttempted++
          break

        case 'pipeline:recovery_succeeded':
          this.metrics.recoveriesSucceeded++
          if (this.config.onRecovery) {
            await this.config.onRecovery(event.nodeId, event.attempt, true, event.summary)
          }
          break

        case 'pipeline:recovery_failed':
          if (this.config.onRecovery) {
            await this.config.onRecovery(event.nodeId, event.attempt, false, event.error)
          }
          break

        default:
          // Silently ignore unhandled event types (e.g. pipeline:started, pipeline:suspended, etc.)
          break
      }
    } catch {
      // Hook errors must NEVER crash the pipeline — swallow silently.
      // The metrics still reflect the attempted dispatch.
    }
  }

  private log(eventType: string, event: PipelineRuntimeEvent): void {
    const details = JSON.stringify(event)
    console.log(`[SelfLearning] ${eventType}: ${details}`)
  }

  private freshMetrics(): HookMetrics {
    return {
      nodesStarted: 0,
      nodesCompleted: 0,
      nodesFailed: 0,
      enrichmentsApplied: 0,
      stuckDetections: 0,
      recoveriesAttempted: 0,
      recoveriesSucceeded: 0,
      totalDurationMs: 0,
    }
  }
}
