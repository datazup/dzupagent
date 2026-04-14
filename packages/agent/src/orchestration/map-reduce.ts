/**
 * MapReduce orchestration for parallel agent execution.
 *
 * Splits work into chunks, executes them across agents in parallel
 * (with configurable concurrency), and merges results using a
 * pluggable merge strategy.
 */
import { HumanMessage } from '@langchain/core/messages'
import { Semaphore } from '@dzupagent/core/orchestration'
import type { DzupAgent } from '../agent/dzip-agent.js'
import type { MergeStrategyFn } from './merge-strategies.js'
import { getMergeStrategy } from './merge-strategies.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MapReduceConfig {
  /** Max concurrent agent executions (default: 5). */
  concurrency: number
  /** Merge strategy for combining results (default: 'concat'). */
  mergeStrategy: MergeStrategyFn | 'concat' | 'vote' | 'custom'
  /** Custom merge function (required when mergeStrategy is 'custom'). */
  customMerge?: MergeStrategyFn
  /** Abort signal for cancellation. */
  signal?: AbortSignal
}

export interface MapReduceResult {
  /** Merged final result. */
  result: string
  /** Individual agent results (before merging). */
  agentResults: AgentOutput[]
  /** Total duration in milliseconds. */
  durationMs: number
  /** Success / failure counts. */
  stats: { total: number; succeeded: number; failed: number }
}

export interface AgentOutput {
  agentId: string
  chunkIndex: number
  content: string
  success: boolean
  error?: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeConcurrency(value: number | undefined, defaultValue = 5): number {
  const concurrency = value ?? defaultValue
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `MapReduce concurrency must be a finite positive integer; received ${String(concurrency)}`,
    )
  }
  return concurrency
}

function resolveMerge(config: Partial<MapReduceConfig>): MergeStrategyFn {
  const strategy = config.mergeStrategy ?? 'concat'

  if (typeof strategy === 'function') return strategy

  if (strategy === 'custom') {
    if (!config.customMerge) {
      throw new Error('MapReduce: mergeStrategy is "custom" but no customMerge function provided')
    }
    return config.customMerge
  }

  return getMergeStrategy(strategy)
}

async function executeAgent(
  agent: DzupAgent,
  input: string,
  chunkIndex: number,
  signal?: AbortSignal,
): Promise<AgentOutput> {
  const start = Date.now()
  try {
    if (signal?.aborted) {
      throw new Error('Aborted')
    }
    const result = await agent.generate([new HumanMessage(input)], { signal })
    return {
      agentId: agent.id,
      chunkIndex,
      content: result.content,
      success: true,
      durationMs: Date.now() - start,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      agentId: agent.id,
      chunkIndex,
      content: '',
      success: false,
      error: message,
      durationMs: Date.now() - start,
    }
  }
}

function buildResult(
  agentResults: AgentOutput[],
  merged: string,
  startTime: number,
): MapReduceResult {
  const succeeded = agentResults.filter((r) => r.success).length
  return {
    result: merged,
    agentResults,
    durationMs: Date.now() - startTime,
    stats: {
      total: agentResults.length,
      succeeded,
      failed: agentResults.length - succeeded,
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * MapReduce execution -- split work across one agent, execute in parallel, merge results.
 *
 * The same agent handles every chunk; concurrency is bounded by `config.concurrency`.
 * Failed chunks are captured (not thrown) so other chunks can complete.
 */
export async function mapReduce(
  agent: DzupAgent,
  chunks: string[],
  config?: Partial<MapReduceConfig>,
): Promise<MapReduceResult> {
  const tasks = chunks.map((input) => ({ agent, input }))
  return mapReduceMulti(tasks, config)
}

/**
 * MapReduce with heterogeneous agents -- each task pairs an agent with its input.
 *
 * Uses `Promise.allSettled` internally so a single failure never blocks the batch.
 */
export async function mapReduceMulti(
  tasks: Array<{ agent: DzupAgent; input: string }>,
  config?: Partial<MapReduceConfig>,
): Promise<MapReduceResult> {
  const cfg = config ?? {}
  const concurrency = normalizeConcurrency(cfg.concurrency)
  const mergeFn = resolveMerge(cfg)
  const sem = new Semaphore(concurrency)
  const startTime = Date.now()

  const promises = tasks.map(async ({ agent, input }, index) => {
    await sem.acquire()
    try {
      return await executeAgent(agent, input, index, cfg.signal)
    } finally {
      sem.release()
    }
  })

  const settled = await Promise.allSettled(promises)

  const agentResults: AgentOutput[] = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value
    // Should not happen since executeAgent catches internally, but be safe
    const message = outcome.reason instanceof Error
      ? outcome.reason.message
      : String(outcome.reason)
    return {
      agentId: tasks[index]!.agent.id,
      chunkIndex: index,
      content: '',
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    }
  })

  const successContents = agentResults
    .filter((r) => r.success)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((r) => r.content)

  const merged = successContents.length > 0
    ? await mergeFn(successContents)
    : ''

  return buildResult(agentResults, merged, startTime)
}
