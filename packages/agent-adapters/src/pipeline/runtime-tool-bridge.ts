import {
  createRuntimeToolHandlers,
  type RuntimeAdapterParallelRequest,
  type RuntimeAdapterRaceRequest,
  type RuntimeAdapterRunRequest,
  type RuntimeAdapterSupervisorRequest,
  type RuntimePromptRequest,
  type RuntimeToolExecutionPorts,
  type RuntimeToolHandlers,
  type RuntimeToolPort,
  type RuntimeToolPortResult,
  type RuntimeValidateRequest,
  type RuntimeWorkerDispatchRequest,
} from '@dzupagent/agent/pipeline'

import type {
  FacadeSupervisorOptions,
  ParallelOptions,
  RunOptions,
  RunResult,
} from '../facade/orchestrator-facade.js'
import type {
  ParallelExecutionResult,
  ProviderResult,
} from '../orchestration/parallel-executor.js'
import type { SupervisorResult } from '../orchestration/supervisor.js'
import type { AdapterProviderId } from '../types.js'

export interface AdapterRuntimeToolOrchestrator {
  run(prompt: string, options?: RunOptions): Promise<RunResult>
  race(
    prompt: string,
    providers?: AdapterProviderId[],
    signal?: AbortSignal,
  ): Promise<ProviderResult>
  parallel(prompt: string, options?: ParallelOptions): Promise<ParallelExecutionResult>
  supervisor(goal: string, options?: FacadeSupervisorOptions): Promise<SupervisorResult>
}

export interface AdapterRuntimeToolBridgeOptions {
  orchestrator: AdapterRuntimeToolOrchestrator
  validate?: RuntimeToolPort<RuntimeValidateRequest>
}

export function createAdapterRuntimeToolHandlers(
  options: AdapterRuntimeToolBridgeOptions,
): RuntimeToolHandlers {
  return createRuntimeToolHandlers(createAdapterRuntimeToolPorts(options))
}

export function createAdapterRuntimeToolPorts(
  options: AdapterRuntimeToolBridgeOptions,
): RuntimeToolExecutionPorts {
  return {
    validate: options.validate,
    prompt: (request) => runPromptRuntimeTool(options.orchestrator, request),
    workerDispatch: (request) =>
      runWorkerDispatchRuntimeTool(options.orchestrator, request),
    adapterRun: (request) =>
      runAdapterRunRuntimeTool(options.orchestrator, request),
    adapterRace: (request) =>
      runAdapterRaceRuntimeTool(options.orchestrator, request),
    adapterParallel: (request) =>
      runAdapterParallelRuntimeTool(options.orchestrator, request),
    adapterSupervisor: (request) =>
      runAdapterSupervisorRuntimeTool(options.orchestrator, request),
  }
}

async function runPromptRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimePromptRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.run(request.userPrompt, {
    preferredProvider: optionalProviderId(request.provider),
    systemPrompt: request.systemPrompt,
  })

  return portResultFromRunResult(result, (run) => ({
    text: run.result,
    providerId: run.providerId,
    durationMs: run.durationMs,
    usage: run.usage,
  }))
}

async function runWorkerDispatchRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimeWorkerDispatchRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.run(
    promptWithInput(request.instructions, request.input),
    {
      preferredProvider: providerId(request.provider),
      systemPrompt: request.systemPrompt,
      tags: request.commandSurface !== undefined ? [request.commandSurface] : [],
    },
  )

  return portResultFromRunResult(result, (run) => ({
    dispatchId: request.dispatchId,
    result: run.result,
    providerId: run.providerId,
    durationMs: run.durationMs,
    usage: run.usage,
  }))
}

async function runAdapterRunRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimeAdapterRunRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.run(
    promptWithInput(request.instructions, request.input),
    {
      preferredProvider: optionalProviderId(request.provider),
      systemPrompt: request.systemPrompt,
      tags: request.tags ?? [],
      policy: request.policy as RunOptions['policy'],
      personaId: request.persona,
    },
  )

  return portResultFromRunResult(result, adapterRunOutput)
}

