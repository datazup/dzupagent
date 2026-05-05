import { ForgeError } from '@dzupagent/core'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import { WorkflowStepResolver, type TemplateContext } from './template-resolver.js'
import type {
  AdapterStepConfig,
  AdapterStepResult,
  AdapterWorkflowEvent,
  LoopConfig,
  ParallelMergeStrategy,
} from './adapter-workflow.js'

export const sharedTemplateResolver = new WorkflowStepResolver()

/**
 * State key reserved by the adapter workflow runtime for storing the most
 * recent step result. Exposed so that the pipeline assembler and execution
 * helpers can share the same key without duplicating the literal.
 */
export const PREV_RESULT_STATE_KEY = '__adapter_workflow_internal_prev_result'

export function resolveFallbackProviderId(
  registry: ProviderAdapterRegistry,
  preferredProvider?: AdapterProviderId,
): AdapterProviderId {
  return preferredProvider ?? registry.listAdapters()[0] ?? ('unknown' as AdapterProviderId)
}

export function resolveTemplate(
  template: string,
  state: Record<string, unknown>,
  prevResult?: string,
): string {
  const context: TemplateContext = { prev: prevResult, state }
  return sharedTemplateResolver.resolve(template, context)
}

export function isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
  return event.type === 'adapter:completed'
}

export function isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
  return event.type === 'adapter:failed'
}

