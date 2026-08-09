import { randomUUID } from 'node:crypto'

import type {
  AgentEventJournal,
  AgentRunnerModelPort,
  AgentRunnerModelResult,
  AgentRunnerInput,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolResult,
  AgentRunStore,
} from './runner-ports.js'
import {
  type AgentItem,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
  type AgentToolInvocationState,
  type AgentUsageRecord,
} from '@dzupagent/agent-types/run'

import { assertDurableJson } from './durable-json.js'
import {
  createInitialAgentRunState,
  digestRunnerJson,
  InMemoryAgentEventJournal,
  InMemoryAgentRunStore,
  isToolCall,
  replaceInvocation,
} from './in-memory-persistence.js'
import { checkpointRun, failRun } from './runner-lifecycle.js'
import { RunControl } from './run-control.js'
import {
  AgentRunnerPersistenceError,
  AgentRunnerTransitionCommitter,
} from './runner-transition-committer.js'

export type AgentRunnerIdentityKind =
  | 'event'
  | 'invocation'
  | 'model-request'
  | 'run'
  | 'tool-result-item'
  | 'usage'

export interface InMemoryAgentRunnerConfig {
  readonly model: AgentRunnerModelPort
  readonly tools?: readonly AgentRunnerReadOnlyToolPort[]
  readonly store?: AgentRunStore
  readonly journal?: AgentEventJournal
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
  readonly #store: AgentRunStore
  readonly #transitions: AgentRunnerTransitionCommitter
  readonly #createId: (kind: AgentRunnerIdentityKind) => string
  readonly #now: () => string
  readonly #maxModelTurns: number
  readonly #maxToolAttempts: number

  constructor(config: InMemoryAgentRunnerConfig) {
    this.#model = config.model
    this.#tools = new Map((config.tools ?? []).map((tool) => [tool.toolId, tool]))
    this.#store = config.store ?? new InMemoryAgentRunStore()
    const journal = config.journal ?? new InMemoryAgentEventJournal()
    this.#createId = config.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#maxModelTurns = config.maxModelTurns ?? 4
    this.#maxToolAttempts = config.maxToolAttempts ?? 2
    this.#transitions = new AgentRunnerTransitionCommitter({
      store: this.#store,
      journal,
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
      throw new TypeError('AgentRunner R3 tools must be unique read-only tools')
    }
  }

  async run(input: AgentRunnerInput, options: AgentRunnerOptions = {}): Promise<AgentRunnerResult> {
    const execution = this.stream(input, options)
    let step = await execution.next()
    while (!step.done) step = await execution.next()
    return step.value
  }

  stream(
    input: AgentRunnerInput,
    options: AgentRunnerOptions = {},
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    return this.#execute(input, options.control ?? new RunControl())
  }

  async *#execute(
    input: AgentRunnerInput,
    control: RunControl,
  ): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerResult> {
    const events: AgentRunEventEnvelope[] = []
    let state = createInitialAgentRunState(input, this.#createId('run'), this.#now())
    const created = await this.#store.create(state)
    if (created.status !== 'created') {
      throw new AgentRunnerPersistenceError('run-create-conflict')
    }
    state = created.state

    let committed = await this.#transitions.commit(state, 'run.started', { status: 'running' }, (current) => ({
      ...current,
      status: 'running',
    }))
    state = committed.state
    events.push(committed.event)
    yield committed.event

    let turn = 0
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
      committed = await this.#transitions.commit(
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

        committed = await this.#transitions.commit(
          state,
          'run.completed',
          { status: 'completed', finalItemId: modelResult.item.itemId },
          (current) => ({ ...current, status: 'completed' }),
        )
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

      let toolCompleted = false
      while (invocation.attempt <= this.#maxToolAttempts) {
        const beforeTool = yield* checkpointRun(
          state,
          control,
          'before-tool-dispatch',
          events,
          this.#transitions,
        )
        state = beforeTool.state
        if (beforeTool.cancelled) return { state, events }

        invocation = { ...invocation, state: 'started' }
        committed = await this.#transitions.commit(
          state,
          'tool.started',
          { invocationId, callId: invocation.callId, executionAttempt: invocation.attempt },
          (current) => ({
            ...current,
            invocations: replaceInvocation(current, invocation),
          }),
        )
        state = committed.state
        events.push(committed.event)
        yield committed.event

        let toolResult: AgentRunnerReadOnlyToolResult
        try {
          toolResult = await tool.execute({
            runId: state.runId,
            invocationId,
            callId: invocation.callId,
            attempt: invocation.attempt,
            input: modelResult.item.arguments,
          })
          assertDurableJson(toolResult)
        } catch {
          invocation = { ...invocation, state: 'effect-unknown' }
          committed = await this.#transitions.commit(
            state,
            'tool.failed',
            {
              invocationId,
              executionAttempt: invocation.attempt,
              outcome: 'effect-unknown',
            },
            (current) => ({
              ...current,
              invocations: replaceInvocation(current, invocation),
            }),
          )
          state = committed.state
          events.push(committed.event)
          yield committed.event
          return yield* failRun(
            state,
            control,
            events,
            'tool-outcome-unknown',
            this.#transitions,
          )
        }

        if (toolResult.status === 'failed-before-effect') {
          invocation = { ...invocation, state: 'failed-before-effect' }
          committed = await this.#transitions.commit(
            state,
            'tool.failed',
            {
              invocationId,
              executionAttempt: invocation.attempt,
              outcome: 'failed-before-effect',
              code: toolResult.code,
              retryable: toolResult.retryable,
            },
            (current) => ({
              ...current,
              invocations: replaceInvocation(current, invocation),
            }),
          )
          state = committed.state
          events.push(committed.event)
          yield committed.event

          if (!toolResult.retryable || invocation.attempt >= this.#maxToolAttempts) {
            return yield* failRun(
              state,
              control,
              events,
              'tool-failed-before-effect',
              this.#transitions,
            )
          }
          invocation = { ...invocation, attempt: invocation.attempt + 1 }
          continue
        }

        const resultDigest = digestRunnerJson(toolResult.output)
        invocation = {
          ...invocation,
          state: 'completed',
          resultDigest,
          completionEvidence: toolResult.completionEvidence ?? { resultDigest },
        }
        committed = await this.#transitions.commit(
          state,
          'tool.completed',
          {
            invocationId,
            executionAttempt: invocation.attempt,
            resultDigest,
            effectClass: 'read',
          },
          (current) => ({
            ...current,
            invocations: replaceInvocation(current, invocation),
          }),
        )
        state = committed.state
        events.push(committed.event)
        yield committed.event

        const toolResultItem: AgentItem = {
          type: 'tool-result',
          itemId: this.#createId('tool-result-item'),
          callId: invocation.callId,
          output: toolResult.output,
          isError: false,
        }
        committed = await this.#transitions.commit(
          state,
          'item.added',
          { itemId: toolResultItem.itemId, itemType: toolResultItem.type },
          (current) => ({
            ...current,
            committedItems: [...current.committedItems, toolResultItem],
          }),
        )
        state = committed.state
        events.push(committed.event)
        yield committed.event
        toolCompleted = true

        const afterTool = yield* checkpointRun(
          state,
          control,
          'after-tool-dispatch',
          events,
          this.#transitions,
        )
        state = afterTool.state
        if (afterTool.cancelled) return { state, events }
        break
      }

      if (!toolCompleted) {
        return yield* failRun(state, control, events, 'tool-attempt-limit', this.#transitions)
      }
    }

    return yield* failRun(state, control, events, 'model-turn-limit', this.#transitions)
  }

}