async function runAdapterRaceRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimeAdapterRaceRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.race(
    promptWithInput(request.instructions, request.input),
    request.providers.map(providerId),
  )

  if (!result.success) {
    return {
      error: {
        message: result.error ?? 'Adapter race failed',
        code: result.cancelled ? 'ADAPTER_RUNTIME_CANCELLED' : 'ADAPTER_RUNTIME_FAILED',
        retryable: result.cancelled !== true,
        metadata: { providerId: result.providerId },
      },
      output: result,
    }
  }

  return { output: result }
}

async function runAdapterParallelRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimeAdapterParallelRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.parallel(
    promptWithInput(request.instructions, request.input),
    {
      providers: request.providers.map(providerId),
      mergeStrategy: mergeStrategy(request.merge),
    },
  )

  if (result.cancelled === true || !result.selectedResult.success) {
    return {
      error: {
        message: result.selectedResult.error ?? 'Adapter parallel execution failed',
        code: result.cancelled === true
          ? 'ADAPTER_RUNTIME_CANCELLED'
          : 'ADAPTER_RUNTIME_FAILED',
        retryable: result.cancelled !== true,
        metadata: {
          providerId: result.selectedResult.providerId,
          strategy: result.strategy,
        },
      },
      output: result,
    }
  }

  return { output: result }
}

async function runAdapterSupervisorRuntimeTool(
  orchestrator: AdapterRuntimeToolOrchestrator,
  request: RuntimeAdapterSupervisorRequest,
): Promise<RuntimeToolPortResult> {
  const result = await orchestrator.supervisor(request.goal, {
    context: supervisorContext(request),
  })

  if (result.cancelled === true) {
    return {
      error: {
        message: 'Adapter supervisor execution was cancelled',
        code: 'ADAPTER_RUNTIME_CANCELLED',
        retryable: false,
      },
      output: result,
    }
  }

  return { output: result }
}

function portResultFromRunResult(
  result: RunResult,
  output: (result: RunResult) => Record<string, unknown>,
): RuntimeToolPortResult {
  if (result.cancelled === true || result.error !== undefined) {
    return {
      error: {
        message: result.error ?? 'Adapter run was cancelled',
        code: result.cancelled === true
          ? 'ADAPTER_RUNTIME_CANCELLED'
          : 'ADAPTER_RUNTIME_FAILED',
        retryable: result.cancelled !== true,
        metadata: { providerId: result.providerId },
      },
      output: output(result),
    }
  }

  return { output: compact(output(result)) }
}

function adapterRunOutput(result: RunResult): Record<string, unknown> {
  return {
    result: result.result,
    providerId: result.providerId,
    durationMs: result.durationMs,
    usage: result.usage,
  }
}

function promptWithInput(
  prompt: string,
  input: Record<string, unknown> | undefined,
): string {
  if (input === undefined || Object.keys(input).length === 0) return prompt
  return `${prompt}\n\nInput:\n${JSON.stringify(input, null, 2)}`
}

function supervisorContext(request: RuntimeAdapterSupervisorRequest): string | undefined {
  const context: Record<string, unknown> = {}
  if (request.specialists !== undefined) context.specialists = request.specialists
  if (request.input !== undefined) context.input = request.input
  if (request.persona !== undefined) context.persona = request.persona
  if (request.reasoning !== undefined) context.reasoning = request.reasoning
  if (request.outputSchema !== undefined) context.outputSchema = request.outputSchema
  return Object.keys(context).length > 0 ? JSON.stringify(context, null, 2) : undefined
}

function optionalProviderId(provider: string | undefined): AdapterProviderId | undefined {
  return provider === undefined ? undefined : providerId(provider)
}

function providerId(provider: string): AdapterProviderId {
  return provider as AdapterProviderId
}

function mergeStrategy(merge: string | undefined): NonNullable<ParallelOptions['mergeStrategy']> {
  if (merge === 'first-wins' || merge === 'all' || merge === 'best-of-n') {
    return merge
  }
  return 'all'
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
