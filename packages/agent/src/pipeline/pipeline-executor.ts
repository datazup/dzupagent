/**
 * Pipeline executor — executes nodes and walks the graph.
 *
 * Owns the per-node execution mechanics extracted out of
 * `PipelineRuntime`: standard node dispatch with retry/recovery,
 * fork/branch fan-out, loop expansion, suspend handling, error edges,
 * stuck-detector / calibrator / iteration-budget instrumentation, and
 * checkpointing after each node. The runtime keeps lifecycle/coordination
 * state and delegates the actual graph walk to this class.
 *
 * The heavier sub-routines (retry/backoff, fork/branch fan-out, loop
 * handling, side-effect bookkeeping, standard-node dispatch) live in the
 * `pipeline-runtime/` subdirectory so this file stays focused on the
 * dispatch flow.
 *
 * @module pipeline/pipeline-executor
 */

import type { PipelineNode, PipelineEdge, PipelineCheckpoint, ForkNode, JoinNode, LoopNode } from '@dzupagent/core/pipeline'
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from './pipeline-runtime-types.js'
import {
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
  checkpointSavedEvent,
} from './pipeline-runtime/runtime-events.js'
import { getNextNodeIds, getErrorTarget, findJoinNode } from './pipeline-runtime/edge-resolution.js'
import { extractErrorCode } from './pipeline-runtime/error-classification.js'
import { createPipelineCheckpoint } from './pipeline-runtime/checkpoint-helpers.js'
import { type BudgetTrackerState } from './pipeline-runtime/iteration-budget-tracker.js'
import { handleFork as handleForkNode } from './pipeline-runtime/fork-branch-executor.js'
import { handleLoop as handleLoopNode } from './pipeline-runtime/loop-node-handler.js'
import { type RecoveryCounter } from './pipeline-runtime/node-side-effects.js'
import {
  dispatchStandardNode,
  type StandardNodeOutcome,
} from './pipeline-runtime/standard-node-dispatch.js'

/**
 * Coordinator hooks the executor uses to read/update lifecycle state on
 * the owning runtime. Keeping these behind an interface lets the runtime
 * own canonical state (`state`, `recoveryAttemptsUsed`, `budgetTracker`)
 * while the executor focuses on graph traversal mechanics.
 */
export interface PipelineExecutorCoordinator {
  /** Get current pipeline lifecycle state. */
  getState(): PipelineState
  /** Mutate current pipeline lifecycle state. */
  setState(next: PipelineState): void
  /** Read current cumulative recovery-attempt counter. */
  getRecoveryAttemptsUsed(): number
  /** Increment and return the new recovery-attempt counter value. */
  incrementRecoveryAttempts(): number
  /** Mutable accounting state for the global iteration budget. */
  getBudgetTracker(): BudgetTrackerState
}

/**
 * Inputs threaded through the executor for a single run. Mirrors the
 * private state previously held inline on `PipelineRuntime`'s
 * `executeFromNode`.
 */
export interface ExecuteFromNodeInput {
  startNodeId: string
  runId: string
  runState: Record<string, unknown>
  nodeResults: Map<string, NodeResult>
  completedNodeIds: string[]
  versionTracker: { version: number }
  startTime: number
}

export class PipelineExecutor {
  private readonly recoveryCounter: RecoveryCounter

  constructor(
    private readonly config: PipelineRuntimeConfig,
    private readonly nodeMap: Map<string, PipelineNode>,
    private readonly outgoingEdges: Map<string, PipelineEdge[]>,
    private readonly errorEdges: Map<string, PipelineEdge[]>,
    private readonly coordinator: PipelineExecutorCoordinator,
  ) {
    this.recoveryCounter = {
      get: () => this.coordinator.getRecoveryAttemptsUsed(),
      increment: () => this.coordinator.incrementRecoveryAttempts(),
    }
  }

  // ---------------------------------------------------------------------------
  // Core execution loop
  // ---------------------------------------------------------------------------

  async executeFromNode(input: ExecuteFromNodeInput): Promise<PipelineRunResult> {
    const { runId, runState, nodeResults, completedNodeIds, versionTracker, startTime } = input
    let currentNodeId: string | undefined = input.startNodeId

    while (currentNodeId) {
      // Check cancellation
      if (this.coordinator.getState() === 'cancelled' || this.config.signal?.aborted) {
        this.coordinator.setState('cancelled')
        return this.runResult(runId, 'cancelled', nodeResults, Date.now() - startTime)
      }

      const node = this.nodeMap.get(currentNodeId)
      if (!node) throw new Error(`Node "${currentNodeId}" not found in pipeline`)

      // Skip already-completed nodes (for resume)
      if (completedNodeIds.includes(currentNodeId)) {
        currentNodeId = this.next(currentNodeId, runState)
        continue
      }

      // Suspend / approval-gate: yield control with a checkpoint
      if (node.type === 'suspend' || (node.type === 'gate' && node.gateType === 'approval')) {
        return this.handleSuspend(node.id, runId, runState, nodeResults, completedNodeIds, versionTracker, startTime)
      }

      // Fork: execute branches in parallel, then continue from join
      if (node.type === 'fork') {
        await handleForkNode(this.forkDeps(), node as ForkNode, runState, nodeResults, completedNodeIds)
        const joinNode = findJoinNode((node as ForkNode).forkId, this.config.definition.nodes)
        if (joinNode) {
          completedNodeIds.push(joinNode.id)
          await this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker)
          currentNodeId = this.next(joinNode.id, runState)
        } else {
          currentNodeId = undefined
        }
        continue
      }

      // Loop: delegate to loop handler, then route success/error
      if (node.type === 'loop') {
        const loopOutcome = await this.dispatchLoop(
          node as LoopNode, runId, runState, nodeResults, completedNodeIds, versionTracker, startTime,
        )
        if (loopOutcome.kind === 'return') return loopOutcome.value
        currentNodeId = loopOutcome.nextNodeId
        continue
      }

      // Standard node — full retry/recovery/side-effect dispatch
      const outcome = await this.dispatchNode(node, runId, runState, nodeResults, completedNodeIds, versionTracker, startTime)
      if (outcome.kind === 'return') return outcome.value
      if (outcome.kind === 'rethrow') throw outcome.error
      currentNodeId = outcome.nextNodeId
    }

