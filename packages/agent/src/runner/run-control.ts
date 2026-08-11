import type {
  AiExecutionCancellationAcknowledgement, AiExecutionCancellationRequest,
  AiExecutionInteractionAcknowledgement, AiExecutionInteractionSubmission,
  AiExecutionStartOptions, InlineAiExecutionHandle, InlineAiExecutionPort,
} from '@dzupagent/adapter-types'
import {
  AI_EXECUTION_EVENT_SCHEMA, type AiExecutionEvent, type AiExecutionReceipt,
  type AiExecutionRequest,
} from '@dzupagent/runtime-contracts/ai-execution'
import type {
  AgentPendingInteraction,
  AgentRunEventEnvelope,
} from '@dzupagent/agent-types/run'
import type {
  AgentRunnerInput,
  AgentRunnerResult,
  AgentRunnerResumeInput,
} from './runner-ports.js'
import {
  AgentRunnerInlineError, BoundedAgentRunnerEventQueue, agentRunnerInlineErrorCode,
  cloneDurableJson, createAgentRunnerCancellationRejection,
  createAgentRunnerInlineReceipt, createAgentRunnerInteractionRef,
  createAgentRunnerInteractionRejection,
  digestRunnerJson, parseAgentRunnerInlineDecision, projectAgentRunnerUsage,
  validateAgentRunnerInlineProjection, type AgentRunnerHostEventPayload,
  type AgentRunnerInlineProjection,
  type AgentRunnerInlinePhase, type AgentRunnerInteractionSubmissionRecord,
} from './runner-values.js'
import { RunControl } from './runner-control-state.js'
export {
  RunControl,
  type AgentRunnerSafePoint,
  type RunControlAcknowledgement,
  type RunControlObservation,
  type RunControlSafePointDecision,
} from './runner-control-state.js'
export type { AgentRunnerInlineProjection } from './runner-values.js'

