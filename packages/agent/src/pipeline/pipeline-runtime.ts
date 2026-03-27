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
} from '@forgeagent/core'
import { validatePipeline } from './pipeline-validator.js'
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
    this.emit({ type: 'pipeline:started', pipelineId: this.config.definition.id, runId })

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
      this.emit({ type: 'pipeline:failed', runId, error: errorMessage })
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
    this.emit({ type: 'pipeline:started', pipelineId: this.config.definition.id, runId })

    const startTime = Date.now()

    if (!checkpoint.suspendedAtNodeId) {
      // No suspension point — nothing to resume
      this.state = 'completed'
      this.emit({ type: 'pipeline:completed', runId, totalDurationMs: 0 })
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
        this.emit({ type: 'pipeline:completed', runId, totalDurationMs: totalMs })
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
      this.emit({ type: 'pipeline:failed', runId, error: errorMessage })
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
        const joinNode = this.findJoinNode((node as ForkNode).forkId)
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
          const errorNext = this.getErrorTarget(currentNodeId)
          if (errorNext) {
            nodeResults.set(currentNodeId, loopResult)
            currentNodeId = errorNext
            continue
          }
          this.state = 'failed'
          nodeResults.set(currentNodeId, loopResult)
          this.emit({ type: 'pipeline:failed', runId, error: loopResult.error })
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
      this.emit({ type: 'pipeline:node_started', nodeId: node.id, nodeType: node.type })

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
          this.emit({
            type: 'pipeline:node_retry',
            nodeId: node.id,
            attempt,
            maxAttempts,
            error: result.error,
            backoffMs,
          })

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

          this.emit({ type: 'pipeline:node_failed', nodeId: node.id, error: finalResult.error })
          nodeResults.set(node.id, finalResult)

          // Record failure in stuck detector (if configured)
          if (this.config.stuckDetector) {
            const stuckStatus = this.config.stuckDetector.recordNodeFailure(node.id, finalResult.error)
            if (stuckStatus.stuck) {
              this.emit({
                type: 'pipeline:stuck_detected',
                nodeId: stuckStatus.nodeId ?? node.id,
                reason: stuckStatus.reason ?? 'Unknown',
                suggestedAction: stuckStatus.suggestedAction ?? 'abort',
              })

              if (stuckStatus.suggestedAction === 'abort') {
                // Stuck detector says abort — skip recovery and fail immediately
                this.state = 'failed'
                const abortError = `Pipeline stuck: ${stuckStatus.reason}`
                this.emit({ type: 'pipeline:failed', runId, error: abortError })
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
          const errorNext = this.getErrorTarget(node.id)
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
          this.emit({ type: 'pipeline:failed', runId, error: finalResult.error })
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

        this.emit({ type: 'pipeline:node_completed', nodeId: node.id, durationMs: finalResult.durationMs })
        nodeResults.set(node.id, finalResult)

        // Record successful output in stuck detector (if configured)
        if (this.config.stuckDetector) {
          const outputStr = JSON.stringify(finalResult.output) ?? ''
          const stuckStatus = this.config.stuckDetector.recordNodeOutput(node.id, outputStr)
          this.emit({
            type: 'pipeline:node_output_recorded',
            nodeId: node.id,
            outputHash: outputStr.slice(0, 32),
          })

          if (stuckStatus.stuck) {
            this.emit({
              type: 'pipeline:stuck_detected',
              nodeId: stuckStatus.nodeId ?? node.id,
              reason: stuckStatus.reason ?? 'Unknown',
              suggestedAction: stuckStatus.suggestedAction ?? 'switch_strategy',
            })

            if (stuckStatus.suggestedAction === 'abort') {
              this.state = 'failed'
              const abortError = `Pipeline stuck: ${stuckStatus.reason}`
              this.emit({ type: 'pipeline:failed', runId, error: abortError })
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
                this.emit({
                  type: 'pipeline:calibration_suboptimal',
                  nodeId: node.id,
                  baseline: suboptimal.baseline,
                  currentScore: suboptimal.currentScore,
                  deviation: suboptimal.deviation,
                  suggestion: suboptimal.suggestion ?? `Node "${node.id}" quality below baseline`,
                })
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
              this.emit({
                type: 'pipeline:iteration_budget_warning',
                level: 'warn_90',
                totalCost: this.cumulativeCostCents,
                budgetCents: ib.maxCostCents,
                iteration: completedNodeIds.length,
              })
            } else if (pct >= 0.7 && !this.budgetWarnings.warn70) {
              this.budgetWarnings.warn70 = true
              this.emit({
                type: 'pipeline:iteration_budget_warning',
                level: 'warn_70',
                totalCost: this.cumulativeCostCents,
                budgetCents: ib.maxCostCents,
                iteration: completedNodeIds.length,
              })
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
        this.emit({ type: 'pipeline:node_failed', nodeId: node.id, error: errorMessage })
        nodeResults.set(node.id, {
          nodeId: node.id,
          output: null,
          durationMs: 0,
          error: errorMessage,
        })

        const errorNext = this.getErrorTarget(node.id)
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
    this.emit({ type: 'pipeline:completed', runId, totalDurationMs: totalMs })
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
    this.emit({ type: 'pipeline:suspended', nodeId })

    // Save checkpoint at suspension point
    if (this.config.checkpointStore) {
      versionTracker.version++
      const checkpoint: PipelineCheckpoint = {
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        schemaVersion: '1.0.0',
        completedNodeIds: [...completedNodeIds],
        state: structuredClone(runState),
        suspendedAtNodeId: nodeId,
        createdAt: new Date().toISOString(),
      }
      await this.config.checkpointStore.save(checkpoint)
      this.emit({ type: 'pipeline:checkpoint_saved', runId, version: versionTracker.version })
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
    this.emit({ type: 'pipeline:node_started', nodeId: forkNode.id, nodeType: 'fork' })
    completedNodeIds.push(forkNode.id)

    // Get all outgoing targets from fork node
    const outgoing = this.outgoingEdges.get(forkNode.id) ?? []
    const branchStartIds: string[] = []
    for (const edge of outgoing) {
      if (edge.type === 'sequential') {
        branchStartIds.push(edge.targetNodeId)
      } else if (edge.type === 'conditional') {
        for (const targetId of Object.values(edge.branches)) {
          branchStartIds.push(targetId)
        }
      }
    }

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
        for (const [nodeId, result] of br.nodeResults) {
          nodeResults.set(nodeId, result)
        }
        completedNodeIds.push(...br.completedNodeIds)
        Object.assign(runState, br.stateDelta)
      } else {
        const branchStartId = branchStartIds[i]!
        const errorMessage = outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
        this.emit({
          type: 'pipeline:node_failed',
          nodeId: branchStartId,
          error: errorMessage,
        })
      }
    }

    // End fork parent span
    if (forkSpan) this.config.tracer?.endSpanOk(forkSpan)

    this.emit({ type: 'pipeline:node_completed', nodeId: forkNode.id, durationMs: 0 })

    return undefined // Continue normal flow
  }

  private async executeBranch(
    startNodeId: string,
    joinNodeId: string | undefined,
    baseRunState: Record<string, unknown>,
    baseNodeResults: Map<string, NodeResult>,
  ): Promise<{
      state: 'completed'
      stateDelta: Record<string, unknown>
      nodeResults: Map<string, NodeResult>
      completedNodeIds: string[]
    }> {
    let currentId: string | undefined = startNodeId
    const runState = structuredClone(baseRunState)
    const baselineState = structuredClone(baseRunState)
    const nodeResults = new Map(baseNodeResults)
    const branchNodeResults = new Map<string, NodeResult>()
    const completedNodeIds: string[] = []

    while (currentId && currentId !== joinNodeId) {
      const node = this.nodeMap.get(currentId)
      if (!node) break

      this.emit({ type: 'pipeline:node_started', nodeId: node.id, nodeType: node.type })

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
        this.emit({ type: 'pipeline:node_failed', nodeId: node.id, error: result.error })
        break
      }

      this.emit({ type: 'pipeline:node_completed', nodeId: node.id, durationMs: result.durationMs })

      const nextIds = this.getNextNodeIds(node.id, runState)
      currentId = nextIds[0]
    }

    const stateDelta: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(runState)) {
      if (!valuesEqual(value, baselineState[key])) {
        stateDelta[key] = value
      }
    }

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
    this.emit({ type: 'pipeline:node_started', nodeId: loopNode.id, nodeType: 'loop' })

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
      this.emit({ type: 'pipeline:node_failed', nodeId: loopNode.id, error: result.error })
    } else {
      if (loopSpan) this.config.tracer?.endSpanOk(loopSpan)
      this.emit({ type: 'pipeline:node_completed', nodeId: loopNode.id, durationMs: result.durationMs })
    }

    // Attach metrics to output
    const output = { loopOutput: result.output, metrics }

    return { ...result, output }
  }

  // ---------------------------------------------------------------------------
  // Edge resolution
  // ---------------------------------------------------------------------------

  private getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[] {
    const edges = this.outgoingEdges.get(nodeId) ?? []
    const targets: string[] = []

    for (const edge of edges) {
      switch (edge.type) {
        case 'sequential':
          targets.push(edge.targetNodeId)
          break
        case 'conditional': {
          const predicate = this.config.predicates?.[edge.predicateName]
          if (predicate) {
            const result = predicate(runState)
            const branchKey = String(result)
            const target = edge.branches[branchKey]
            if (target) {
              targets.push(target)
            }
          }
          break
        }
      }
    }

    return targets
  }

  private getErrorTarget(nodeId: string): string | undefined {
    const edges = this.errorEdges.get(nodeId) ?? []
    if (edges.length === 0) return undefined
    const firstError = edges[0]
    if (firstError && firstError.type === 'error') {
      return firstError.targetNodeId
    }
    return undefined
  }

  private findJoinNode(forkId: string): JoinNode | undefined {
    for (const node of this.config.definition.nodes) {
      if (node.type === 'join' && node.forkId === forkId) {
        return node
      }
    }
    return undefined
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
      const checkpoint: PipelineCheckpoint = {
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        schemaVersion: '1.0.0',
        completedNodeIds: [...completedNodeIds],
        state: structuredClone(runState),
        createdAt: new Date().toISOString(),
      }
      await this.config.checkpointStore.save(checkpoint)
      this.emit({ type: 'pipeline:checkpoint_saved', runId, version: versionTracker.version })
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

    this.emit({
      type: 'pipeline:recovery_attempted',
      nodeId,
      attempt: this.recoveryAttemptsUsed,
      maxAttempts,
      error: errorMessage,
    })

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
        this.emit({
          type: 'pipeline:recovery_succeeded',
          nodeId,
          attempt: this.recoveryAttemptsUsed,
          summary: result.summary,
        })
        return true
      }

      this.emit({
        type: 'pipeline:recovery_failed',
        nodeId,
        attempt: this.recoveryAttemptsUsed,
        error: result.summary,
      })
      return false
    } catch (recoveryErr) {
      const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
      this.emit({
        type: 'pipeline:recovery_failed',
        nodeId,
        attempt: this.recoveryAttemptsUsed,
        error: `Recovery threw: ${msg}`,
      })
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let runCounter = 0

function generateRunId(): string {
  runCounter++
  return `run_${Date.now()}_${runCounter}`
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
