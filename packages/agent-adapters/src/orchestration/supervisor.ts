/**
 * SupervisorOrchestrator -- Supervisor multi-agent pattern.
 *
 * A supervisor decomposes a goal into subtasks and delegates each to the
 * best-suited adapter via the AdapterRegistry.  Dependencies between
 * subtasks are respected: independent subtasks run in parallel (up to
 * `maxConcurrentDelegations`), while dependent subtasks wait for their
 * prerequisites to complete.
 *
 * Events emitted (all defined in @dzipagent/core DzipEvent):
 *   supervisor:plan_created
 *   supervisor:delegating
 *   supervisor:delegation_complete
 */

import type { DzipEventBus } from '@dzipagent/core'
import { ForgeError } from '@dzipagent/core'

import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single subtask produced by a TaskDecomposer. */
export interface SubTask {
  description: string
  tags: string[]
  preferredProvider?: AdapterProviderId
  requiresReasoning?: boolean
  requiresExecution?: boolean
  /** Indices of subtasks that must complete before this one starts. */
  dependsOn?: number[]
}

/** Strategy that breaks a high-level goal into subtasks. */
export interface TaskDecomposer {
  decompose(goal: string, context?: string): Promise<SubTask[]>
}

/** Result of a single subtask delegation. */
export interface SubTaskResult {
  subtask: SubTask
  providerId: AdapterProviderId | null
  result: string
  success: boolean
  durationMs: number
  error?: string
}

/** Aggregated result returned by `SupervisorOrchestrator.execute`. */
export interface SupervisorResult {
  goal: string
  subtaskResults: SubTaskResult[]
  totalDurationMs: number
}

/** Options accepted by `SupervisorOrchestrator.execute`. */
export interface SupervisorOptions {
  /** Abort signal for cancellation. */
  signal?: AbortSignal
  /** Working directory forwarded to adapters. */
  workingDirectory?: string
  /** Optional context string passed to the decomposer. */
  context?: string
  /** Budget constraint forwarded to task descriptors. */
  budgetConstraint?: 'low' | 'medium' | 'high' | 'unlimited'
}

/** Configuration for the SupervisorOrchestrator. */
export interface SupervisorConfig {
  registry: AdapterRegistry
  eventBus?: DzipEventBus
  decomposer?: TaskDecomposer
  /** Maximum subtasks executing concurrently. Default 3. */
  maxConcurrentDelegations?: number
}

// ---------------------------------------------------------------------------
// KeywordTaskDecomposer -- default, rule-based decomposer
// ---------------------------------------------------------------------------

/** Keyword-based patterns used for default decomposition. */
interface DecompositionRule {
  pattern: RegExp
  tags: string[]
  requiresExecution: boolean
  requiresReasoning: boolean
}

const DECOMPOSITION_RULES: DecompositionRule[] = [
  {
    pattern: /\b(?:review|analyze|evaluate|assess|audit)\b/i,
    tags: ['reasoning', 'analysis'],
    requiresExecution: false,
    requiresReasoning: true,
  },
  {
    pattern: /\b(?:implement|build|create|develop|write|add)\b/i,
    tags: ['execution', 'implementation'],
    requiresExecution: true,
    requiresReasoning: false,
  },
  {
    pattern: /\b(?:fix|repair|patch|debug|resolve)\b/i,
    tags: ['execution', 'bugfix'],
    requiresExecution: true,
    requiresReasoning: false,
  },
  {
    pattern: /\b(?:test|verify|validate|check)\b/i,
    tags: ['execution', 'testing'],
    requiresExecution: true,
    requiresReasoning: false,
  },
]

/**
 * Default decomposer that splits goals into subtasks using keyword heuristics.
 *
 * Splitting strategy:
 * 1. Split the goal on sentence boundaries (`.` / `;` / `\n`).
 * 2. Classify each sentence against keyword rules.
 * 3. If no split is possible, return the whole goal as a single subtask.
 */