interface AgentRunnerRuntime {
  stream(
    input: AgentRunnerInput,
    options?: { readonly control?: RunControl },
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult>
  resumeStream(
    input: AgentRunnerResumeInput,
    options?: { readonly control?: RunControl },
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult>
}
class AgentRunnerInlineHandle implements InlineAiExecutionHandle {
  readonly executionId: string
  readonly events: AsyncIterable<AiExecutionEvent>
  readonly completion: Promise<AiExecutionReceipt>
  readonly #queue = new BoundedAgentRunnerEventQueue()
  readonly #request: AiExecutionRequest
  readonly #projection: AgentRunnerInlineProjection
  readonly #runner: AgentRunnerRuntime
  readonly #now: () => string
  readonly #hostEvents: AiExecutionEvent[] = []
  readonly #submissions = new Map<string, AgentRunnerInteractionSubmissionRecord>()
  readonly #cancellations = new Map<string, AiExecutionCancellationAcknowledgement>()
  readonly #resolveCompletion: (receipt: AiExecutionReceipt) => void
  readonly #rejectCompletion: (error: unknown) => void
  #control = new RunControl()
  #phase: AgentRunnerInlinePhase = 'active'
  #pendingInteraction: AgentPendingInteraction | undefined
  #pendingInteractionRef: string | undefined
  #frameworkResult: AgentRunnerResult | undefined
  #frameworkStarted = false
  #startedAt = ''
  #terminalStatus: 'succeeded' | 'failed' | 'cancelled' | undefined
  #lastUsageDigest: string | undefined
  #signal: AbortSignal | undefined
  #abortListener: (() => void) | undefined

  constructor(
    runner: AgentRunnerRuntime,
    request: AiExecutionRequest,
    projection: AgentRunnerInlineProjection,
    now: () => string,
  ) {
    this.executionId = request.execution.requestId
    this.events = this.#queue
    this.#request = request
    this.#projection = projection
    this.#runner = runner
    this.#now = now
    let resolveCompletion = (_receipt: AiExecutionReceipt): void => undefined
    let rejectCompletion = (_error: unknown): void => undefined
    this.completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    this.#resolveCompletion = resolveCompletion
    this.#rejectCompletion = rejectCompletion
  }

  start(options: AiExecutionStartOptions | undefined): void {
    this.#startedAt = this.#now()
    this.#commitEvent(this.#createEvent({ type: 'started' }))
    this.#signal = options?.signal
    this.#abortListener = () => {
      if (this.#phase === 'active') this.#control.requestCancel()
    }
    if (this.#signal?.aborted === true) this.#abortListener()
    else this.#signal?.addEventListener('abort', this.#abortListener, { once: true })
    void this.#drive(this.#runner.stream(this.#projection.input, { control: this.#control }))
  }

  async cancel(
    request: AiExecutionCancellationRequest,
  ): Promise<AiExecutionCancellationAcknowledgement> {
    const existing = this.#cancellations.get(request.cancellationId)
    if (existing !== undefined) return cloneDurableJson(existing)
    const acknowledgedAt = this.#now()
    let acknowledgement: AiExecutionCancellationAcknowledgement
    if (request.executionId !== this.executionId || request.cancellationId.length === 0 ||
        !Number.isFinite(Date.parse(request.requestedAt))) {
      acknowledgement = createAgentRunnerCancellationRejection(
        request, this.executionId, acknowledgedAt, 'invalid-cancellation')
    } else if (this.#phase === 'terminal') {
      acknowledgement = {
        cancellationId: request.cancellationId,
        executionId: this.executionId,
        status: 'already-terminal',
        acknowledgedAt,
        terminalStatus: this.#terminalStatus ?? 'failed',
      }
    } else if (this.#phase === 'suspended') {
      acknowledgement = createAgentRunnerCancellationRejection(
        request, this.executionId, acknowledgedAt, 'suspended-cancellation-unsupported')
    } else {
      const control = this.#control.requestCancel()
      acknowledgement = control.accepted
        ? {
            cancellationId: request.cancellationId,
            executionId: this.executionId,
            status: 'requested',
            acknowledgedAt,
          }
        : createAgentRunnerCancellationRejection(
          request, this.executionId, acknowledgedAt, `control-${control.reason}`)
    }
    this.#cancellations.set(request.cancellationId, cloneDurableJson(acknowledgement))
    return cloneDurableJson(acknowledgement)
  }

  async submitInteraction(
    submission: AiExecutionInteractionSubmission,
  ): Promise<AiExecutionInteractionAcknowledgement> {
    let digest: string
    try {
      digest = digestRunnerJson(submission)
    } catch {
      return createAgentRunnerInteractionRejection(
        submission, this.executionId, this.#now(), 'invalid-submission')
    }
    const existing = this.#submissions.get(submission.submissionId)
    if (existing !== undefined) {
      if (existing.digest !== digest) return createAgentRunnerInteractionRejection(
        submission, this.executionId, this.#now(), 'submission-conflict')
      if (existing.acknowledgement.status === 'accepted') {
        return { ...existing.acknowledgement, status: 'duplicate', acknowledgedAt: this.#now() }
      }
      return cloneDurableJson(existing.acknowledgement)
    }
    if (submission.executionId !== this.executionId || submission.submissionId.length === 0 ||
        !Number.isFinite(Date.parse(submission.submittedAt))) {
      return this.#retainRejectedSubmission(submission, digest, 'invalid-submission')
    }
    const interaction = this.#pendingInteraction
    const interactionRef = this.#pendingInteractionRef
    if (this.#phase !== 'suspended' || interaction === undefined || interactionRef === undefined) {
      return this.#retainRejectedSubmission(submission, digest, 'interaction-not-pending')
    }
    let decision
    try {
      decision = parseAgentRunnerInlineDecision(submission, interaction, interactionRef)
    } catch {
      return this.#retainRejectedSubmission(submission, digest, 'invalid-interaction-decision')
    }
    const acknowledgement: AiExecutionInteractionAcknowledgement = {
      executionId: this.executionId,
      interactionRef,
      submissionId: submission.submissionId,
      status: 'accepted',
      acknowledgedAt: this.#now(),
    }
    this.#submissions.set(submission.submissionId, { digest, acknowledgement })
    this.#pendingInteraction = undefined
    this.#pendingInteractionRef = undefined
    this.#phase = 'active'
    this.#control = new RunControl()
    void this.#drive(this.#runner.resumeStream({
      runId: this.#frameworkResult?.state.runId ?? '',
      behaviorDigest: this.#projection.input.behaviorDigest,
      decision,
    }, { control: this.#control }))
    return cloneDurableJson(acknowledgement)
  }

  async #drive(
    stream: AsyncGenerator<unknown, AgentRunnerResult>,
  ): Promise<void> {
    try {
      let step = await stream.next()
      while (!step.done) {
        const event = step.value as { readonly type?: string }
        if (event.type === 'run.started') this.#frameworkStarted = true
        step = await stream.next()
      }
      const result = step.value
      this.#frameworkResult = result
      this.#emitUsage(result)
      if (result.state.status === 'suspended') {
        const interaction = result.state.interactions[0]
        if (interaction === undefined) throw new AgentRunnerInlineError('interaction-missing', [])
        const interactionRef = createAgentRunnerInteractionRef(this.executionId, result, interaction)
        this.#phase = 'suspended'
        this.#pendingInteraction = interaction
        this.#pendingInteractionRef = interactionRef
        this.#commitEvent(this.#createEvent({
          type: 'interaction.required',
          interactionRef,
        }))
        return
      }
      if (!['completed', 'failed', 'cancelled'].includes(result.state.status)) {
        throw new AgentRunnerInlineError('runner-non-terminal', [])
      }
      this.#complete(result)
    } catch (error) {
      this.#fail(error)
    }
  }

  #complete(result: AgentRunnerResult): void {
    const status = result.state.status === 'completed' ? 'succeeded' : result.state.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
      throw new AgentRunnerInlineError('runner-status-invalid', [])
    }
    const terminal = this.#createEvent({ type: 'completed', status })
    const completedAt = terminal.emittedAt
    const receipt = createAgentRunnerInlineReceipt({
      request: this.#request,
      projection: this.#projection,
      result,
      events: [...this.#hostEvents, terminal],
      status,
      ...(status === 'succeeded' ? {} : {
        errorCode: agentRunnerInlineErrorCode(undefined, result, `inline-runner-${status}`),
      }),
      startedAt: this.#startedAt,
      completedAt,
      frameworkStarted: this.#frameworkStarted,
    })
    this.#finish(terminal, receipt, status)
  }

  #fail(error: unknown): void {
    if (this.#phase === 'terminal') return
    try {
      const terminal = this.#createEvent({ type: 'completed', status: 'failed' })
      const receipt = createAgentRunnerInlineReceipt({
        request: this.#request,
        projection: this.#projection,
        ...(this.#frameworkResult === undefined ? {} : { result: this.#frameworkResult }),
        events: [...this.#hostEvents, terminal],
        status: 'failed',
        errorCode: agentRunnerInlineErrorCode(error),
        startedAt: this.#startedAt,
        completedAt: terminal.emittedAt,
        frameworkStarted: this.#frameworkStarted,
      })
      this.#finish(terminal, receipt, 'failed')
    } catch (receiptError) {
      this.#phase = 'terminal'
      this.#cleanup()
      this.#queue.fail(receiptError)
      this.#rejectCompletion(receiptError)
    }
  }

  #finish(
    terminal: AiExecutionEvent,
    receipt: AiExecutionReceipt,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): void {
    this.#commitEvent(terminal)
    this.#phase = 'terminal'
    this.#terminalStatus = status
    this.#cleanup()
    this.#queue.close()
    this.#resolveCompletion(receipt)
  }

  #emitUsage(result: AgentRunnerResult): void {
    const usage = projectAgentRunnerUsage(result.state)
    if (usage.measurement === 'unknown') return
    const digest = digestRunnerJson(usage)
    if (digest === this.#lastUsageDigest) return
    this.#lastUsageDigest = digest
    this.#commitEvent(this.#createEvent({ type: 'usage', usage }))
  }

  #createEvent(payload: AgentRunnerHostEventPayload): AiExecutionEvent {
    const sequence = this.#hostEvents.length + 1
    return {
      schema: AI_EXECUTION_EVENT_SCHEMA,
      requestId: this.#request.execution.requestId,
      correlationId: this.#request.execution.correlationId,
      sequence,
      cursor: `inline:${this.executionId}:${sequence}`,
      attempt: 1,
      emittedAt: this.#now(),
      ...payload,
    }
  }

  #commitEvent(event: AiExecutionEvent): void {
    const durable = cloneDurableJson(event)
    this.#queue.push(durable)
    this.#hostEvents.push(durable)
  }