export function mergeParallelResults(
  state: Record<string, unknown>,
  results: AdapterStepResult[],
  strategy: ParallelMergeStrategy,
): void {
  switch (strategy) {
    case 'merge': {
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'concat': {
      state['parallelResults'] = results.map((r) => ({
        stepId: r.stepId,
        result: r.result,
        success: r.success,
      }))
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'last-wins': {
      const lastSuccess = [...results].reverse().find((r) => r.success)
      if (lastSuccess) {
        state['lastResult'] = lastSuccess.result
      }
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
  }
}

/**
 * Execute the body of a workflow `loop` node.
 *
 * Iterates while `loopConfig.condition(state)` returns true, up to
 * `loopConfig.maxIterations`. Each iteration runs the configured steps in
 * order, threading `__adapter_workflow_internal_prev_result` through the
 * shared mutable state. Throws `ITERATION_LIMIT_EXCEEDED` when the iteration
 * cap is reached and `onMaxIterations === 'fail'`.
 */
export async function executeLoop(
  loopConfig: LoopConfig,
  workflowId: string,
  registry: ProviderAdapterRegistry,
  state: Record<string, unknown>,
  emit: (event: AdapterWorkflowEvent) => void,
  stepResults: AdapterStepResult[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const currentState = { ...state }
  for (let i = 0; i < loopConfig.maxIterations; i++) {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: 'Workflow execution was aborted',
        recoverable: false,
      })
    }
    if (!loopConfig.condition(currentState)) break

    currentState[`${loopConfig.id}_iteration`] = i + 1

    for (const step of loopConfig.steps) {
      const prevResult = typeof currentState[PREV_RESULT_STATE_KEY] === 'string'
        ? (currentState[PREV_RESULT_STATE_KEY] as string)
        : undefined
      const result = await executeAdapterStep(
        registry,
        workflowId,
        step,
        currentState,
        prevResult,
        emit,
        signal,
      )
      stepResults.push(result)
      currentState[step.id] = result.result
      if (result.success) {
        currentState[PREV_RESULT_STATE_KEY] = result.result
      }
      if (!result.success) {
        throw new Error(`Loop step "${step.id}" failed: ${result.error ?? 'unknown error'}`)
      }
    }
  }

  if (loopConfig.condition(currentState) && loopConfig.onMaxIterations === 'fail') {
    throw new ForgeError({
      code: 'ITERATION_LIMIT_EXCEEDED',
      message: `Loop ${loopConfig.id} exceeded ${loopConfig.maxIterations} iterations`,
    })
  }

  return currentState
}

/**
 * Execute a single adapter-routed workflow step with retry, timeout, and
 * skip-condition handling. Emits `step:*` events through `emit`.
 */
export async function executeAdapterStep(
  registry: ProviderAdapterRegistry,
  workflowId: string,
  config: AdapterStepConfig,
  state: Record<string, unknown>,
  prevResult: string | undefined,
  emit: (event: AdapterWorkflowEvent) => void,
  signal?: AbortSignal,
): Promise<AdapterStepResult> {
  // Check skip condition before executing the step
  if (config.skipIf?.(state)) {
    const skipResult = config.skipDefault ?? ''
    emit({ type: 'step:skipped', workflowId, stepId: config.id })
    return {
      stepId: config.id,
      result: skipResult,
      providerId: resolveFallbackProviderId(registry, config.preferredProvider),
      success: true,
      durationMs: 0,
      retries: 0,
    }
  }

  const maxRetries = config.maxRetries ?? 0
  let lastError: string | undefined
  let attempt = 0

  while (attempt <= maxRetries) {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: 'Workflow execution was aborted',
        recoverable: false,
      })
    }

    if (attempt > 0) {
      emit({
        type: 'step:retrying',
        workflowId,
        stepId: config.id,
        attempt,
        maxRetries,
      })
    }

    emit({ type: 'step:started', workflowId, stepId: config.id })
    const stepStart = Date.now()

    // Derive a combined signal that respects both caller abort and per-step timeout
    let effectiveSignal = signal
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (config.timeoutMs != null) {
      const timeoutController = new AbortController()
      timeoutHandle = setTimeout(() => timeoutController.abort(), config.timeoutMs)
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref()
      effectiveSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal
    }

    try {
      const resolvedPrompt = config.promptFn
        ? config.promptFn(state)
        : resolveTemplate(config.prompt, state, prevResult)

      const task: TaskDescriptor = {
        prompt: resolvedPrompt,
        tags: config.tags ?? [],
        preferredProvider: config.preferredProvider,
        requiresReasoning: config.requiresReasoning,
        requiresExecution: config.requiresExecution,
        workingDirectory: config.workingDirectory,
      }

      const input: AgentInput = {
        prompt: resolvedPrompt,
        systemPrompt: config.systemPrompt,
        workingDirectory: config.workingDirectory,
        maxTurns: config.maxTurns,
        signal: effectiveSignal,
      }

      const { resultText, providerId } = await consumeAdapterEvents(registry, input, task, effectiveSignal)
      const durationMs = Date.now() - stepStart

      emit({
        type: 'step:completed',
        workflowId,
        stepId: config.id,
        durationMs,
        providerId,
      })

      return {
        stepId: config.id,
        result: resultText,
        providerId,
        success: true,
        durationMs,
        retries: attempt,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
        throw err
      }
      lastError = errorMessage
      const durationMs = Date.now() - stepStart

      emit({
        type: 'step:failed',
        workflowId,
        stepId: config.id,
        error: errorMessage,
        retryCount: attempt,
      })

      if (attempt < maxRetries) {
        attempt++
        continue
      }

      return {
        stepId: config.id,
        result: '',
        providerId: resolveFallbackProviderId(registry, config.preferredProvider),
        success: false,
        durationMs,
        retries: attempt,
        error: lastError,
      }
    } finally {
      if (timeoutHandle != null) clearTimeout(timeoutHandle)
    }
  }

  return {
    stepId: config.id,
    result: '',
    providerId: resolveFallbackProviderId(registry, config.preferredProvider),
    success: false,
    durationMs: 0,
    retries: attempt,
    error: lastError ?? 'Unknown error',
  }
}

/**
 * Drive the adapter registry's fallback execution generator and reduce its
 * event stream into a single result text + provider id. Throws if the
 * adapter never emits a completion event.
 */
export async function consumeAdapterEvents(
  registry: ProviderAdapterRegistry,
  input: AgentInput,
  task: TaskDescriptor,
  signal?: AbortSignal,
): Promise<{ resultText: string; providerId: AdapterProviderId }> {
  const generator = registry.executeWithFallback(input, task)

  let resultText = ''
  let resultProviderId = resolveFallbackProviderId(registry, task.preferredProvider)
  let completed = false
  let lastError: string | undefined

  for await (const event of generator) {
    if (signal?.aborted) {
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: 'Workflow execution was aborted',
        recoverable: false,
      })
    }

    if (isCompletedEvent(event)) {
      resultText = event.result
      resultProviderId = event.providerId
      completed = true
    } else if (isFailedEvent(event)) {
      lastError = event.error
      resultProviderId = event.providerId
    }
  }

  if (!completed) {
    throw new Error(lastError ?? 'Adapter completed without producing a result')
  }

  return { resultText, providerId: resultProviderId }
}
