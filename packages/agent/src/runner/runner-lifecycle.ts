import type {
  AgentItem,
  AgentPendingInteraction,
  AgentRunEventEnvelope,
  AgentRunJsonValue,
  AgentRunStateV2,
  AgentToolCallItem,
  AgentToolInvocationState,
} from '@dzupagent/agent-types/run'

import type { AgentRunnerSafePoint, RunControl } from './run-control.js'
import type {
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolResult,
} from './runner-ports.js'
import type { AgentRunnerTransitionCommitter } from './runner-transition-committer.js'
import { AgentRunnerResumeError } from './runner-transition-committer.js'
import { replaceInvocation } from './in-memory-persistence.js'
import { assertDurableJson, digestRunnerJson } from './runner-values.js'

/** @internal */
export interface AgentRunnerCheckpointResult {
  readonly state: AgentRunStateV2
  readonly cancelled: boolean
}

/** @internal */
export interface AgentRunnerTerminalResult {
  readonly state: AgentRunStateV2
  readonly events: readonly AgentRunEventEnvelope[]
}

/** @internal */
export async function* checkpointRun(
  state: AgentRunStateV2,
  control: RunControl,
  safePoint: AgentRunnerSafePoint,
  events: AgentRunEventEnvelope[],
  transitions: AgentRunnerTransitionCommitter,
): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerCheckpointResult> {
  let decision = control.observeAtSafePoint(safePoint)
  if (decision.action === 'continue') return { state, cancelled: false }

  if (decision.action === 'cancel') {
    await transitions.abortSession(state)
    const cancelled = await transitions.commit(
      state,
      'run.cancelled',
      { requestId: decision.requestId, observedAt: safePoint },
      (current) => ({ ...current, status: 'cancelled' }),
    )
    events.push(cancelled.event)
    yield cancelled.event
    control.markTerminal()
    return { state: cancelled.state, cancelled: true }
  }

  const suspended = await transitions.commit(
    state,
    'run.suspended',
    { requestId: decision.requestId, observedAt: safePoint },
    (current) => ({ ...current, status: 'suspended' }),
  )
  state = suspended.state
  events.push(suspended.event)
  yield suspended.event

  const released = await control.waitUntilReleased()
  if (released === 'cancel') {
    decision = control.observeAtSafePoint(safePoint)
    if (decision.action !== 'cancel') {
      throw new Error('RunControl released a pause without a cancellation request')
    }
    await transitions.abortSession(state)
    const cancelled = await transitions.commit(
      state,
      'run.cancelled',
      { requestId: decision.requestId, observedAt: safePoint },
      (current) => ({ ...current, status: 'cancelled' }),
    )
    events.push(cancelled.event)
    yield cancelled.event
    control.markTerminal()
    return { state: cancelled.state, cancelled: true }
  }

  const resumed = await transitions.commit(
    state,
    'run.resumed',
    { resumedAt: safePoint },
    (current) => ({ ...current, status: 'running' }),
  )
  events.push(resumed.event)
  yield resumed.event
  return { state: resumed.state, cancelled: false }
}

/** @internal */
export async function* failRun(
  state: AgentRunStateV2,
  control: RunControl,
  events: AgentRunEventEnvelope[],
  code: string,
  transitions: AgentRunnerTransitionCommitter,
): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerTerminalResult> {
  await transitions.abortSession(state)
  const failed = await transitions.commit(
    state,
    'run.failed',
    { code },
    (current) => ({ ...current, status: 'failed' }),
  )
  events.push(failed.event)
  yield failed.event
  control.markTerminal()
  return { state: failed.state, events }
}