  #retainRejectedSubmission(
    submission: AiExecutionInteractionSubmission,
    digest: string,
    reason: string,
  ): AiExecutionInteractionAcknowledgement {
    const acknowledgement = createAgentRunnerInteractionRejection(
      submission, this.executionId, this.#now(), reason)
    this.#submissions.set(submission.submissionId, { digest, acknowledgement })
    return acknowledgement
  }

  #cleanup(): void {
    if (this.#signal !== undefined && this.#abortListener !== undefined) {
      this.#signal.removeEventListener('abort', this.#abortListener)
    }
    this.#abortListener = undefined
    this.#signal = undefined
    this.#pendingInteraction = undefined
    this.#pendingInteractionRef = undefined
  }
}
export function createInlineAgentRunnerExecutionPort(
  runner: AgentRunnerRuntime,
  project: (request: AiExecutionRequest) => AgentRunnerInlineProjection,
  now: () => string = () => new Date().toISOString(),
): InlineAiExecutionPort {
  const toolIds = Reflect.get(runner, Symbol.for('@dzupagent/runner.tools')) as readonly string[]
  return {
    start(request, options) {
      let projection: AgentRunnerInlineProjection
      try {
        projection = validateAgentRunnerInlineProjection(request, toolIds, () => project(request))
      } catch (error) {
        if (error instanceof AgentRunnerInlineError) throw error
        throw new AgentRunnerInlineError('projection-failed', [{
          code: 'AI_INVALID_VALUE',
          path: 'projection',
          message: 'Host projection failed before inline runner dispatch.',
        }])
      }
      const handle = new AgentRunnerInlineHandle(runner, request, projection, now)
      handle.start(options)
      return handle
    },
  }
}