export class KeywordTaskDecomposer implements TaskDecomposer {
  async decompose(goal: string, _context?: string): Promise<SubTask[]> {
    // Split on sentence / line boundaries and drop empties
    const sentences = goal
      .split(/[.;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    if (sentences.length <= 1) {
      return [this.classifySentence(goal)]
    }

    return sentences.map((sentence) => this.classifySentence(sentence))
  }

  private classifySentence(sentence: string): SubTask {
    for (const rule of DECOMPOSITION_RULES) {
      if (rule.pattern.test(sentence)) {
        return {
          description: sentence,
          tags: rule.tags,
          requiresExecution: rule.requiresExecution,
          requiresReasoning: rule.requiresReasoning,
        }
      }
    }

    // Fallback: treat as a general execution task
    return {
      description: sentence,
      tags: ['general'],
      requiresExecution: true,
      requiresReasoning: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Semaphore -- simple concurrency limiter
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'BUDGET_EXCEEDED',
        message: 'Supervisor execution aborted',
        recoverable: false,
      })
    }

    if (this.current < this.max) {
      this.current++
      return
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(
          new ForgeError({
            code: 'BUDGET_EXCEEDED',
            message: 'Supervisor execution aborted while waiting for semaphore',
            recoverable: false,
          }),
        )
      }

      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.current++
        resolve()
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    this.current--
    const next = this.waiters.shift()
    if (next) next()
  }
}

// ---------------------------------------------------------------------------
// SupervisorOrchestrator
// ---------------------------------------------------------------------------

export class SupervisorOrchestrator {
  private readonly registry: AdapterRegistry
  private readonly eventBus: DzipEventBus | undefined
  private readonly decomposer: TaskDecomposer
  private readonly maxConcurrent: number

  constructor(config: SupervisorConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
    this.decomposer = config.decomposer ?? new KeywordTaskDecomposer()
    this.maxConcurrent = config.maxConcurrentDelegations ?? 3
  }