    // No more nodes — pipeline completed
    const totalMs = Date.now() - startTime
    this.coordinator.setState('completed')
    this.emit(pipelineCompletedEvent(runId, totalMs))
    return this.runResult(runId, 'completed', nodeResults, totalMs)
  }

  // ---------------------------------------------------------------------------
  // Per-node-type dispatch
  // ---------------------------------------------------------------------------

  private dispatchNode(
    node: PipelineNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    versionTracker: { version: number },
    startTime: number,
  ): Promise<StandardNodeOutcome> {
    return dispatchStandardNode({
      config: this.config,
      outgoingEdges: this.outgoingEdges,
      errorEdges: this.errorEdges,
      emit: this.emit.bind(this),
      recoveryCounter: this.recoveryCounter,
      budgetTracker: this.coordinator.getBudgetTracker(),
      setState: (next) => this.coordinator.setState(next),
      pipelineId: this.config.definition.id,
      node,
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      startTime,
      saveCheckpoint: () => this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker),
    })
  }

  private async dispatchLoop(
    loopNode: LoopNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    versionTracker: { version: number },
    startTime: number,
  ): Promise<{ kind: 'continue'; nextNodeId: string | undefined } | { kind: 'return'; value: PipelineRunResult }> {
    const loopResult = await handleLoopNode({
      config: this.config,
      nodeMap: this.nodeMap,
      emit: this.emit.bind(this),
    }, loopNode, runState, nodeResults)

    if (loopResult.error) {
      const errorNext = this.errorEdgeFor(loopNode.id, loopResult.error)
      if (errorNext) {
        nodeResults.set(loopNode.id, loopResult)
        return { kind: 'continue', nextNodeId: errorNext }
      }
      this.coordinator.setState('failed')
      nodeResults.set(loopNode.id, loopResult)
      this.emit(pipelineFailedEvent(runId, loopResult.error))
      return { kind: 'return', value: this.runResult(runId, 'failed', nodeResults, Date.now() - startTime) }
    }
    nodeResults.set(loopNode.id, loopResult)
    completedNodeIds.push(loopNode.id)
    await this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker)
    return { kind: 'continue', nextNodeId: this.next(loopNode.id, runState) }
  }

  // ---------------------------------------------------------------------------
  // Suspend handling
  // ---------------------------------------------------------------------------

  async handleSuspend(
    nodeId: string,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    versionTracker: { version: number },
    startTime: number,
  ): Promise<PipelineRunResult> {
    this.coordinator.setState('suspended')
    this.emit(pipelineSuspendedEvent(nodeId))

    if (this.config.checkpointStore) {
      versionTracker.version++
      const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        completedNodeIds,
        state: runState,
        suspendedAtNodeId: nodeId,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
      })
      await this.config.checkpointStore.save(checkpoint)
      this.emit(checkpointSavedEvent(runId, versionTracker.version))
    }

    return this.runResult(runId, 'suspended', nodeResults, Date.now() - startTime)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Build the dependency bag for fork/branch fan-out. */
  private forkDeps() {
    return {
      config: this.config,
      nodeMap: this.nodeMap,
      outgoingEdges: this.outgoingEdges,
      emit: this.emit.bind(this),
      findJoinNode: (forkId: string): JoinNode | undefined =>
        findJoinNode(forkId, this.config.definition.nodes),
    }
  }

  /** First next-node id for `nodeId`, evaluated against current state. */
  private next(nodeId: string, runState: Record<string, unknown>): string | undefined {
    return getNextNodeIds(nodeId, this.outgoingEdges, this.config.predicates, runState)[0]
  }

  private errorEdgeFor(nodeId: string, error: unknown): string | undefined {
    return getErrorTarget(nodeId, this.errorEdges, extractErrorCode(error))
  }

  private runResult(
    runId: string,
    state: PipelineState,
    nodeResults: Map<string, NodeResult>,
    totalDurationMs: number,
  ): PipelineRunResult {
    return {
      pipelineId: this.config.definition.id,
      runId,
      state,
      nodeResults,
      totalDurationMs,
    }
  }

  private async saveCheckpoint(
    runId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[],
    versionTracker: { version: number },
  ): Promise<void> {
    const strategy = this.config.definition.checkpointStrategy
    if (!this.config.checkpointStore || !strategy || strategy === 'none' || strategy === 'manual') {
      return
    }

    if (strategy === 'after_each_node') {
      versionTracker.version++
      const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        completedNodeIds,
        state: runState,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
      })
      await this.config.checkpointStore.save(checkpoint)
      this.emit(checkpointSavedEvent(runId, versionTracker.version))
    }
  }

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event)
  }
}
