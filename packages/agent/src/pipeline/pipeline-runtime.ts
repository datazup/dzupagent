/**
 * Pipeline runtime — lifecycle coordinator for pipeline execution.
 *
 * Owns the public surface (`execute`, `resume`, `cancel`, `getRunState`),
 * maintains per-run lifecycle state (`state`, recovery counter,
 * iteration-budget tracker), validates the definition once on entry,
 * and auto-wires the checkpoint store. Per-node mechanics — graph walk,
 * fork/branch, loops, retries, recovery, stuck-detector — live in
 * `PipelineExecutor` to keep this file focused on lifecycle concerns.
 *
 * @module pipeline/pipeline-runtime
 */

import type { PipelineNode, PipelineEdge, PipelineCheckpoint } from '@dzupagent/core/pipeline'
import { validatePipeline } from './pipeline-validator.js'
import { InMemoryPipelineCheckpointStore } from './in-memory-checkpoint-store.js'
import { PostgresPipelineCheckpointStore } from './postgres-checkpoint-store.js'
import { RedisPipelineCheckpointStore } from './redis-checkpoint-store.js'
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from './pipeline-runtime-types.js'
import { generateRunId } from './pipeline-runtime/run-id.js'
import {
  pipelineStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
} from './pipeline-runtime/runtime-events.js'
import { getNextNodeIds } from './pipeline-runtime/edge-resolution.js'
import {
  createBudgetTrackerState,
  type BudgetTrackerState,
} from './pipeline-runtime/iteration-budget-tracker.js'
import {
  PipelineExecutor,
  type PipelineExecutorCoordinator,
} from './pipeline-executor.js'

// ---------------------------------------------------------------------------
// Pipeline Runtime
// ---------------------------------------------------------------------------

export class PipelineRuntime {
  private readonly config: PipelineRuntimeConfig
  private readonly nodeMap: Map<string, PipelineNode>
  private readonly outgoingEdges: Map<string, PipelineEdge[]>
  private readonly errorEdges: Map<string, PipelineEdge[]>
  private state: PipelineState = 'idle'
  /** Tracks recovery attempts across the entire pipeline run */
  private recoveryAttemptsUsed = 0
  /**
   * Iteration budget accounting state. Cumulative cost and warning flags
   * are kept on a single object so the standalone tracker helper can
   * mutate them in place, preserving the existing field semantics while
   * making the threshold rules independently testable.
   */
  private budgetTracker: BudgetTrackerState = createBudgetTrackerState()
  private readonly executor: PipelineExecutor

  constructor(config: PipelineRuntimeConfig) {
    // Auto-wire checkpoint store when not explicitly provided.
    if (!config.checkpointStore) {
      if (config.redisClient) {
        config = { ...config, checkpointStore: new RedisPipelineCheckpointStore({ client: config.redisClient }) }
      } else if (config.pgClient) {
        config = { ...config, checkpointStore: new PostgresPipelineCheckpointStore({ client: config.pgClient }) }
      } else {
        config = { ...config, checkpointStore: new InMemoryPipelineCheckpointStore() }
      }
    }
    this.config = config
    this.nodeMap = new Map()
    this.outgoingEdges = new Map()
    this.errorEdges = new Map()

    for (const node of config.definition.nodes) {
      this.nodeMap.set(node.id, node)
      this.outgoingEdges.set(node.id, [])
      this.errorEdges.set(node.id, [])
    }

    for (const edge of config.definition.edges) {
      if (edge.type === 'error') {
        this.errorEdges.get(edge.sourceNodeId)?.push(edge)
      } else {
        this.outgoingEdges.get(edge.sourceNodeId)?.push(edge)
      }
    }

    const coordinator: PipelineExecutorCoordinator = {
      getState: () => this.state,
      setState: (next) => { this.state = next },
      getRecoveryAttemptsUsed: () => this.recoveryAttemptsUsed,
      incrementRecoveryAttempts: () => ++this.recoveryAttemptsUsed,
      getBudgetTracker: () => this.budgetTracker,
    }
    this.executor = new PipelineExecutor(
      this.config,
      this.nodeMap,
      this.outgoingEdges,
      this.errorEdges,
      coordinator,
    )
  }