  /**
   * Decompose `goal` into subtasks and delegate each to the best adapter.
   *
   * Subtask dependencies are respected: a subtask will not start until all
   * subtasks listed in its `dependsOn` array have completed successfully.
   * Independent subtasks execute in parallel, bounded by `maxConcurrentDelegations`.
   */
  async execute(goal: string, options?: SupervisorOptions): Promise<SupervisorResult> {
    const overallStart = Date.now()

    this.throwIfAborted(options?.signal)

    // 1. Decompose
    const subtasks = await this.decomposer.decompose(goal, options?.context)

    if (subtasks.length === 0) {
      return { goal, subtaskResults: [], totalDurationMs: Date.now() - overallStart }
    }

    // 2. Build plan and emit event
    const assignments = subtasks.map((st) => {
      const task = this.buildTaskDescriptor(st, options)
      const { decision } = this.registry.getForTask(task)
      const specialistId = decision.provider === 'auto' ? 'auto' : decision.provider
      return { task: st.description, specialistId }
    })

    const isKeywordDecomposer = this.decomposer instanceof KeywordTaskDecomposer
    this.emitEvent({
      type: 'supervisor:plan_created',
      goal,
      assignments,
      source: isKeywordDecomposer ? 'keyword' : 'llm',
    })

    // 3. Execute with dependency tracking
    const results = await this.executeWithDependencies(subtasks, options)

    return {
      goal,
      subtaskResults: results,
      totalDurationMs: Date.now() - overallStart,
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async executeWithDependencies(
    subtasks: SubTask[],
    options?: SupervisorOptions,
  ): Promise<SubTaskResult[]> {
    const semaphore = new Semaphore(this.maxConcurrent)
    const results: SubTaskResult[] = new Array(subtasks.length)
    // Promises that resolve when each subtask completes (for dependency tracking)
    const completions: Promise<void>[] = []

    for (let i = 0; i < subtasks.length; i++) {
      const idx = i
      const subtask = subtasks[idx] as SubTask // bounds-checked by loop condition

      // Build a promise that waits for dependencies, then executes
      const taskPromise = (async (): Promise<void> => {
        // Wait for dependencies
        const deps = subtask.dependsOn
        if (deps && deps.length > 0) {
          const depPromises: Promise<void>[] = []
          for (const depIdx of deps) {
            const p = completions[depIdx]
            if (depIdx >= 0 && p) depPromises.push(p)
          }
          await Promise.all(depPromises)

          // Check if any dependency failed
          for (const depIdx of deps) {
            const depResult = depIdx >= 0 ? results[depIdx] : undefined
            if (depResult && !depResult.success) {
              results[idx] = {
                subtask,
                providerId: null, // no execution happened
                result: '',
                success: false,
                durationMs: 0,
                error: `Skipped: dependency subtask ${String(depIdx)} failed`,
              }
              return
            }
          }
        }

        this.throwIfAborted(options?.signal)

        await semaphore.acquire(options?.signal)
        try {
          results[idx] = await this.executeSingleSubtask(subtask, options)
        } finally {
          semaphore.release()
        }
      })()

      completions.push(taskPromise)
    }

    await Promise.all(completions)
    return results
  }

  private async executeSingleSubtask(
    subtask: SubTask,
    options?: SupervisorOptions,
  ): Promise<SubTaskResult> {
    const task = this.buildTaskDescriptor(subtask, options)
    const { decision } = this.registry.getForTask(task)
    const specialistId = decision.provider === 'auto' ? 'auto' : decision.provider

    this.emitEvent({
      type: 'supervisor:delegating',
      specialistId,
      task: subtask.description,
    })

    const input: AgentInput = {
      prompt: subtask.description,
      workingDirectory: options?.workingDirectory,
      signal: options?.signal,
    }

    const startMs = Date.now()
    let resultText = ''
    let resultProviderId: AdapterProviderId | null = null
    let success = false
    let errorMessage: string | undefined

    try {
      const generator = this.registry.executeWithFallback(input, task)

      for await (const event of generator) {
        this.throwIfAborted(options?.signal)

        if (this.isCompletedEvent(event)) {
          resultText = event.result
          resultProviderId = event.providerId
          success = true
        } else if (this.isFailedEvent(event)) {
          // Adapter-level failures are emitted as events but the generator
          // may continue to the next fallback. We only record the last failure
          // if no completion event arrives.
          errorMessage = event.error
          resultProviderId = event.providerId
        }
      }

      // If we exited the loop without a completed event but also without
      // throwing, the last failure event holds the error.
      if (!success && errorMessage) {
        // Already captured via the event loop above
      } else if (!success) {
        errorMessage = 'Adapter completed without producing a result event'
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      success = false
      errorMessage = error.message
    }

    const durationMs = Date.now() - startMs

    this.emitEvent({
      type: 'supervisor:delegation_complete',
      specialistId,
      task: subtask.description,
      success,
    })

    return {
      subtask,
      providerId: resultProviderId,
      result: resultText,
      success,
      durationMs,
      error: errorMessage,
    }
  }

  private buildTaskDescriptor(subtask: SubTask, options?: SupervisorOptions): TaskDescriptor {
    return {
      prompt: subtask.description,
      tags: subtask.tags,
      preferredProvider: subtask.preferredProvider,
      requiresExecution: subtask.requiresExecution,
      requiresReasoning: subtask.requiresReasoning,
      workingDirectory: options?.workingDirectory,
      budgetConstraint: options?.budgetConstraint,
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'BUDGET_EXCEEDED',
        message: 'Supervisor execution was aborted',
        recoverable: false,
      })
    }
  }

  private isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
    return event.type === 'adapter:completed'
  }

  private isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
    return event.type === 'adapter:failed'
  }

  private emitEvent(
    event:
      | {
          type: 'supervisor:plan_created'
          goal: string
          assignments: Array<{ task: string; specialistId: string }>
          source?: 'llm' | 'keyword'
        }
      | { type: 'supervisor:delegating'; specialistId: string; task: string }
      | { type: 'supervisor:delegation_complete'; specialistId: string; task: string; success: boolean },
  ): void {
    if (this.eventBus) {
      this.eventBus.emit(event as Parameters<DzipEventBus['emit']>[0])
    }
  }
}
