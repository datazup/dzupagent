import { randomUUID } from 'node:crypto'

import type {
  AgentRunnerModelPort,
  AgentRunnerModelResult,
  AgentRunnerInput,
  AgentRunnerPersistence,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerResumeInput,
} from './runner-ports.js'
import {
  type AgentInteractionDecisionRecord,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
  type AgentToolCallItem,
  type AgentToolInvocationState,
  type AgentUsageRecord,
} from '@dzupagent/agent-types/run'

import { assertDurableJson, digestRunnerJson } from './runner-values.js'
import {
  InMemoryAgentRunnerPersistence,
  isToolCall,
  replaceInvocation,
} from './in-memory-persistence.js'
import {
  AgentRunnerResumeError,
  assertStateJournalConsistency,
  assertValidDecision,
  assertValidResumeState,
  decisionsMatch,
} from './runner-transition-committer.js'
import {
  checkpointRun,
  collectAgentRunnerExecution,
  continueApprovedAgentRun,
  executeAgentRunnerTool,
  failRun,
  suspendAgentRunForApproval,
  validateDecisionBinding,
} from './runner-lifecycle.js'
import { RunControl } from './run-control.js'
import { AgentRunnerSessionError, AgentRunnerTransitionCommitter, startAgentRun } from './runner-transition-committer.js'

export type AgentRunnerIdentityKind =
  | 'event'
  | 'interaction'
  | 'interaction-item'
  | 'invocation'
  | 'model-request'
  | 'run'
  | 'tool-result-item'
  | 'usage'

export interface InMemoryAgentRunnerConfig {
  readonly model: AgentRunnerModelPort
  readonly tools?: readonly AgentRunnerReadOnlyToolPort[]
  readonly persistence?: InMemoryAgentRunnerPersistence
  readonly createId?: (kind: AgentRunnerIdentityKind) => string
  readonly now?: () => string
  readonly maxModelTurns?: number
  readonly maxToolAttempts?: number
}

export interface AgentRunnerOptions {
  readonly control?: RunControl
}

export interface AgentRunnerResult {
  readonly state: AgentRunStateV2
  readonly events: readonly AgentRunEventEnvelope[]
}

export class InMemoryAgentRunner {
  readonly #model: AgentRunnerModelPort
  readonly #tools: ReadonlyMap<string, AgentRunnerReadOnlyToolPort>
  readonly #persistence: AgentRunnerPersistence
  readonly #transitions: AgentRunnerTransitionCommitter
  readonly #createId: (kind: AgentRunnerIdentityKind) => string
  readonly #now: () => string
  readonly #maxModelTurns: number
  readonly #maxToolAttempts: number