/** @internal */
export async function* suspendAgentRunForApproval(options: {
  readonly state: AgentRunStateV2
  readonly events: AgentRunEventEnvelope[]
  readonly invocation: AgentToolInvocationState
  readonly toolCall: AgentToolCallItem
  readonly tool: AgentRunnerReadOnlyToolPort
  readonly interactionId: string
  readonly interactionItemId: string
  readonly transitions: AgentRunnerTransitionCommitter
}): AsyncGenerator<AgentRunEventEnvelope, AgentRunStateV2> {
  const { events, invocation, tool, toolCall, transitions } = options
  if (tool.approval === undefined) return options.state
  let state = options.state
  const request: AgentRunJsonValue = {
    kind: 'tool-approval',
    toolId: tool.toolId,
    toolRevision: tool.toolRevision,
    callId: toolCall.callId,
    input: toolCall.arguments,
  }
  const interaction: AgentPendingInteraction = {
    interactionId: options.interactionId,
    generation: 1,
    kind: 'tool-approval',
    stateRevision: state.revision + 2,
    request,
    requestDigest: digestRunnerJson(request),
    invocationId: invocation.invocationId,
    requestedBy: tool.approval.requestedBy,
    decisionPolicyRef: tool.approval.decisionPolicyRef,
    decisionPolicyRevision: tool.approval.decisionPolicyRevision,
    ...(tool.approval.expiresAt === undefined ? {} : { expiresAt: tool.approval.expiresAt }),
  }
  const interactionItem: AgentItem = {
    type: 'interaction',
    itemId: options.interactionItemId,
    interactionId: interaction.interactionId,
    generation: interaction.generation,
    state: 'requested',
  }
  const approvalInvocation: AgentToolInvocationState = {
    ...invocation,
    state: 'approval-required',
  }
  let committed = await transitions.commit(
    state,
    'interaction.requested',
    {
      interactionId: interaction.interactionId,
      generation: interaction.generation,
      invocationId: invocation.invocationId,
      requestDigest: interaction.requestDigest,
      decisionPolicyRef: interaction.decisionPolicyRef,
      decisionPolicyRevision: interaction.decisionPolicyRevision,
    },
    (current) => ({
      ...current,
      status: 'suspending',
      invocations: replaceInvocation(current, approvalInvocation),
      interactions: [...current.interactions, interaction],
      committedItems: [...current.committedItems, interactionItem],
    }),
  )
  state = committed.state
  events.push(committed.event)
  yield committed.event

  committed = await transitions.commit(
    state,
    'run.suspended',
    {
      reason: 'interaction-required',
      interactionId: interaction.interactionId,
      generation: interaction.generation,
    },
    (current) => ({ ...current, status: 'suspended' }),
  )
  events.push(committed.event)
  yield committed.event
  return committed.state
}

/** @internal */
export interface AgentRunnerToolExecutionResult {
  readonly state: AgentRunStateV2
  readonly terminal: boolean
}

