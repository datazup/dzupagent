import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile,
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import {
  assertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission,
} from '../execution-control-admission.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'
import { prepareAdapterHardBudgetInput } from '../context/hard-budget-input.js'
import type { PreparedAdapterHardBudgetInput } from '../context/hard-budget-input.js'
import {
  buildOpenAIResponsesInputRequest,
  prepareAdapterHardBudgetInputWithProof,
  reconcileAdapterHardBudgetUsage,
  type ProvenAdapterHardBudgetInput,
} from '../hard-budget.js'
import {
  DEFAULT_MODEL,
  type OpenAIConfig,
  type OpenAIRawEvent,
  type OpenAIRunResult,
  type OpenAIToolWire,
} from './openai-types.js'
import {
  OpenAIToolCallAccumulator,
  projectOpenAITools,
  type OpenAIToolProjection,
} from './openai-tool-calls.js'
import {
  buildOpenAIMessages,
  emitOpenAIRunAudit,
  parseOpenAIResponsesSSE,
  parseOpenAISSE,
  postOpenAIResponses,
  postChatCompletions,
  resolveOpenAIApiKey,
  resolveOpenAIAuditErrorCode,
  runOpenAIResponsesNonStreaming,
} from './openai-http.js'

export type {
  OpenAIConfig,
  OpenAITransport,
  OpenAIRunResult,
  OpenAIToolDefinition,
  OpenAIToolWire,
} from './openai-types.js'

interface AdmittedOpenAIToolProjectionSnapshot {
  readonly admission: AdapterExecutionControlAdmission
  readonly projection: Readonly<OpenAIToolProjection>
  readonly requirementSha256: string
}

export class OpenAIAdapter implements AgentCLIAdapter, AdapterStreamSource<OpenAIRawEvent> {
  readonly providerId = 'openai' as const satisfies AdapterProviderId
  private currentController?: AbortController
  private currentSessionId = ''
  private currentModel = DEFAULT_MODEL
  private currentStartTime = 0
  private currentFullText = ''
  private toolCalls = new OpenAIToolCallAccumulator()
  private readonly admittedToolProjectionSnapshots = new WeakMap<
    AgentInput,
    AdmittedOpenAIToolProjectionSnapshot
  >()
  private readonly executingToolProjections = new WeakMap<
    AgentInput,
    Readonly<OpenAIToolProjection>
  >()

