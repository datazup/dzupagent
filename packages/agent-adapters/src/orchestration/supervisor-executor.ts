/**
 * Supervisor execution engine.
 *
 * Hosts the `SupervisorOrchestrator` class which decomposes goals,
 * resolves subtask dependencies, and delegates execution to provider
 * adapters via the registry's fallback chain.
 */

import { ForgeError } from '@dzupagent/core/events'
import type { DzupEventBus } from '@dzupagent/core/events'
import { Semaphore } from '@dzupagent/core/orchestration'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

import { KeywordTaskDecomposer } from './supervisor-decomposition.js'
import { emitProgressEvent, emitSupervisorEvent } from './supervisor-feedback.js'
import type {
  SubTask,
  SubTaskResult,
  SupervisorConfig,
  SupervisorOptions,
  SupervisorResult,
  TaskDecomposer,
} from './supervisor-types.js'

function buildAbortError(message: string): ForgeError {
  return new ForgeError({
    code: 'BUDGET_EXCEEDED',
    message,
    recoverable: false,
  })
}

function normalizeConcurrency(value: number | undefined, defaultValue = 3): number {
  const concurrency = value ?? defaultValue
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `Supervisor maxConcurrentDelegations must be a finite positive integer; received ${String(concurrency)}`,
    )
  }
  return concurrency
}

async function acquireSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await semaphore.acquire()
    return true
  }

  if (signal.aborted) {
    return false
  }

  const acquirePromise = semaphore.acquire().then(() => {
    if (signal.aborted) {
      semaphore.release()
      return false
    }
    return true
  })

  const abortPromise = new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    acquirePromise.finally(() => signal.removeEventListener('abort', onAbort))
  })

  return await Promise.race([acquirePromise, abortPromise])
}

export class SupervisorOrchestrator {
  private readonly registry: ProviderAdapterRegistry
  private readonly eventBus: DzupEventBus | undefined
  private readonly decomposer: TaskDecomposer
  private readonly maxConcurrent: number

  constructor(config: SupervisorConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
    this.decomposer = config.decomposer ?? new KeywordTaskDecomposer()
    this.maxConcurrent = normalizeConcurrency(config.maxConcurrentDelegations)
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

    if (options?.signal?.aborted) {
      return {
        goal,
        subtaskResults: [],
        totalDurationMs: Date.now() - overallStart,
        cancelled: true,
      }
    }

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
    emitSupervisorEvent(this.eventBus, {
      type: 'supervisor:plan_created',
      goal,
      assignments,
      source: isKeywordDecomposer ? 'keyword' : 'llm',
    })

    // 3. Execute with dependency tracking
    const results = await this.executeWithDependencies(subtasks, options)

    if (results.some((result) => result.cancelled)) {
      return {
        goal,
        subtaskResults: results,
        totalDurationMs: Date.now() - overallStart,
        cancelled: true,
      }
    }

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
    let completedCount = 0
    const totalTasks = subtasks.length

    for (let i = 0; i < subtasks.length; i++) {
      const idx = i
      const subtask = subtasks[idx] as SubTask // bounds-checked by loop condition

      // Build a promise that waits for dependencies, then executes
      const taskPromise = (async (): Promise<void> => {
        try {
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

          const acquired = await acquireSemaphore(semaphore, options?.signal)
          try {
            if (!acquired) {
              throw buildAbortError('Supervisor execution aborted')
            }
            const result = await this.executeSingleSubtask(subtask, options)
            results[idx] = result
            completedCount++
            emitProgressEvent(this.eventBus, completedCount, totalTasks, result.providerId)
          } finally {
            if (acquired) {
              semaphore.release()
            }
          }
        } catch (err) {
          if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
            results[idx] = {
              subtask,
              providerId: null,
              result: '',
              success: false,
              durationMs: 0,
              error: err.message,
              cancelled: true,
            }
            return
          }
          throw err
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

    emitSupervisorEvent(this.eventBus, {
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
    let cancelled = false

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
      if (ForgeError.is(error) && error.code === 'AGENT_ABORTED') {
        success = false
        errorMessage = error.message
        cancelled = true
      } else {
        success = false
        errorMessage = error.message
      }
    }

    const durationMs = Date.now() - startMs

    emitSupervisorEvent(this.eventBus, {
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
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(cancelled ? { cancelled: true as const } : {}),
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
        code: 'AGENT_ABORTED',
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
}
