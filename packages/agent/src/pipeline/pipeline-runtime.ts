/**
 * Pipeline runtime — executes a validated PipelineDefinition by walking
 * the node graph, calling the user-supplied nodeExecutor for each node,
 * handling forks, joins, loops, gates, suspensions, checkpoints, and errors.
 *
 * @module pipeline/pipeline-runtime
 */

import type {
  PipelineNode,
  PipelineEdge,
  PipelineCheckpoint,
  ForkNode,
  JoinNode,
  LoopNode,
} from '@dzupagent/core'
import { validatePipeline } from './pipeline-validator.js'
import { InMemoryPipelineCheckpointStore } from './in-memory-checkpoint-store.js'
import { PostgresPipelineCheckpointStore } from './postgres-checkpoint-store.js'
import { RedisPipelineCheckpointStore } from './redis-checkpoint-store.js'
import { executeLoop } from './loop-executor.js'
import type { FailureContext, FailureType } from '../recovery/recovery-types.js'
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  RetryPolicy,
} from './pipeline-runtime-types.js'
import {
  calculateBackoff,
  isRetryable as isRetryableError,
  resolveRetryPolicy,
} from './retry-policy.js'
import { generateRunId } from './pipeline-runtime/run-id.js'
import {
  pipelineStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
  checkpointSavedEvent,
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
  nodeRetryEvent,
  recoveryAttemptedEvent,
  recoverySucceededEvent,
  recoveryFailedEvent,
  stuckDetectedEvent,
  nodeOutputRecordedEvent,
  calibrationSuboptimalEvent,
  iterationBudgetWarningEvent,
} from './pipeline-runtime/runtime-events.js'
import {
  getNextNodeIds,
  getErrorTarget,
  findJoinNode,
  getForkBranchStartIds,
} from './pipeline-runtime/edge-resolution.js'
import { createPipelineCheckpoint } from './pipeline-runtime/checkpoint-helpers.js'
import {
  collectStateDelta,
  mergeBranchExecutionResult,
  type BranchExecutionResult,
} from './pipeline-runtime/branch-merge.js'

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
  /** Cumulative cost tracked for iteration budget (cents) */
  private cumulativeCostCents = 0
  /** Whether budget warnings have already been emitted at each threshold */
  private budgetWarnings = { warn70: false, warn90: false }

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
    let checkpointVersion = 0

    this.state = 'running'
    this.recoveryAttemptsUsed = 0
    this.cumulativeCostCents = 0
    this.budgetWarnings = { warn70: false, warn90: false }
    this.emit(pipelineStartedEvent(this.config.definition.id, runId))

    const startTime = Date.now()

    try {
      const result = await this.executeFromNode(
        this.config.definition.entryNodeId,
        runId,
        runState,
        nodeResults,
        completedNodeIds,
        { version: checkpointVersion },
      )
      return result
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.state = 'failed'
      this.emit(pipelineFailedEvent(runId, errorMessage))
      return {
        pipelineId: this.config.definition.id,
        runId,
        state: 'failed',
        nodeResults,
        totalDurationMs: Date.now() - startTime,
      }
    }
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
    const nextNodeIds = this.getNextNodeIds(checkpoint.suspendedAtNodeId, runState)

    try {
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

      // Continue from the first next node
      const result = await this.executeFromNode(
        nextNodeIds[0]!,
        runId,
        runState,
        nodeResults,
        completedNodeIds,
        { version: checkpoint.version },
      )
      return result
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.state = 'failed'
      this.emit(pipelineFailedEvent(runId, errorMessage))
      return {
        pipelineId: this.config.definition.id,
        runId,
        state: 'failed',
        nodeResults,
        totalDurationMs: Date.now() - startTime,
      }
    }
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
  // Private: Core execution loop
  // ---------------------------------------------------------------------------

  private async executeFromNode(
    startNodeId: string,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    versionTracker: { version: number },
  ): Promise<PipelineRunResult> {
    const startTime = Date.now()
    let currentNodeId: string | undefined = startNodeId

    while (currentNodeId) {
      // Check cancellation
      if (this.state === 'cancelled' || this.config.signal?.aborted) {
        this.state = 'cancelled'
        return {
          pipelineId: this.config.definition.id,
          runId,
          state: 'cancelled',
          nodeResults,
          totalDurationMs: Date.now() - startTime,
        }
      }

      const node = this.nodeMap.get(currentNodeId)
      if (!node) {
        throw new Error(`Node "${currentNodeId}" not found in pipeline`)
      }

      // Skip already-completed nodes (for resume)
      if (completedNodeIds.includes(currentNodeId)) {
        const nextIds = this.getNextNodeIds(currentNodeId, runState)
        currentNodeId = nextIds[0]
        continue
      }

      // Handle special node types
      if (node.type === 'suspend') {
        return this.handleSuspend(node.id, runId, runState, nodeResults, completedNodeIds, versionTracker, startTime)
      }

      if (node.type === 'gate' && node.gateType === 'approval') {
        return this.handleSuspend(node.id, runId, runState, nodeResults, completedNodeIds, versionTracker, startTime)
      }

      if (node.type === 'fork') {
        const forkResult = await this.handleFork(
          node as ForkNode,
          runId,
          runState,
          nodeResults,
          completedNodeIds,
          versionTracker,
        )
        if (forkResult) return forkResult
        // After fork+join, find next from join node
        const joinNode = findJoinNode((node as ForkNode).forkId, this.config.definition.nodes)
        if (joinNode) {
          completedNodeIds.push(joinNode.id)
          await this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker)
          const nextIds = this.getNextNodeIds(joinNode.id, runState)
          currentNodeId = nextIds[0]
        } else {
          currentNodeId = undefined
        }
        continue
      }

      if (node.type === 'loop') {
        const loopResult = await this.handleLoop(
          node as LoopNode,
          runId,
          runState,
          nodeResults,
          completedNodeIds,
          versionTracker,
        )
        if (loopResult.error) {
          // Try error edges
          const errorNext = this.getErrorTarget(currentNodeId, loopResult.error)
          if (errorNext) {
            nodeResults.set(currentNodeId, loopResult)
            currentNodeId = errorNext
            continue
          }
          this.state = 'failed'
          nodeResults.set(currentNodeId, loopResult)
          this.emit(pipelineFailedEvent(runId, loopResult.error))
          return {
            pipelineId: this.config.definition.id,
            runId,
            state: 'failed',
            nodeResults,
            totalDurationMs: Date.now() - startTime,
          }
        }
        nodeResults.set(currentNodeId, loopResult)
        completedNodeIds.push(currentNodeId)
        await this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker)
        const nextIds = this.getNextNodeIds(currentNodeId, runState)
        currentNodeId = nextIds[0]
        continue
      }

      // Standard node execution (with retry support)
      this.emit(nodeStartedEvent(node.id, node.type))

      // Start OTel span for this node (no-op when tracer not configured)
      const span = this.config.tracer?.startPhaseSpan(node.id, {
        attributes: {
          'forge.pipeline.node_type': node.type,
          'forge.pipeline.phase': node.id,
        },
      })

      const context: NodeExecutionContext = {
        state: runState,
        previousResults: nodeResults,
        signal: this.config.signal,
      }

      try {
        const maxAttempts = (node.retries ?? 0) + 1 // retries=0 means 1 attempt (no retry)
        const effectivePolicy = resolveRetryPolicy(
          node.retryPolicy as RetryPolicy | undefined,
          this.config.retryPolicy,
        )
        let result: NodeResult | undefined
        const nodeStartTime = Date.now()

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          result = await this.config.nodeExecutor(node.id, node, context)

          if (!result.error) break // success

          // Last attempt — don't retry
          if (attempt === maxAttempts) break

          // Check if error is retryable
          if (!isRetryableError(result.error, effectivePolicy)) break

          // Calculate backoff (with optional jitter)
          const backoffMs = calculateBackoff(attempt, effectivePolicy)

          // Emit retry event
          this.emit(nodeRetryEvent(node.id, attempt, maxAttempts, result.error, backoffMs))

          // Wait with abort support
          await this.delay(backoffMs)

          // Check abort after delay
          if (this.config.signal?.aborted) {
            result = {
              nodeId: node.id,
              output: undefined,
              durationMs: Date.now() - nodeStartTime,
              error: 'Pipeline cancelled during retry backoff',
            }
            break
          }
        }

        // Accumulate total duration across retries
        const finalResult: NodeResult = {
          ...result!,
          durationMs: Date.now() - nodeStartTime,
        }

        if (finalResult.error) {
          // End span with error before continuing
          if (span) this.config.tracer?.endSpanWithError(span, finalResult.error)

          this.emit(nodeFailedEvent(node.id, finalResult.error))
          nodeResults.set(node.id, finalResult)

          // Record failure in stuck detector (if configured)
          if (this.config.stuckDetector) {
            const stuckStatus = this.config.stuckDetector.recordNodeFailure(node.id, finalResult.error)
            if (stuckStatus.stuck) {
              this.emit(
                stuckDetectedEvent(
                  stuckStatus.nodeId ?? node.id,
                  stuckStatus.reason ?? 'Unknown',
                  stuckStatus.suggestedAction ?? 'abort',
                ),
              )

              if (stuckStatus.suggestedAction === 'abort') {
                // Stuck detector says abort — skip recovery and fail immediately
                this.state = 'failed'
                const abortError = `Pipeline stuck: ${stuckStatus.reason}`
                this.emit(pipelineFailedEvent(runId, abortError))
                return {
                  pipelineId: this.config.definition.id,
                  runId,
                  state: 'failed',
                  nodeResults,
                  totalDurationMs: Date.now() - startTime,
                }
              }

              if (stuckStatus.suggestedAction === 'switch_strategy') {
                // Add hint to context so next execution attempt can adapt
                context.stuckHint = stuckStatus.reason
              }
            }
          }

          // Check for error edges
          const errorNext = this.getErrorTarget(node.id, finalResult.error)
          if (errorNext) {
            currentNodeId = errorNext
            continue
          }

          // Attempt recovery before failing pipeline
          const recovered = await this.attemptRecovery(
            node.id, node.type, finalResult.error, runId, context,
          )
          if (recovered) {
            // Recovery succeeded — retry the same node
            nodeResults.delete(node.id)
            continue
          }

          // No error handler, no recovery — fail pipeline
          this.state = 'failed'
          this.emit(pipelineFailedEvent(runId, finalResult.error))
          return {
            pipelineId: this.config.definition.id,
            runId,
            state: 'failed',
            nodeResults,
            totalDurationMs: Date.now() - startTime,
          }
        }

        // End span with OK status
        if (span) this.config.tracer?.endSpanOk(span)

        this.emit(nodeCompletedEvent(node.id, finalResult.durationMs))
        nodeResults.set(node.id, finalResult)

        // Record successful output in stuck detector (if configured)
        if (this.config.stuckDetector) {
          const outputStr = JSON.stringify(finalResult.output) ?? ''
          const stuckStatus = this.config.stuckDetector.recordNodeOutput(node.id, outputStr)
          this.emit(nodeOutputRecordedEvent(node.id, outputStr.slice(0, 32)))

          if (stuckStatus.stuck) {
            this.emit(
              stuckDetectedEvent(
                stuckStatus.nodeId ?? node.id,
                stuckStatus.reason ?? 'Unknown',
                stuckStatus.suggestedAction ?? 'switch_strategy',
              ),
            )

            if (stuckStatus.suggestedAction === 'abort') {
              this.state = 'failed'
              const abortError = `Pipeline stuck: ${stuckStatus.reason}`
              this.emit(pipelineFailedEvent(runId, abortError))
              return {
                pipelineId: this.config.definition.id,
                runId,
                state: 'failed',
                nodeResults,
                totalDurationMs: Date.now() - startTime,
              }
            }

            if (stuckStatus.suggestedAction === 'switch_strategy') {
              context.stuckHint = stuckStatus.reason
            }
          }
        }

        // Trajectory calibration: compare step quality against historical baseline
        if (this.config.trajectoryCalibrator) {
          const tc = this.config.trajectoryCalibrator
          const quality = tc.extractQuality(node.id, finalResult)
          if (quality !== undefined) {
            try {
              // Record step quality for future baseline computation
              await tc.calibrator.recordStep({
                nodeId: node.id,
                runId,
                qualityScore: quality,
                durationMs: finalResult.durationMs,
                tokenCost: 0,
                errorCount: 0,
                timestamp: new Date(),
              })

              // Check against baseline
              const suboptimal = await tc.calibrator.detectSuboptimal(
                node.id, quality, tc.taskType,
              )
              if (suboptimal.isSuboptimal) {
                this.emit(
                  calibrationSuboptimalEvent(
                    node.id,
                    suboptimal.baseline,
                    suboptimal.currentScore,
                    suboptimal.deviation,
                    suboptimal.suggestion ?? `Node "${node.id}" quality below baseline`,
                  ),
                )
              }
            } catch {
              // Calibration is non-fatal
            }
          }
        }

        // Iteration budget tracking: accumulate cost and emit warnings
        if (this.config.iterationBudget) {
          const ib = this.config.iterationBudget
          const cost = ib.extractCost(node.id, finalResult)
          if (cost > 0) {
            this.cumulativeCostCents += cost
            const pct = this.cumulativeCostCents / ib.maxCostCents

            if (pct >= 0.9 && !this.budgetWarnings.warn90) {
              this.budgetWarnings.warn90 = true
              this.emit(
                iterationBudgetWarningEvent(
                  'warn_90',
                  this.cumulativeCostCents,
                  ib.maxCostCents,
                  completedNodeIds.length,
                ),
              )
            } else if (pct >= 0.7 && !this.budgetWarnings.warn70) {
              this.budgetWarnings.warn70 = true
              this.emit(
                iterationBudgetWarningEvent(
                  'warn_70',
                  this.cumulativeCostCents,
                  ib.maxCostCents,
                  completedNodeIds.length,
                ),
              )
            }
          }
        }

        completedNodeIds.push(node.id)

        await this.saveCheckpoint(runId, runState, completedNodeIds, versionTracker)

        // Determine next node
        const nextIds = this.getNextNodeIds(node.id, runState)
        currentNodeId = nextIds[0]
      } catch (err) {
        // End span with error on unexpected exception
        if (span) this.config.tracer?.endSpanWithError(span, err)

        const errorMessage = err instanceof Error ? err.message : String(err)
        this.emit(nodeFailedEvent(node.id, errorMessage))
        nodeResults.set(node.id, {
          nodeId: node.id,
          output: null,
          durationMs: 0,
          error: errorMessage,
        })

        const errorNext = this.getErrorTarget(node.id, err)
        if (errorNext) {
          currentNodeId = errorNext
          continue
        }

        // Attempt recovery before throwing
        const recovered = await this.attemptRecovery(
          node.id, node.type, errorMessage, runId, context,
        )
        if (recovered) {
          // Recovery succeeded — retry the same node
          nodeResults.delete(node.id)
          continue
        }

        throw err
      }
    }

    // No more nodes — pipeline completed
    const totalMs = Date.now() - startTime
    this.state = 'completed'
    this.emit(pipelineCompletedEvent(runId, totalMs))
    return {
      pipelineId: this.config.definition.id,
      runId,
      state: 'completed',
      nodeResults,
      totalDurationMs: totalMs,
    }
  }

  // ---------------------------------------------------------------------------
  // Suspend handling
  // ---------------------------------------------------------------------------

  private async handleSuspend(
    nodeId: string,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    versionTracker: { version: number },
    startTime: number,
  ): Promise<PipelineRunResult> {
    this.state = 'suspended'
    this.emit(pipelineSuspendedEvent(nodeId))

    // Save checkpoint at suspension point
    if (this.config.checkpointStore) {
      versionTracker.version++
      const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        completedNodeIds,
        state: runState,
        suspendedAtNodeId: nodeId,
      })
      await this.config.checkpointStore.save(checkpoint)
      this.emit(checkpointSavedEvent(runId, versionTracker.version))
    }

    return {
      pipelineId: this.config.definition.id,
      runId,
      state: 'suspended',
      nodeResults,
      totalDurationMs: Date.now() - startTime,
    }
  }

  // ---------------------------------------------------------------------------
  // Fork/Join handling
  // ---------------------------------------------------------------------------

  private async handleFork(
    forkNode: ForkNode,
    _runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    _versionTracker: { version: number },
  ): Promise<PipelineRunResult | undefined> {
    this.emit(nodeStartedEvent(forkNode.id, 'fork'))
    completedNodeIds.push(forkNode.id)

    // Get all outgoing targets from fork node
    const outgoing = this.outgoingEdges.get(forkNode.id) ?? []
    const branchStartIds = getForkBranchStartIds(outgoing)

    const joinNode = this.findJoinNode(forkNode.forkId)
    const branchBaseState = structuredClone(runState)
    const branchBaseResults = new Map(nodeResults)

    // Start a parent span for the fork group
    const forkSpan = this.config.tracer?.startPhaseSpan(`fork:${forkNode.forkId}`, {
      attributes: {
        'forge.pipeline.node_type': 'fork',
        'forge.pipeline.phase': forkNode.id,
      },
    })

    // Execute branches in parallel — each branch gets its own span
    const branchPromises = branchStartIds.map(async (startId) => {
      const branchSpan = this.config.tracer?.startPhaseSpan(`branch:${startId}`, {
        attributes: {
          'forge.pipeline.node_type': 'branch',
          'forge.pipeline.phase': startId,
        },
      })
      try {
        const result = await this.executeBranch(startId, joinNode?.id, branchBaseState, branchBaseResults)
        if (branchSpan) this.config.tracer?.endSpanOk(branchSpan)
        return result
      } catch (err) {
        if (branchSpan) this.config.tracer?.endSpanWithError(branchSpan, err)
        throw err
      }
    })

    const settled = await Promise.allSettled(branchPromises)

    // Merge branch outputs deterministically in outgoing edge order.
    // Failed branches emit an error event but do not abort surviving branches.
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      if (outcome.status === 'fulfilled') {
        const br = outcome.value
        mergeBranchExecutionResult(nodeResults, completedNodeIds, runState, br)
      } else {
        const branchStartId = branchStartIds[i]!
        const errorMessage = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        this.emit(nodeFailedEvent(branchStartId, errorMessage))
      }
    }

    // End fork parent span
    if (forkSpan) this.config.tracer?.endSpanOk(forkSpan)

    this.emit(nodeCompletedEvent(forkNode.id, 0))

    return undefined // Continue normal flow
  }

  private async executeBranch(
    startNodeId: string,
    joinNodeId: string | undefined,
    baseRunState: Record<string, unknown>,
    baseNodeResults: Map<string, NodeResult>,
  ): Promise<BranchExecutionResult> {
    let currentId: string | undefined = startNodeId
    const runState = structuredClone(baseRunState)
    const baselineState = structuredClone(baseRunState)
    const nodeResults = new Map(baseNodeResults)
    const branchNodeResults = new Map<string, NodeResult>()
    const completedNodeIds: string[] = []

    while (currentId && currentId !== joinNodeId) {
      const node = this.nodeMap.get(currentId)
      if (!node) break

      this.emit(nodeStartedEvent(node.id, node.type))

      const context: NodeExecutionContext = {
        state: runState,
        previousResults: nodeResults,
        signal: this.config.signal,
      }

      const result = await this.config.nodeExecutor(node.id, node, context)
      nodeResults.set(node.id, result)
      branchNodeResults.set(node.id, result)
      completedNodeIds.push(node.id)

      if (result.error) {
        this.emit(nodeFailedEvent(node.id, result.error))
        break
      }

      this.emit(nodeCompletedEvent(node.id, result.durationMs))

      const nextIds = this.getNextNodeIds(node.id, runState)
      currentId = nextIds[0]
    }

    const stateDelta = collectStateDelta(baselineState, runState)

    return {
      state: 'completed',
      stateDelta,
      nodeResults: branchNodeResults,
      completedNodeIds,
    }
  }

  // ---------------------------------------------------------------------------
  // Loop handling
  // ---------------------------------------------------------------------------

  private async handleLoop(
    loopNode: LoopNode,
    _runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    _completedNodeIds: string[],
    _versionTracker: { version: number },
  ): Promise<NodeResult> {
    this.emit(nodeStartedEvent(loopNode.id, 'loop'))

    // Start OTel span for the loop node
    const loopSpan = this.config.tracer?.startPhaseSpan(loopNode.id, {
      attributes: {
        'forge.pipeline.node_type': 'loop',
        'forge.pipeline.phase': loopNode.id,
      },
    })

    const bodyNodes: PipelineNode[] = []
    for (const bodyId of loopNode.bodyNodeIds) {
      const bodyNode = this.nodeMap.get(bodyId)
      if (!bodyNode) {
        const errorResult: NodeResult = {
          nodeId: loopNode.id,
          output: null,
          durationMs: 0,
          error: `Loop body node "${bodyId}" not found`,
        }
        if (loopSpan) this.config.tracer?.endSpanWithError(loopSpan, errorResult.error)
        return errorResult
      }
      bodyNodes.push(bodyNode)
    }

    const context: NodeExecutionContext = {
      state: runState,
      previousResults: nodeResults,
      signal: this.config.signal,
    }

    const predicates = this.config.predicates ?? {}

    const { result, metrics } = await executeLoop(
      loopNode,
      bodyNodes,
      this.config.nodeExecutor,
      context,
      predicates,
      this.config.onEvent,
    )

    if (result.error) {
      if (loopSpan) this.config.tracer?.endSpanWithError(loopSpan, result.error)
      this.emit(nodeFailedEvent(loopNode.id, result.error))
    } else {
      if (loopSpan) this.config.tracer?.endSpanOk(loopSpan)
      this.emit(nodeCompletedEvent(loopNode.id, result.durationMs))
    }

    // Attach metrics to output
    const output = { loopOutput: result.output, metrics }

    return { ...result, output }
  }

  // ---------------------------------------------------------------------------
  // Edge resolution
  // ---------------------------------------------------------------------------

  private getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[] {
    return getNextNodeIds(nodeId, this.outgoingEdges, this.config.predicates, runState)
  }

  private getErrorTarget(nodeId: string, error?: unknown): string | undefined {
    return getErrorTarget(nodeId, this.errorEdges, this.extractErrorCode(error))
  }

  private extractErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code.length > 0) {
        return code
      }
    }

    if (typeof error !== 'string') {
      if (error instanceof Error) {
        return this.extractErrorCodeFromMessage(error.message)
      }
      if (error !== undefined && error !== null) {
        return this.extractErrorCodeFromMessage(String(error))
      }
      return undefined
    }

    return this.extractErrorCodeFromMessage(error)
  }

  private extractErrorCodeFromMessage(message: string): string | undefined {
    const bracketedCode = message.match(/^\[([A-Z][A-Z0-9_]{2,})\]\s*/)
    if (bracketedCode?.[1]) return bracketedCode[1]

    const prefixedCode = message.match(/^([A-Z][A-Z0-9_]{2,})\s*:/)
    if (prefixedCode?.[1]) return prefixedCode[1]

    const exactCode = message.match(/^([A-Z][A-Z0-9_]{2,})$/)
    if (exactCode?.[1]) return exactCode[1]

    return undefined
  }

  private findJoinNode(forkId: string): JoinNode | undefined {
    return findJoinNode(forkId, this.config.definition.nodes)
  }

  // ---------------------------------------------------------------------------
  // Checkpointing
  // ---------------------------------------------------------------------------

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
      })
      await this.config.checkpointStore.save(checkpoint)
      this.emit(checkpointSavedEvent(runId, versionTracker.version))
    }
  }

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event)
  }

  // ---------------------------------------------------------------------------
  // Recovery copilot integration
  // ---------------------------------------------------------------------------

  /**
   * Check whether the recovery copilot is configured and eligible for
   * the given node, then attempt recovery. Returns `true` if recovery
   * succeeded and the node should be retried.
   */
  private async attemptRecovery(
    nodeId: string,
    nodeType: string,
    errorMessage: string,
    runId: string,
    _context: NodeExecutionContext,
  ): Promise<boolean> {
    const rc = this.config.recoveryCopilot
    if (!rc) return false

    // Check per-node eligibility
    if (rc.enabledForNodes && rc.enabledForNodes.length > 0) {
      if (!rc.enabledForNodes.includes(nodeId)) return false
    }

    // Check global attempt budget
    const maxAttempts = rc.maxRecoveryAttempts ?? 3
    if (this.recoveryAttemptsUsed >= maxAttempts) return false

    this.recoveryAttemptsUsed++

    this.emit(recoveryAttemptedEvent(nodeId, this.recoveryAttemptsUsed, maxAttempts, errorMessage))

    // Build a FailureContext for the copilot
    const failureType = this.classifyError(errorMessage, nodeType)
    const failureContext: FailureContext = {
      type: failureType,
      error: errorMessage,
      runId,
      nodeId,
      timestamp: new Date(),
      previousAttempts: this.recoveryAttemptsUsed - 1,
    }

    try {
      const result = await rc.copilot.recover(failureContext)

      if (result.success) {
        this.emit(recoverySucceededEvent(nodeId, this.recoveryAttemptsUsed, result.summary))
        return true
      }

      this.emit(recoveryFailedEvent(nodeId, this.recoveryAttemptsUsed, result.summary))
      return false
    } catch (recoveryErr) {
      const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
      this.emit(recoveryFailedEvent(nodeId, this.recoveryAttemptsUsed, `Recovery threw: ${msg}`))
      return false
    }
  }

  /**
   * Heuristically classify an error message into a FailureType
   * for the recovery copilot.
   */
  private classifyError(error: string, _nodeType: string): FailureType {
    const lower = error.toLowerCase()
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
      return 'timeout'
    }
    if (lower.includes('memory') || lower.includes('oom') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource')) {
      return 'resource_exhaustion'
    }
    if (lower.includes('build') || lower.includes('compile') || lower.includes('syntax')) {
      return 'build_failure'
    }
    if (lower.includes('test') || lower.includes('assertion') || lower.includes('expect')) {
      return 'test_failure'
    }
    return 'generation_failure'
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (this.config.signal) {
        const onAbort = () => {
          clearTimeout(timer)
          resolve() // resolve, don't reject — let the loop check signal
        }
        this.config.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}