/** @internal */
export async function* executeAgentRunnerTool(options: {
  readonly state: AgentRunStateV2
  readonly control: RunControl
  readonly events: AgentRunEventEnvelope[]
  readonly tool: AgentRunnerReadOnlyToolPort
  readonly invocation: AgentToolInvocationState
  readonly input: AgentRunJsonValue
  readonly maxToolAttempts: number
  readonly createToolResultItemId: () => string
  readonly transitions: AgentRunnerTransitionCommitter
}): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerToolExecutionResult> {
  const { control, events, input, maxToolAttempts, tool, transitions } = options
  let state = options.state
  let invocation = options.invocation
  while (invocation.attempt <= maxToolAttempts) {
    const beforeTool = yield* checkpointRun(
      state,
      control,
      'before-tool-dispatch',
      events,
      transitions,
    )
    state = beforeTool.state
    if (beforeTool.cancelled) return { state, terminal: true }

    invocation = { ...invocation, state: 'started' }
    let committed = await transitions.commit(
      state,
      'tool.started',
      {
        invocationId: invocation.invocationId,
        callId: invocation.callId,
        executionAttempt: invocation.attempt,
      },
      (current) => ({ ...current, invocations: replaceInvocation(current, invocation) }),
    )
    state = committed.state
    events.push(committed.event)
    yield committed.event

    let toolResult: AgentRunnerReadOnlyToolResult
    try {
      toolResult = await tool.execute({
        runId: state.runId,
        invocationId: invocation.invocationId,
        callId: invocation.callId,
        attempt: invocation.attempt,
        input,
      })
      assertDurableJson(toolResult)
    } catch {
      invocation = { ...invocation, state: 'effect-unknown' }
      committed = await transitions.commit(
        state,
        'tool.failed',
        {
          invocationId: invocation.invocationId,
          executionAttempt: invocation.attempt,
          outcome: 'effect-unknown',
        },
        (current) => ({ ...current, invocations: replaceInvocation(current, invocation) }),
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event
      const failed = yield* failRun(
        state,
        control,
        events,
        'tool-outcome-unknown',
        transitions,
      )
      return { state: failed.state, terminal: true }
    }

    if (toolResult.status === 'failed-before-effect') {
      invocation = { ...invocation, state: 'failed-before-effect' }
      committed = await transitions.commit(
        state,
        'tool.failed',
        {
          invocationId: invocation.invocationId,
          executionAttempt: invocation.attempt,
          outcome: 'failed-before-effect',
          code: toolResult.code,
          retryable: toolResult.retryable,
        },
        (current) => ({ ...current, invocations: replaceInvocation(current, invocation) }),
      )
      state = committed.state
      events.push(committed.event)
      yield committed.event
      if (!toolResult.retryable || invocation.attempt >= maxToolAttempts) {
        const failed = yield* failRun(
          state,
          control,
          events,
          'tool-failed-before-effect',
          transitions,
        )
        return { state: failed.state, terminal: true }
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
    committed = await transitions.commit(
      state,
      'tool.completed',
      {
        invocationId: invocation.invocationId,
        executionAttempt: invocation.attempt,
        resultDigest,
        effectClass: 'read',
      },
      (current) => ({ ...current, invocations: replaceInvocation(current, invocation) }),
    )
    state = committed.state
    events.push(committed.event)
    yield committed.event

    const toolResultItem: AgentItem = {
      type: 'tool-result',
      itemId: options.createToolResultItemId(),
      callId: invocation.callId,
      output: toolResult.output,
      isError: false,
    }
    committed = await transitions.commit(
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

    const afterTool = yield* checkpointRun(
      state,
      control,
      'after-tool-dispatch',
      events,
      transitions,
    )
    return { state: afterTool.state, terminal: afterTool.cancelled }
  }

  const failed = yield* failRun(
    state,
    control,
    events,
    'tool-attempt-limit',
    transitions,
  )
  return { state: failed.state, terminal: true }
}

/** @internal */
export async function* continueApprovedAgentRun(options: {
  readonly state: AgentRunStateV2
  readonly control: RunControl
  readonly events: AgentRunEventEnvelope[]
  readonly invocationId: string
  readonly tools: ReadonlyMap<string, AgentRunnerReadOnlyToolPort>
  readonly maxToolAttempts: number
  readonly createToolResultItemId: () => string
  readonly transitions: AgentRunnerTransitionCommitter
}): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerToolExecutionResult> {
  const { control, events, invocationId, tools, transitions } = options
  let state = options.state
  const invocation = state.invocations.find((entry) => entry.invocationId === invocationId)
  if (invocation === undefined || invocation.state !== 'approved') {
    throw new AgentRunnerResumeError('interaction-not-found')
  }
  const tool = tools.get(invocation.toolId)
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

  const resumed = await transitions.commit(
    state,
    'run.resumed',
    { invocationId },
    (current) => ({ ...current, status: 'running' }),
  )
  state = resumed.state
  events.push(resumed.event)
  yield resumed.event
  return yield* executeAgentRunnerTool({
    state,
    control,
    events,
    tool,
    invocation,
    input: toolCall.arguments,
    maxToolAttempts: options.maxToolAttempts,
    createToolResultItemId: options.createToolResultItemId,
    transitions,
  })
}

/** @internal */
export async function* executePlannedAgentRunnerTools(options: {
  readonly state: AgentRunStateV2
  readonly control: RunControl
  readonly events: AgentRunEventEnvelope[]
  readonly tools: ReadonlyMap<string, AgentRunnerReadOnlyToolPort>
  readonly maxToolAttempts: number
  readonly createInteractionId: () => string
  readonly createInteractionItemId: () => string
  readonly createToolResultItemId: () => string
  readonly transitions: AgentRunnerTransitionCommitter
}): AsyncGenerator<
  AgentRunEventEnvelope,
  { readonly state: AgentRunStateV2; readonly halted: boolean }
> {
  const { control, events, tools, transitions } = options
  let state = options.state
  for (const toolCall of state.committedItems.filter(
    (item): item is AgentToolCallItem => item.type === 'tool-call',
  )) {
    const invocation = state.invocations.find(
      (entry) => entry.callId === toolCall.callId && entry.toolId === toolCall.toolId,
    )
    if (invocation?.state !== 'planned') continue

    const tool = tools.get(toolCall.toolId)
    if (tool === undefined || tool.toolRevision !== invocation.toolRevision) {
      const failed = yield* failRun(
        state,
        control,
        events,
        tool === undefined ? 'tool-not-found' : 'tool-revision-mismatch',
        transitions,
      )
      return { state: failed.state, halted: true }
    }
    if (tool.approval !== undefined) {
      const suspended = yield* suspendAgentRunForApproval({
        state,
        events,
        invocation,
        toolCall,
        tool,
        interactionId: options.createInteractionId(),
        interactionItemId: options.createInteractionItemId(),
        transitions,
      })
      return { state: suspended, halted: true }
    }
    const executed = yield* executeAgentRunnerTool({
      state,
      control,
      events,
      tool,
      invocation,
      input: toolCall.arguments,
      maxToolAttempts: options.maxToolAttempts,
      createToolResultItemId: options.createToolResultItemId,
      transitions,
    })
    state = executed.state
    if (executed.terminal) return { state, halted: true }
  }
  return { state, halted: false }
}
