/**
 * Run/chat dispatch coordinators extracted from OrchestratorFacade.
 *
 * These functions encapsulate the event-stream wiring (registry execution,
 * EventBusBridge, AdapterPipeline.wrapStream) that backs the public `run()`
 * and `chat()` APIs. They are stateless and accept their dependencies as
 * arguments so the facade class stays a thin coordinator.
 */

import { ForgeError } from '@dzupagent/core/events'

import type { AdapterPipeline } from '../pipeline/index.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { EventBusBridge } from '../registry/event-bus-bridge.js'
import type {
  MultiTurnOptions,
  SessionRegistry,
} from '../session/session-registry.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentStreamEvent,
  TaskDescriptor,
} from '../types.js'
import { mergeAbortSignals } from '../utils/abort-signal-helpers.js'

import type {
  ChatOptions,
  RunOptions,
  RunResult,
} from './orchestrator-facade-types.js'
import {
  buildChatInput,
  buildRunInput,
  buildRunTask,
  handleRunError,
} from './run-executor-helpers.js'

export function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

export interface RunCoordinatorDeps {
  registry: ProviderAdapterRegistry
  pipeline: AdapterPipeline
  bridge: EventBusBridge
  defaultPolicy: AdapterPolicy | undefined
  timeoutMs: number
}

/**
 * Execute a single run() invocation: prepare pipeline, build event stream,
 * iterate to completion, and translate errors to RunResult / ForgeError.
 */
export async function executeRun(
  prompt: string,
  options: RunOptions | undefined,
  deps: RunCoordinatorDeps,
): Promise<RunResult> {
  const startMs = Date.now()
  const timeoutMs = deps.timeoutMs
  const timeoutController = new AbortController()
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs)
  const merged = mergeAbortSignals(options?.signal, timeoutController.signal)

  const input = buildRunInput(prompt, options, merged.signal)
  const activePolicy = options?.policy ?? deps.defaultPolicy
  const task = buildRunTask(prompt, options)
  const policyProvider = resolvePolicyProvider({
    preferredProvider: options?.preferredProvider,
    activePolicy,
    task,
    registry: deps.registry,
  })
  await deps.pipeline.prepare({
    input,
    preferredProvider: policyProvider,
    policy: activePolicy,
    policyConformanceMode: options?.policyConformanceMode,
  })
  const executionTask: TaskDescriptor = {
    ...task,
    preferredProvider: policyProvider ?? task.preferredProvider,
  }

  let eventStream: AsyncGenerator<AgentEvent, void, undefined> =
    deps.registry.executeWithFallback(input, executionTask)
  eventStream = deps.bridge.bridge(eventStream)
  eventStream = deps.pipeline.wrapStream(eventStream, input, {
    prompt,
    providerId: policyProvider ?? options?.preferredProvider,
    approvalRunId: options?.approvalRunId,
    tags: options?.tags,
    requireApproval: options?.requireApproval,
  })

  let completion: AgentCompletedEvent | undefined
  let lastFailure: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

  try {
    for await (const event of eventStream) {
      if (event.type === 'adapter:completed') completion = event
      else if (event.type === 'adapter:failed') lastFailure = event
    }

    if (!completion) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: lastFailure?.error ?? 'No adapter:completed event observed for run()',
        recoverable: false,
        context: {
          source: 'OrchestratorFacade.run',
          providerId: lastFailure?.providerId,
          failureCode: lastFailure?.code,
        },
      })
    }

    return {
      result: completion.result,
      providerId: completion.providerId,
      durationMs: Date.now() - startMs,
      usage: completion.usage,
    }
  } catch (err) {
    return handleRunError(err, {
      registry: deps.registry,
      startMs,
      timeoutMs,
      timeoutAborted: timeoutController.signal.aborted,
      task: executionTask,
      lastFailure,
      completion,
    })
  } finally {
    clearTimeout(timeoutHandle)
    merged.cleanup?.()
  }
}

export interface ChatCoordinatorDeps {
  registry: ProviderAdapterRegistry
  pipeline: AdapterPipeline
  bridge: EventBusBridge
  sessions: SessionRegistry
  defaultPolicy: AdapterPolicy | undefined
}

/**
 * Resolve an existing workflow ID or create a fresh one when none is given.
 * Also reifies a workflow record when the caller supplies an unknown ID.
 */
export function resolveOrCreateWorkflow(
  sessions: SessionRegistry,
  workflowId: string | undefined,
): string {
  if (!workflowId) return sessions.createWorkflow()
  if (!sessions.getWorkflow(workflowId)) {
    sessions.createWorkflow(undefined, workflowId)
  }
  return workflowId
}

/**
 * Multi-turn chat dispatch — yields the raw provider stream so the caller
 * can decide whether to expose `adapter:provider_raw` events.
 */
export async function* executeChatWithRaw(
  prompt: string,
  options: ChatOptions | undefined,
  deps: ChatCoordinatorDeps,
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  const workflowId = resolveOrCreateWorkflow(deps.sessions, options?.workflowId)
  const input = buildChatInput(prompt, options)
  const activePolicy = options?.policy ?? deps.defaultPolicy
  const chatTask: TaskDescriptor = {
    prompt,
    tags: [],
    preferredProvider: options?.provider,
    workingDirectory: options?.workingDirectory,
  }
  const policyProvider = resolvePolicyProvider({
    preferredProvider: options?.provider,
    activePolicy,
    task: chatTask,
    registry: deps.registry,
  })

  await deps.pipeline.prepare({
    input,
    preferredProvider: policyProvider,
    policy: activePolicy,
    policyConformanceMode: options?.policyConformanceMode,
  })

  const multiTurnOptions: MultiTurnOptions = {
    workflowId,
    provider: policyProvider ?? options?.provider,
    includeHistory: options?.includeHistory ?? true,
  }

  let eventStream = deps.sessions.executeMultiTurnWithRaw(input, multiTurnOptions, deps.registry)
  eventStream = deps.bridge.bridgeWithRaw(eventStream, workflowId)
  eventStream = deps.pipeline.wrapStream(eventStream, input, {
    prompt,
    providerId: policyProvider ?? options?.provider,
    approvalRunId: options?.approvalRunId,
    requireApproval: options?.requireApproval,
  })

  yield* eventStream
}

function resolvePolicyProvider(args: {
  preferredProvider: AdapterProviderId | undefined
  activePolicy: AdapterPolicy | undefined
  task: TaskDescriptor
  registry: ProviderAdapterRegistry
}): AdapterProviderId | undefined {
  if (args.preferredProvider) return args.preferredProvider
  if (!args.activePolicy) return undefined
  return args.registry.getForTask(args.task).adapter.providerId
}