  /** Execute the pipeline from the entry node. */
  async execute(initialState?: Record<string, unknown>): Promise<PipelineRunResult> {
    // Validate first
    const validation = validatePipeline(this.config.definition)
    if (!validation.valid) {
      const messages = validation.errors.map(e => e.message).join('; ')
      throw new Error(`Pipeline validation failed: ${messages}`)
    }

    const runId = generateRunId()
    const runState: Record<string, unknown> = { ...initialState }
    const nodeResults = new Map<string, NodeResult>()
    const completedNodeIds: string[] = []
    const versionTracker = { version: 0 }

    this.state = 'running'
    this.recoveryAttemptsUsed = 0
    this.budgetTracker = createBudgetTrackerState()
    this.emit(pipelineStartedEvent(this.config.definition.id, runId))

    const startTime = Date.now()

    return this.runFromNode({
      startNodeId: this.config.definition.entryNodeId,
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      versionTracker,
      startTime,
    })
  }

  /** Resume execution from a checkpoint. */
  async resume(
    checkpoint: PipelineCheckpoint,
    additionalState?: Record<string, unknown>,
  ): Promise<PipelineRunResult> {
    const runId = checkpoint.pipelineRunId
    const runState: Record<string, unknown> = { ...checkpoint.state, ...additionalState }
    const nodeResults = new Map<string, NodeResult>()
    const completedNodeIds = [...checkpoint.completedNodeIds]

    // Mark completed nodes in results (with placeholder results)
    for (const nodeId of completedNodeIds) {
      nodeResults.set(nodeId, {
        nodeId,
        output: null,
        durationMs: 0,
      })
    }

    this.state = 'running'
    // Restore recovery budget so limits are enforced across process restarts
    this.recoveryAttemptsUsed = checkpoint.recoveryAttemptsUsed ?? 0
    this.emit(pipelineStartedEvent(this.config.definition.id, runId))

    const startTime = Date.now()

    if (!checkpoint.suspendedAtNodeId) {
      // No suspension point — nothing to resume
      this.state = 'completed'
      this.emit(pipelineCompletedEvent(runId, 0))
      return {
        pipelineId: this.config.definition.id,
        runId,
        state: 'completed',
        nodeResults,
        totalDurationMs: 0,
      }
    }

    // Find the node after the suspend point
    const suspendedNode = this.nodeMap.get(checkpoint.suspendedAtNodeId)
    if (!suspendedNode) {
      throw new Error(`Suspended node "${checkpoint.suspendedAtNodeId}" not found`)
    }

    // Get next node(s) after the suspended node
    const nextNodeIds = this.getNextNodeIdsForResume(checkpoint.suspendedAtNodeId, runState)

    if (nextNodeIds.length === 0) {
      // Suspend was terminal
      this.state = 'completed'
      const totalMs = Date.now() - startTime
      this.emit(pipelineCompletedEvent(runId, totalMs))
      return {
        pipelineId: this.config.definition.id,
        runId,
        state: 'completed',
        nodeResults,
        totalDurationMs: totalMs,
      }
    }

    const versionTracker = { version: checkpoint.version }

    // Continue from the first next node — `runFromNode` translates any
    // executor-thrown error into a failed run result, matching the
    // original outer try/catch semantics.
    return this.runFromNode({
      startNodeId: nextNodeIds[0]!,
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      versionTracker,
      startTime,
    })
  }

  /** Cancel execution. */
  cancel(_reason?: string): void {
    this.state = 'cancelled'
  }

  /** Get current run state. */
  getRunState(): PipelineState {
    return this.state
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Shared tail for `execute()` and `resume()`: delegate the graph walk to
   * the executor and translate any thrown error into a failed run result.
   * Centralising this preserves identical lifecycle semantics across both
   * entry points (state transition to `failed`, `pipeline:failed` event,
   * structured `PipelineRunResult`) without duplicating the catch block.
   */
  private async runFromNode(args: {
    startNodeId: string
    runId: string
    runState: Record<string, unknown>
    nodeResults: Map<string, NodeResult>
    completedNodeIds: string[]
    versionTracker: { version: number }
    startTime: number
  }): Promise<PipelineRunResult> {
    try {
      return await this.executor.executeFromNode(args)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.state = 'failed'
      this.emit(pipelineFailedEvent(args.runId, errorMessage))
      return {
        pipelineId: this.config.definition.id,
        runId: args.runId,
        state: 'failed',
        nodeResults: args.nodeResults,
        totalDurationMs: Date.now() - args.startTime,
      }
    }
  }

  /**
   * Resolve the node(s) immediately after a suspension point. Used by
   * `resume()` to determine where execution should continue without
   * re-running the executor's full traversal loop. Mirrors the
   * traversal-time edge resolution exactly so resume behaviour is
   * indistinguishable from a fresh `execute()` call.
   */
  private getNextNodeIdsForResume(nodeId: string, runState: Record<string, unknown>): string[] {
    return getNextNodeIds(nodeId, this.outgoingEdges, this.config.predicates, runState)
  }

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event)
  }
}