  constructor(config: InMemoryAgentRunnerConfig) {
    this.#model = config.model
    this.#tools = new Map((config.tools ?? []).map((tool) => [tool.toolId, tool]))
    this.#persistence = config.persistence ?? new InMemoryAgentRunnerPersistence()
    this.#createId = config.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxModelTurns = config.maxModelTurns ?? 4
    this.#maxToolAttempts = config.maxToolAttempts ?? 2
    this.#transitions = new AgentRunnerTransitionCommitter({
      persistence: this.#persistence,
      createEventId: () => this.#createId('event'),
      now: this.#now,
    })

    if (
      !Number.isSafeInteger(this.#maxModelTurns) ||
      this.#maxModelTurns < 1 ||
      !Number.isSafeInteger(this.#maxToolAttempts) ||
      this.#maxToolAttempts < 1
    ) {
      throw new RangeError('AgentRunner limits must be positive integers')
    }

    if (
      this.#tools.size !== (config.tools ?? []).length ||
      [...this.#tools.values()].some((tool) => tool.effectClass !== 'read')
    ) {
      throw new TypeError('AgentRunner tools must be unique read-only tools')
    }
  }

  async run(input: AgentRunnerInput, options: AgentRunnerOptions = {}): Promise<AgentRunnerResult> {
    return collectAgentRunnerExecution(this.stream(input, options))
  }

  stream(
    input: AgentRunnerInput,
    options: AgentRunnerOptions = {},
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    const control = options.control ?? new RunControl()
    return startAgentRun({
      input,
      persistence: this.#persistence,
      transitions: this.#transitions,
      runId: this.#createId('run'),
      now: this.#now(),
      continueRun: (state, events) => this.#drive(state, control, events, 0),
    })
  }

  async resume(
    input: AgentRunnerResumeInput,
    options: AgentRunnerOptions = {},
  ): Promise<AgentRunnerResult> {
    return collectAgentRunnerExecution(this.resumeStream(input, options))
  }

  resumeStream(
    input: AgentRunnerResumeInput,
    options: AgentRunnerOptions = {},
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    return this.#executeResume(input, options.control ?? new RunControl())
  }

  async *#executeResume(
    input: AgentRunnerResumeInput,
    control: RunControl,
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    const loaded: unknown = await this.#persistence.loadRun(input.runId)
    if (loaded === undefined) throw new AgentRunnerResumeError('run-not-found')
    assertValidResumeState(loaded)
    let state = loaded
    const events = [...(await this.#persistence.readEvents(input.runId))]
    assertStateJournalConsistency(state, events)
    assertValidDecision(input.decision)

    if (state.agent.behaviorDigest !== input.behaviorDigest) {
      throw new AgentRunnerResumeError('behavior-mismatch')
    }
    const priorDecision = state.interactionDecisions.find(
      (decision) =>
        decision.interactionId === input.decision.interactionId &&
        decision.generation === input.decision.generation,
    )
    await this.#transitions.assertResumableSession(state, priorDecision?.decision === 'rejected')
    let approvedInvocationId: string
    if (priorDecision !== undefined) {
      if (!decisionsMatch(priorDecision, input.decision)) {
        throw new AgentRunnerResumeError('decision-conflict')
      }
      if (state.status !== 'suspended') {
        throw new AgentRunnerResumeError('decision-already-applied')
      }
      if (priorDecision.decision === 'rejected') {
        return yield* failRun(
          state,
          control,
          events,
          'interaction-rejected',
          this.#transitions,
        )
      }
      approvedInvocationId = priorDecision.invocationId
    } else {
      if (state.status !== 'suspended') throw new AgentRunnerResumeError('not-suspended')
      const interaction = state.interactions.find(
        (entry) => entry.interactionId === input.decision.interactionId,
      )
      if (interaction === undefined) throw new AgentRunnerResumeError('interaction-not-found')
      validateDecisionBinding(state, interaction, input.decision, this.#now)

      const invocation = state.invocations.find(
        (entry) => entry.invocationId === interaction.invocationId,
      )
      if (invocation === undefined || invocation.state !== 'approval-required') {
        throw new AgentRunnerResumeError('interaction-not-found')
      }
      const tool = this.#tools.get(invocation.toolId)
      if (tool === undefined) throw new AgentRunnerResumeError('tool-not-found')
      if (tool.toolRevision !== invocation.toolRevision) {
        throw new AgentRunnerResumeError('tool-revision-mismatch')
      }
      const toolCall = state.committedItems.find(
        (item): item is AgentToolCallItem =>
          item.type === 'tool-call' &&
          item.callId === invocation.callId &&
          item.toolId === invocation.toolId,
      )
      if (toolCall === undefined) throw new AgentRunnerResumeError('tool-call-not-found')

      const decisionRecord: AgentInteractionDecisionRecord = {
        ...input.decision,
        invocationId: invocation.invocationId,
        decidedAt: this.#now(),
      }
      const decidedInvocation: AgentToolInvocationState = {
        ...invocation,
        state: input.decision.decision === 'approved' ? 'approved' : 'rejected',
      }
      const resolved = await this.#transitions.commit(
        state,
        'interaction.resolved',
        {
          interactionId: interaction.interactionId,
          generation: interaction.generation,
          invocationId: invocation.invocationId,
          decision: input.decision.decision,
          actorId: input.decision.actor.principalId,
          actorType: input.decision.actor.principalType,
        },
        (current) => ({
          ...current,
          invocations: replaceInvocation(current, decidedInvocation),
          interactions: current.interactions.filter(
            (entry) => entry.interactionId !== interaction.interactionId,
          ),
          interactionDecisions: [...current.interactionDecisions, decisionRecord],
          committedItems: current.committedItems.map((item) =>
            item.type === 'interaction' && item.interactionId === interaction.interactionId
              ? { ...item, state: 'resolved' }
              : item,
          ),
        }),
      )
      state = resolved.state
      events.push(resolved.event)
      yield resolved.event
      if (input.decision.decision === 'rejected') {
        return yield* failRun(
          state,
          control,
          events,
          'interaction-rejected',
          this.#transitions,
        )
      }
      approvedInvocationId = invocation.invocationId
    }

    const executed = yield* continueApprovedAgentRun({
      state,
      control,
      events,
      invocationId: approvedInvocationId,
      tools: this.#tools,
      maxToolAttempts: this.#maxToolAttempts,
      createToolResultItemId: () => this.#createId('tool-result-item'),
      transitions: this.#transitions,
    })
    state = executed.state
    if (executed.terminal) return { state, events }

    const completedModelTurns = events.filter((event) => event.type === 'model.requested').length
    return yield* this.#drive(state, control, events, completedModelTurns)
  }

  async *#drive(
    initialState: AgentRunStateV2,
    control: RunControl,
    events: AgentRunEventEnvelope[],
    initialTurn: number,
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    let state = initialState
    let turn = initialTurn
    while (turn < this.#maxModelTurns) {
      const beforeModel = yield* checkpointRun(
        state,
        control,
        'before-model-dispatch',
        events,
        this.#transitions,
      )
      state = beforeModel.state
      if (beforeModel.cancelled) return { state, events }

      turn += 1
      const requestId = this.#createId('model-request')
      let committed = await this.#transitions.commit(
        state,
        'model.requested',
        { requestId, turn },
        (current) => current,
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event

      let modelResult: AgentRunnerModelResult
      try {
        modelResult = await this.#model.invoke({
          runId: state.runId,
          requestId,
          attempt: state.attempt.number,
          turn,
          agentId: state.agent.currentAgentId,
          input: state.input,
          committedItems: state.committedItems,
          tools: [...this.#tools.values()].map((tool) => ({
            toolId: tool.toolId,
            toolRevision: tool.toolRevision,
            effectClass: tool.effectClass,
          })),
        })
        assertDurableJson(modelResult)
      } catch {
        committed = await this.#transitions.commit(
          state,
          'model.failed',
          { requestId, code: 'model-invocation-failed' },
          (current) => current,
        )
        state = committed.state
        events.push(committed.event)
        yield committed.event
        return yield* failRun(
          state,
          control,
          events,
          'model-invocation-failed',
          this.#transitions,
        )
      }

      committed = await this.#transitions.commit(
        state,
        'model.completed',
        { requestId, turn, itemType: modelResult.item.type },
        (current) => current,
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event

      if (modelResult.usage !== undefined) {
        const usage: AgentUsageRecord = {
          usageId: this.#createId('usage'),
          source: 'model',
          accountingSource: modelResult.usage.accountingSource,
          recordedAt: this.#now(),
          ...(modelResult.usage.inputTokens === undefined
            ? {}
            : { inputTokens: modelResult.usage.inputTokens }),
          ...(modelResult.usage.outputTokens === undefined
            ? {}
            : { outputTokens: modelResult.usage.outputTokens }),
          ...(modelResult.usage.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: modelResult.usage.cacheReadTokens }),
          ...(modelResult.usage.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: modelResult.usage.cacheWriteTokens }),
        }
        committed = await this.#transitions.commit(
          state,
          'usage.recorded',
          { usageId: usage.usageId, accountingSource: usage.accountingSource },
          (current) => ({
            ...current,
            usage: { records: [...current.usage.records, usage] },
          }),
        )
        state = committed.state
        events.push(committed.event)
        yield committed.event
      }

      committed = await this.#transitions.commit(
        state,
        'item.added',
        { itemId: modelResult.item.itemId, itemType: modelResult.item.type },
        (current) => ({
          ...current,
          committedItems: [...current.committedItems, modelResult.item],
        }),
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event

      if (!isToolCall(modelResult.item)) {
        const afterModel = yield* checkpointRun(
          state,
          control,
          'after-model-dispatch',
          events,
          this.#transitions,
        )
        state = afterModel.state
        if (afterModel.cancelled) return { state, events }

        try {
          committed = await this.#transitions.complete(state, modelResult.item.itemId)
        } catch (error) {
          if (error instanceof AgentRunnerSessionError) {
            return yield* failRun(
              state,
              control,
              events,
              `session-${error.code}`,
              this.#transitions,
            )
          }
          throw error
        }
        state = committed.state
        events.push(committed.event)
        yield committed.event
        control.markTerminal()
        return { state, events }
      }

      const tool = this.#tools.get(modelResult.item.toolId)
      if (tool === undefined) {
        return yield* failRun(state, control, events, 'tool-not-found', this.#transitions)
      }

      const invocationId = this.#createId('invocation')
      let invocation: AgentToolInvocationState = {
        invocationId,
        callId: modelResult.item.callId,
        attempt: 1,
        inputDigest: digestRunnerJson(modelResult.item.arguments),
        toolId: tool.toolId,
        toolRevision: tool.toolRevision,
        effectClass: 'read',
        state: 'planned',
      }
      committed = await this.#transitions.commit(
        state,
        'tool.selected',
        {
          invocationId,
          callId: invocation.callId,
          toolId: invocation.toolId,
          inputDigest: invocation.inputDigest,
        },
        (current) => ({ ...current, invocations: [...current.invocations, invocation] }),
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event

      if (tool.approval !== undefined) {
        const suspended = yield* suspendAgentRunForApproval({
          state,
          events,
          invocation,
          toolCall: modelResult.item,
          tool,
          interactionId: this.#createId('interaction'),
          interactionItemId: this.#createId('interaction-item'),
          transitions: this.#transitions,
        })
        return { state: suspended, events }
      }

      const executed = yield* executeAgentRunnerTool({
        state,
        control,
        events,
        tool,
        invocation,
        input: modelResult.item.arguments,
        maxToolAttempts: this.#maxToolAttempts,
        createToolResultItemId: () => this.#createId('tool-result-item'),
        transitions: this.#transitions,
      })
      state = executed.state
      if (executed.terminal) return { state, events }
    }

    return yield* failRun(state, control, events, 'model-turn-limit', this.#transitions)
  }

}