  constructor(private config: OpenAIConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      // Fetch adapter: surfaces tool_call deltas but does not execute tools
      // nor re-invoke the model. Not autonomous for tool-using tasks.
      emitsToolCalls: true,
      executesToolLoop: false,
      supportsStreaming: true,
      supportsCostUsage: true,
      supportsZeroToolDispatch: true,
      nativeToolControls: {
        mode: true,
        allowlist: true,
        blocklist: true,
      },
    }
  }

  admitExecutionControls(
    input: AgentInput,
    requirement: AdapterExecutionControlRequirement,
  ): AdapterExecutionControlAdmission {
    this.admittedToolProjectionSnapshots.delete(input)
    const projection = projectOpenAITools(input, requirement)
    const admitted = !Object.hasOwn(projection, 'tools')
      && !Object.hasOwn(projection, 'toolChoice')
    const admission = buildExecutionControlAdmission({
      providerId: 'openai',
      requirement,
      status: admitted ? 'admitted' : 'rejected',
      enforcement: admitted ? 'provider-pre-dispatch' : 'unsupported',
      ...(admitted
        ? {}
        : { blockers: ['zero_tool_dispatch_not_enforced'] }),
    })
    if (admission.status === 'admitted') {
      this.admittedToolProjectionSnapshots.set(input, {
        admission,
        projection,
        requirementSha256: admission.requirementSha256,
      })
    }
    return admission
  }

  async run(
    prompt: string,
    opts?: { systemPrompt?: string; model?: string; signal?: AbortSignal },
  ): Promise<OpenAIRunResult>
  async run(
    input: AgentInput,
    opts?: { systemPrompt?: string; model?: string; signal?: AbortSignal },
  ): Promise<OpenAIRunResult>
  async run(
    promptOrInput: string | AgentInput,
    opts: { systemPrompt?: string; model?: string; signal?: AbortSignal } = {},
  ): Promise<OpenAIRunResult> {
    const input: AgentInput = typeof promptOrInput === 'string'
      ? {
          prompt: promptOrInput,
          ...(opts.systemPrompt !== undefined
            ? { systemPrompt: opts.systemPrompt }
            : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }
      : promptOrInput
    const projection = this.resolveFinalToolProjection(input)
    resolveOpenAIApiKey(this.config)
    const model = opts.model
      ?? (input.options?.['model'] as string | undefined)
      ?? this.config.model
      ?? DEFAULT_MODEL
    const signal = opts.signal ?? input.signal
    const prepared = await this.prepareHardBudgetInput(
      input,
      model,
      projection,
    )
    if (this.transport === 'responses') {
      const inputRequest = prepared.budget
        ? buildOpenAIResponsesInputRequest(prepared.budget.request, projection)
        : buildOpenAIResponsesInputRequest({
            provider: 'openai',
            model,
            messages: buildOpenAIMessages(
              prepared.input.prompt,
              prepared.input.systemPrompt,
            ),
            ...projection,
          }, projection)
      const result = await runOpenAIResponsesNonStreaming({
        config: this.config,
        providerId: this.providerId,
        inputRequest,
        prompt: prepared.input.prompt,
        ...(prepared.input.systemPrompt !== undefined
          ? { systemPrompt: prepared.input.systemPrompt }
          : {}),
        ...(signal ? { signal } : {}),
      })
      this.reconcileUsage(prepared.budget, result.usage?.inputTokens)
      return result
    }
    return this.runChatNonStreaming(prepared.input, model, projection, signal)
  }

  async *chat(
    prompt: string,
    opts: {
      systemPrompt?: string
      model?: string
      signal?: AbortSignal
      workingDirectory?: string
    } = {},
  ): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.execute({
      prompt,
      systemPrompt: opts.systemPrompt,
      options: opts.model ? { model: opts.model } : undefined,
      signal: opts.signal,
      workingDirectory: opts.workingDirectory,
    })
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const projection = this.resolveFinalToolProjection(input)
    // Validate API key up-front so we throw a ForgeError synchronously
    // (preserves prior behaviour expected by callers).
    resolveOpenAIApiKey(this.config)

    this.currentSessionId = randomUUID()
    this.currentModel =
      (input.options?.['model'] as string | undefined) ?? this.config.model ?? DEFAULT_MODEL
    this.currentStartTime = Date.now()
    this.currentFullText = ''
    this.toolCalls.reset()

    const runner = new AdapterStreamRunner<OpenAIRawEvent>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: this.currentSessionId,
      startedExtra: {
        model: this.currentModel,
      },
      onAbortController: (ctrl) => {
        this.currentController = ctrl
      },
      ...(this.config.auditSink ? { auditSink: this.config.auditSink } : {}),
      auditModel: this.currentModel,
      ...(this.config.auditRunId !== undefined ? { auditRunId: this.config.auditRunId } : {}),
      ...(this.config.auditTenantId !== undefined ? { auditTenantId: this.config.auditTenantId } : {}),
    })

    this.executingToolProjections.set(input, projection)
    try {
      yield* runner.run(this, input, input.signal)
    } finally {
      this.executingToolProjections.delete(input)
      this.currentController = undefined
    }
  }

  // -----------------------------------------------------------------------
  // AdapterStreamSource<OpenAIRawEvent>
  // -----------------------------------------------------------------------

  async *open(input: AgentInput, signal: AbortSignal): AsyncIterable<OpenAIRawEvent> {
    const projection = this.executingToolProjections.get(input)
      ?? this.resolveFinalToolProjection(input)
    this.executingToolProjections.delete(input)
    const prepared = await this.prepareHardBudgetInput(
      input,
      this.currentModel,
      projection,
    )
    if (this.transport === 'responses') {
      yield* this.openResponses(
        prepared,
        this.currentModel,
        signal,
        projection,
      )
      return
    }
    const response = await postChatCompletions({
      config: this.config,
      messages: buildOpenAIMessages(
        prepared.input.prompt,
        prepared.input.systemPrompt,
      ),
      model: this.currentModel,
      stream: true,
      signal,
      ...this.mutableChatToolProjection(projection),
    })

    let usage: { inputTokens: number; outputTokens: number } | undefined

    for await (const chunk of parseOpenAISSE(response.body!, signal)) {
      yield { kind: 'sse', chunk }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
    }

    yield {
      kind: 'completed',
      fullText: this.currentFullText,
      ...(usage !== undefined ? { usage } : {}),
      durationMs: Date.now() - this.currentStartTime,
    }
  }

  mapRawEvent(raw: OpenAIRawEvent, context: StreamContext): AgentEvent | AgentEvent[] | null {
    // Ensure runner-context sessionId tracks our locally generated id so
    // adapter:started carries the same session as adapter:completed.
    if (!context.sessionId) {
      context.sessionId = this.currentSessionId
    }
    const input = context.input

    if (raw.kind === 'sse') {
      const choice = raw.chunk.choices?.[0]
      if (!choice) return null
      const result = this.toolCalls.processSseChoice(choice, this.providerId, input.correlationId)
      this.currentFullText += result.appendedContent
      if (result.events.length === 0) return null
      if (result.events.length === 1) return result.events[0]!
      return result.events
    }

    // raw.kind === 'completed' — flush any tool calls not closed by an
    // explicit `finish_reason='tool_calls'` marker (some providers omit it).
    const flushed = this.toolCalls.flush(this.providerId, input.correlationId)
    const completed: AgentEvent = {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId: this.currentSessionId,
      result: raw.fullText,
      durationMs: raw.durationMs,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
      timestamp: Date.now(),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }
    if (flushed.length === 0) return completed
    return [...flushed, completed]
  }

  async *resumeSession(
    _sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    this.resolveFinalToolProjection(input)
    throw new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'OpenAI adapter does not support session resume',
      recoverable: false,
      context: { providerId: 'openai', operation: 'resumeSession' },
    })
  }

  interrupt(): void {
    this.currentController?.abort()
  }

  async healthCheck(): Promise<HealthStatus> {
    const apiKey = this.config.apiKey ?? process.env['OPENAI_API_KEY']
    return {
      healthy: !!apiKey,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: false,
      lastError: apiKey ? undefined : 'No API key configured',
      monitorStatus: getDefaultMonitorStatus(this.providerId),
    }
  }

  configure(opts: Partial<OpenAIConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  private get transport(): NonNullable<OpenAIConfig['transport']> {
    return this.config.transport ?? 'chat-completions'
  }

  private async prepareHardBudgetInput(
    input: AgentInput,
    model: string,
    projection: Readonly<OpenAIToolProjection>,
  ): Promise<{
    input: AgentInput
    budget?: PreparedAdapterHardBudgetInput
  }> {
    if (!this.config.hardBudget) return { input }
    const args = {
      input,
      provider: this.providerId,
      model,
      ...projection,
      policy: this.config.hardBudget,
    }
    const budget = this.transport === 'responses'
      ? await prepareAdapterHardBudgetInputWithProof({
          ...args,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : prepareAdapterHardBudgetInput(args)
    return { input: budget.input, budget }
  }

  private async *openResponses(
    prepared: {
      input: AgentInput
      budget?: PreparedAdapterHardBudgetInput
    },
    model: string,
    signal: AbortSignal,
    projection: Readonly<OpenAIToolProjection>,
  ): AsyncGenerator<OpenAIRawEvent, void, undefined> {
    const inputRequest = prepared.budget
      ? buildOpenAIResponsesInputRequest(prepared.budget.request, projection)
      : buildOpenAIResponsesInputRequest({
          provider: 'openai',
          model,
          messages: buildOpenAIMessages(
            prepared.input.prompt,
            prepared.input.systemPrompt,
          ),
          ...projection,
        }, projection)
    const response = await postOpenAIResponses({
      config: this.config,
      inputRequest,
      stream: true,
      signal,
    })
    let usage: { inputTokens: number; outputTokens: number } | undefined
    let completed = false
    for await (const event of parseOpenAIResponsesSSE(response.body!, signal)) {
      if (event.kind === 'chunk') {
        yield { kind: 'sse', chunk: event.chunk }
      } else {
        completed = true
        usage = event.usage
      }
    }
    if (!completed) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: 'OpenAI Responses stream ended without a completed event',
        recoverable: false,
        context: { providerId: 'openai', reason: 'missing_completed_event' },
      })
    }
    this.reconcileUsage(prepared.budget, usage?.inputTokens)
    yield {
      kind: 'completed',
      fullText: this.currentFullText,
      ...(usage ? { usage } : {}),
      durationMs: Date.now() - this.currentStartTime,
    }
  }

  private resolveFinalToolProjection(
    input: AgentInput,
  ): Readonly<OpenAIToolProjection> {
    const storedSnapshot = this.takeAdmittedToolProjectionSnapshot(input)
    if (storedSnapshot !== undefined) {
      return this.validateStoredToolProjectionSnapshot(input, storedSnapshot)
        .projection
    }

    const admission = assertAdapterExecutionControlsAdmitted(this, input)
    return admission === undefined
      ? projectOpenAITools(input)
      : this.consumeAdmittedToolProjectionSnapshot(input, admission).projection
  }

  private validateStoredToolProjectionSnapshot(
    input: AgentInput,
    snapshot: AdmittedOpenAIToolProjectionSnapshot,
  ): AdmittedOpenAIToolProjectionSnapshot {
    const validationFacade = new Proxy(this, {
      get: (target, property, receiver) => {
        if (property === 'admitExecutionControls') {
          return () => snapshot.admission
        }
        if (property === 'getCapabilities') {
          return target.getCapabilities.bind(target)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const admission = assertAdapterExecutionControlsAdmitted(
      validationFacade,
      input,
    )
    if (
      admission === undefined
      || admission.requirementSha256 !== snapshot.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        snapshot.admission,
        'execution_control_request_snapshot_mismatch',
      )
    }
    return snapshot
  }

  private takeAdmittedToolProjectionSnapshot(
    input: AgentInput,
  ): AdmittedOpenAIToolProjectionSnapshot | undefined {
    const snapshot = this.admittedToolProjectionSnapshots.get(input)
    this.admittedToolProjectionSnapshots.delete(input)
    return snapshot
  }

  private consumeAdmittedToolProjectionSnapshot(
    input: AgentInput,
    admission: AdapterExecutionControlAdmission,
  ): AdmittedOpenAIToolProjectionSnapshot {
    const snapshot = this.takeAdmittedToolProjectionSnapshot(input)
    if (
      snapshot === undefined
      || snapshot.requirementSha256 !== admission.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        admission,
        'execution_control_request_snapshot_missing',
      )
    }
    return snapshot
  }

  private executionControlSnapshotError(
    admission: AdapterExecutionControlAdmission,
    blocker: 'execution_control_request_snapshot_mismatch'
      | 'execution_control_request_snapshot_missing',
  ): ForgeError {
    return new ForgeError({
      code: 'CAPABILITY_DENIED',
      message: 'OpenAI admission has no matching final tool projection',
      recoverable: false,
      context: {
        providerId: 'openai',
        executionControlBlocker: blocker,
        admission,
      },
    })
  }

  private async runChatNonStreaming(
    input: AgentInput,
    model: string,
    projection: Readonly<OpenAIToolProjection>,
    signal: AbortSignal | undefined,
  ): Promise<OpenAIRunResult> {
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    try {
      const response = await postChatCompletions({
        config: this.config,
        messages: buildOpenAIMessages(input.prompt, input.systemPrompt),
        model,
        stream: false,
        ...this.mutableChatToolProjection(projection),
        ...(signal ? { signal } : {}),
      })
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const content = data.choices?.[0]?.message?.content ?? ''
      const usage = data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined
      emitOpenAIRunAudit({
        config: this.config,
        providerId: this.providerId,
        prompt: input.prompt,
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
          : {}),
        model,
        status: 'completed',
        durationMs: Date.now() - startedAtMs,
        startedAt,
        ...(usage !== undefined ? { usage } : {}),
      })
      return usage ? { content, usage } : { content }
    } catch (error: unknown) {
      emitOpenAIRunAudit({
        config: this.config,
        providerId: this.providerId,
        prompt: input.prompt,
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
          : {}),
        model,
        status: 'failed',
        durationMs: Date.now() - startedAtMs,
        startedAt,
        errorCode: resolveOpenAIAuditErrorCode(error),
      })
      throw error
    }
  }

  private mutableChatToolProjection(
    projection: Readonly<OpenAIToolProjection>,
  ): { tools?: OpenAIToolWire[]; toolChoice?: unknown } {
    return {
      ...(projection.tools ? { tools: [...projection.tools] } : {}),
      ...(Object.hasOwn(projection, 'toolChoice')
        ? { toolChoice: projection.toolChoice }
        : {}),
    }
  }

  private reconcileUsage(
    prepared: PreparedAdapterHardBudgetInput | undefined,
    responseInputTokens: number | undefined,
  ): void {
    if (!prepared || !('requestProof' in prepared) || !this.config.hardBudget) {
      return
    }
    reconcileAdapterHardBudgetUsage({
      prepared: prepared as ProvenAdapterHardBudgetInput,
      ...(responseInputTokens !== undefined ? { responseInputTokens } : {}),
      policy: this.config.hardBudget,
    })
  }
}
