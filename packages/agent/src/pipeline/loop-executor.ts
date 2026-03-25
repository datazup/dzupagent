/**
 * Loop executor — runs LoopNode body nodes iteratively until
 * a continue predicate returns false or maxIterations is reached.
 *
 * @module pipeline/loop-executor
 */

import type { LoopNode, PipelineNode } from '@forgeagent/core'
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from './pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Loop executor
// ---------------------------------------------------------------------------

/**
 * Execute a loop node: runs body nodes in sequence per iteration,
 * evaluating the continue predicate after each iteration.
 */
export async function executeLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  predicates: Record<string, (state: Record<string, unknown>) => boolean>,
  onEvent?: (event: PipelineRuntimeEvent) => void,
): Promise<{ result: NodeResult; metrics: LoopMetrics }> {
  const startTime = Date.now()
  const iterationDurations: number[] = []
  let iterationCount = 0
  let terminationReason: LoopMetrics['terminationReason'] = 'max_iterations'
  let lastBodyResult: NodeResult | undefined

  const continuePredicate = predicates[loopNode.continuePredicateName]
  if (!continuePredicate) {
    throw new Error(
      `Loop node "${loopNode.id}": predicate "${loopNode.continuePredicateName}" not found in predicates`,
    )
  }

  for (let i = 0; i < loopNode.maxIterations; i++) {
    // Check cancellation
    if (context.signal?.aborted) {
      terminationReason = 'cancelled'
      break
    }

    const iterStart = Date.now()
    iterationCount++

    onEvent?.({
      type: 'pipeline:loop_iteration',
      nodeId: loopNode.id,
      iteration: iterationCount,
      maxIterations: loopNode.maxIterations,
    })

    // Execute body nodes in sequence
    for (const bodyNode of bodyNodes) {
      if (context.signal?.aborted) {
        terminationReason = 'cancelled'
        break
      }

      const bodyResult = await nodeExecutor(bodyNode.id, bodyNode, context)
      context.previousResults.set(bodyNode.id, bodyResult)
      lastBodyResult = bodyResult

      if (bodyResult.error) {
        // Body node failed — propagate as loop failure
        const totalDuration = Date.now() - startTime
        iterationDurations.push(Date.now() - iterStart)
        return {
          result: {
            nodeId: loopNode.id,
            output: bodyResult.output,
            durationMs: totalDuration,
            error: `Loop body node "${bodyNode.id}" failed: ${bodyResult.error}`,
          },
          metrics: {
            iterationCount,
            iterationDurations,
            converged: false,
            terminationReason: 'condition_met',
          },
        }
      }
    }

    iterationDurations.push(Date.now() - iterStart)

    if (context.signal?.aborted) {
      terminationReason = 'cancelled'
      break
    }

    // Evaluate continue predicate
    const shouldContinue = continuePredicate(context.state)
    if (!shouldContinue) {
      terminationReason = 'condition_met'
      break
    }
  }

  // If we exhausted iterations and failOnMaxIterations is set
  if (terminationReason === 'max_iterations' && loopNode.failOnMaxIterations) {
    const totalDuration = Date.now() - startTime
    return {
      result: {
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: totalDuration,
        error: `Loop "${loopNode.id}" reached maxIterations (${loopNode.maxIterations})`,
      },
      metrics: {
        iterationCount,
        iterationDurations,
        converged: false,
        terminationReason: 'max_iterations',
      },
    }
  }

  const totalDuration = Date.now() - startTime
  return {
    result: {
      nodeId: loopNode.id,
      output: lastBodyResult?.output ?? null,
      durationMs: totalDuration,
    },
    metrics: {
      iterationCount,
      iterationDurations,
      converged: terminationReason === 'condition_met',
      terminationReason,
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in predicate helpers
// ---------------------------------------------------------------------------

/**
 * Creates a predicate that returns true when the given state field is truthy.
 */
export function stateFieldTruthy(field: string): (state: Record<string, unknown>) => boolean {
  return (state) => Boolean(state[field])
}

/**
 * Creates a predicate that returns true when the given numeric state field
 * is below the threshold (i.e., quality not yet reached — keep looping).
 */
export function qualityBelow(field: string, threshold: number): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field]
    if (typeof value !== 'number') return true
    return value < threshold
  }
}

/**
 * Creates a predicate that returns true when the given state field
 * is an array with at least one element (errors still present — keep looping).
 */
export function hasErrors(field: string): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field]
    if (!Array.isArray(value)) return false
    return value.length > 0
  }
}
