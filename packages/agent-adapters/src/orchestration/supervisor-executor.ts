/**
 * Supervisor execution engine.
 *
 * Hosts the `SupervisorOrchestrator` class which decomposes goals,
 * resolves subtask dependencies, and delegates execution to provider
 * adapters via the registry's fallback chain.
 */

import { createEventBus, ForgeError } from '@dzupagent/core/events'
import type { DzupEventBus } from '@dzupagent/core/events'
import { Semaphore } from '@dzupagent/core/utils'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { AdapterPipeline } from '../pipeline/adapter-pipeline.js'
import { ApprovalPipelineStep } from '../pipeline/approval-pipeline-step.js'
import { GuardrailsPipelineStep } from '../pipeline/guardrails-pipeline-step.js'
import { PolicyEnforcementPipeline } from '../pipeline/policy-enforcement-pipeline.js'
import { UCLEnrichmentStep } from '../pipeline/ucl-enrichment-step.js'
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
    code: 'AGENT_ABORTED',
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
  private readonly pipeline: AdapterPipeline

  constructor(config: SupervisorConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
    this.decomposer = config.decomposer ?? new KeywordTaskDecomposer()
    this.maxConcurrent = normalizeConcurrency(config.maxConcurrentDelegations)
    this.pipeline = config.pipeline ?? new AdapterPipeline(
      new PolicyEnforcementPipeline(this.registry),
      new ApprovalPipelineStep(undefined),
      new GuardrailsPipelineStep(undefined, undefined),
      new UCLEnrichmentStep(this.registry, this.eventBus ?? createEventBus(), undefined),
    )
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

    // Validate the whole graph before routing, policy projection or provider effects.
    this.validateDependencies(subtasks)

    // The plan describes intent. Provider selection happens only after approval.
    const assignments = subtasks.map((st) => ({
      task: st.description,
      specialistId: st.preferredProvider ?? 'auto',
    }))

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
    const resolveCompletions: Array<() => void> = []
    const completions = subtasks.map(() => new Promise<void>((resolve) => {
      resolveCompletions.push(resolve)
    }))
    let completedCount = 0
    const totalTasks = subtasks.length

    const executions = subtasks.map((subtask, idx) => {
      // Build a promise that waits for dependencies, then executes
      return (async (): Promise<void> => {
        try {
          // Wait for dependencies
          const deps = subtask.dependsOn
          if (deps && deps.length > 0) {
            await Promise.all(deps.map((depIdx) => completions[depIdx]))

            // Check if any dependency failed
            const failed = deps.filter((depIdx) => !results[depIdx]?.success)
            if (failed.length > 0) {
              results[idx] = {
                subtask,
                providerId: null, // no execution happened
                result: '',
                success: false,
                durationMs: 0,
                error: `Skipped: dependency subtask ${String(failed[0])} failed`,
                skippedDependencies: failed,
                ...(options?.signal?.aborted ? { cancelled: true as const, errorCode: 'AGENT_ABORTED' } : {}),
              }
              return
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
          } finally {
            if (acquired) {
              semaphore.release()
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          const cancelled = options?.signal?.aborted || (ForgeError.is(err) && err.code === 'AGENT_ABORTED')
          results[idx] = {
            subtask,
            providerId: null,
            result: '',
            success: false,
            durationMs: 0,
            error: error.message,
            ...(ForgeError.is(err) ? { errorCode: err.code } : {}),
            ...(cancelled ? { cancelled: true as const, errorCode: 'AGENT_ABORTED' } : {}),
          }
        } finally {
          completedCount++
          emitProgressEvent(this.eventBus, completedCount, totalTasks, results[idx]?.providerId ?? null)
          resolveCompletions[idx]?.()
        }
      })()
    })

    await Promise.all(executions)
    return results
  }

  private async executeSingleSubtask(
    subtask: SubTask,
    options?: SupervisorOptions,
  ): Promise<SubTaskResult> {
    const task = this.buildTaskDescriptor(subtask, options)
    let specialistId: string = subtask.preferredProvider ?? 'auto'

    const input: AgentInput = {
      prompt: subtask.description,
      workingDirectory: options?.workingDirectory,
      signal: options?.signal,
      ...(options?.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options?.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
      ...((options?.model !== undefined ||
        options?.tools !== undefined ||
        options?.reasoning !== undefined ||
        options?.promptPrep !== undefined ||
        options?.policy !== undefined ||
        options?.personaId !== undefined)
        ? {
            options: compactSupervisorOptions({
              model: options.model,
              tools: options.tools,
              reasoning: options.reasoning,
              promptPrep: options.promptPrep,
              policy: options.policy,
              personaId: options.personaId,
            }),
          }
        : {}),
    }

    const startMs = Date.now()
    let resultText = ''
    let resultProviderId: AdapterProviderId | null = null
    let sessionId: string | undefined
    let success = false
    let errorMessage: string | undefined
    let errorCode: string | undefined
    let cancelled = false
    let delegated = false

    try {
      const requireApproval = options?.requireApproval === true || options?.policy?.approvalRequired === true
      if (requireApproval && !this.pipeline.approval.enabled) {
        throw new ForgeError({
          code: 'ADAPTER_EXECUTION_FAILED',
          message: 'Supervisor approval is required but no approval gate is configured',
          recoverable: false,
        })
      }
      // Keep all preparation/routing/adapter effects behind the approval gate.
      const delegate = async function* (this: SupervisorOrchestrator): AsyncGenerator<AgentEvent, void, undefined> {
        this.throwIfAborted(options?.signal)
        await this.pipeline.prepare({
          input,
          preferredProvider: subtask.preferredProvider,
          policy: options?.policy,
          policyConformanceMode: options?.policyConformanceMode,
        })
        this.throwIfAborted(options?.signal)
        const { decision } = this.registry.getForTask(task)
        specialistId = decision.provider
        delegated = true
        emitSupervisorEvent(this.eventBus, {
          type: 'supervisor:delegating',
          specialistId,
          task: subtask.description,
        })
        yield* this.pipeline.wrapStream(this.registry.executeWithFallback(input, task), input, {
          prompt: subtask.description,
          requireApproval: false, // already gated before preparation
        })
      }.bind(this)
      const generator = this.pipeline.approval.wrap(delegate(), {
        prompt: subtask.description,
        providerId: subtask.preferredProvider,
        tags: subtask.tags,
        approvalRunId: options?.approvalRunId,
        requireApproval,
        signal: options?.signal,
      })

      for await (const event of generator) {
        this.throwIfAborted(options?.signal)

        if (this.isCompletedEvent(event)) {
          resultText = event.result
          resultProviderId = delegated ? event.providerId : null
          sessionId = event.sessionId
          success = true
          errorMessage = undefined
          errorCode = undefined
          cancelled = false
        } else if (this.isFailedEvent(event)) {
          // Adapter-level failures are emitted as events but the generator
          // may continue to the next fallback. We only record the last failure
          // if no completion event arrives.
          errorMessage = event.error
          errorCode = event.code
          resultProviderId = delegated ? event.providerId : null
          sessionId = event.sessionId
          success = false
          cancelled = event.code === 'AGENT_ABORTED'
        }
      }

      // If we exited the loop without a completed event but also without
      // throwing, the last failure event holds the error.
      this.throwIfAborted(options?.signal)
      if (!success && !errorMessage) {
        errorMessage = 'Adapter completed without producing a result event'
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      success = false
      errorMessage = error.message
      errorCode = ForgeError.is(error) ? error.code : undefined
      cancelled = options?.signal?.aborted === true || errorCode === 'AGENT_ABORTED'
      if (cancelled) errorCode = 'AGENT_ABORTED'
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
      ...(sessionId !== undefined ? { sessionId } : {}),
      result: resultText,
      success,
      durationMs,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(cancelled ? { cancelled: true as const } : {}),
    }
  }

  private buildTaskDescriptor(subtask: SubTask, options?: SupervisorOptions): TaskDescriptor {
    return {
      prompt: subtask.description,
      tags: subtask.tags,
      preferredProvider: subtask.preferredProvider,
      approvedFallbackProviders: options?.approvedFallbackProviders,
      requiresExecution: subtask.requiresExecution,
      requiresReasoning: subtask.requiresReasoning,
      workingDirectory: options?.workingDirectory,
      budgetConstraint: options?.budgetConstraint,
    }
  }

  private validateDependencies(subtasks: SubTask[]): void {
    const remaining = subtasks.map((subtask) => subtask.dependsOn?.length ?? 0)
    const dependents: number[][] = subtasks.map(() => [])
    for (const [idx, subtask] of subtasks.entries()) {
      for (const dependency of subtask.dependsOn ?? []) {
        if (!Number.isInteger(dependency) || dependency < 0 || dependency >= subtasks.length || dependency === idx) {
          throw new Error(`Invalid supervisor dependency ${String(dependency)} for subtask ${String(idx)}`)
        }
        dependents[dependency]!.push(idx)
      }
    }
    const ready = remaining.flatMap((count, idx) => count === 0 ? [idx] : [])
    for (let cursor = 0; cursor < ready.length; cursor++) {
      for (const dependent of dependents[ready[cursor]!]!) {
        remaining[dependent] = remaining[dependent]! - 1
        if (remaining[dependent] === 0) ready.push(dependent)
      }
    }
    if (ready.length !== subtasks.length) {
      throw new Error('Supervisor dependency graph contains a cycle')
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

function compactSupervisorOptions<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
