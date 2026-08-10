import { describe, expect, it } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import type { AgentItem, AgentRunJsonValue } from '@dzupagent/agent-types/run'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { GenerateResult } from '../agent/agent-types.js'
import type {
  AgentRunnerIdentityKind,
  AgentRunnerModelInvocationResult,
  AgentRunnerModelPort,
  AgentRunnerModelRequest,
  AgentRunnerReadOnlyToolPort,
  AgentRunnerReadOnlyToolRequest,
  AgentRunnerReadOnlyToolResult,
  AgentRunnerResult,
} from '../runner.js'
import { InMemoryAgentRunner, RunControl } from '../runner.js'
import {
  compareCompletedLegacyRunnerExecution,
  comparePreDispatchCancellation,
  compareTerminalOutcome,
  unsupportedLegacyRunnerCapability,
  type CompatibilityRead,
  type CompatibilityTerminalOutcome,
  type CompatibilityTextItem,
  type LegacyRunnerCompatibilityObservation,
} from './support/legacy-runner-compatibility.js'

const userText = 'Read the deterministic records.'
const prefaceText = 'Reading the records in order.'
const finalText = 'All deterministic reads completed.'

function usageMessage(
  content: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): AIMessage {
  const message = new AIMessage(content)
  ;(message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  }
  return message
}

function toolTurn(callCount: number): AIMessage {
  const message = new AIMessage({
    content: prefaceText,
    tool_calls: Array.from({ length: callCount }, (_, index) => ({
      id: `call-${index + 1}`,
      name: 'read-record',
      args: { recordId: `record-${index + 1}` },
    })),
  })
  ;(message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
  }
  return message
}

class LegacyModelFixture {
  readonly calls: BaseMessage[][] = []
  readonly #responses: Array<AIMessage | Error>

  constructor(responses: Array<AIMessage | Error>) {
    this.#responses = [...responses]
  }

  readonly model = {
    invoke: async (messages: BaseMessage[]): Promise<AIMessage> => {
      this.calls.push(messages)
      const response = this.#responses.shift()
      if (response === undefined) throw new Error('Legacy model fixture exhausted')
      if (response instanceof Error) throw response
      return response
    },
    bindTools() {
      return this
    },
  } as unknown as BaseChatModel
}

class RunnerModelFixture implements AgentRunnerModelPort {
  readonly adapterId = 'r5i-provider-free-model/v1'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: AgentRunnerModelInvocationResult[]

  constructor(responses: AgentRunnerModelInvocationResult[]) {
    this.#responses = [...responses]
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('Runner model fixture exhausted')
    return response
  }
}

class RunnerReadFixture implements AgentRunnerReadOnlyToolPort {
  readonly toolId = 'read-record'
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []
  readonly #failUnknown: boolean

  constructor(failUnknown = false) {
    this.#failUnknown = failUnknown
  }

  async execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult> {
    this.calls.push(request)
    if (this.#failUnknown) throw new Error('deterministic unknown read outcome')
    const recordId = (request.input as { readonly recordId: string }).recordId
    return { status: 'completed', output: `value:${recordId}` }
  }
}

function deterministicIds(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

function runnerTurn(callCount: number): AgentRunnerModelInvocationResult {
  return {
    status: 'completed',
    item: {
      type: 'message',
      itemId: 'assistant-preface',
      role: 'assistant',
      content: [{ type: 'text', text: prefaceText }],
    },
    additionalItems: Array.from({ length: callCount }, (_, index) => ({
      type: 'tool-call' as const,
      itemId: `tool-call-item-${index + 1}`,
      callId: `call-${index + 1}`,
      toolId: 'read-record',
      arguments: { recordId: `record-${index + 1}` },
    })),
    usage: {
      accountingSource: 'provider-free',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    },
    finishReason: 'tool-calls',
  }
}

function runnerFinal(): AgentRunnerModelInvocationResult {
  return {
    status: 'completed',
    item: {
      type: 'message',
      itemId: 'assistant-final',
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
    },
    usage: {
      accountingSource: 'provider-free',
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    },
    finishReason: 'stop',
  }
}

function createRunner(model: AgentRunnerModelPort, read: AgentRunnerReadOnlyToolPort) {
  return new InMemoryAgentRunner({
    model,
    tools: [read],
    createId: deterministicIds(),
    now: () => '2026-08-10T12:00:00.000Z',
  })
}

function runnerInput(): Parameters<InMemoryAgentRunner['run']>[0] {
  return {
    agentId: 'r5i-agent',
    behaviorDigest: 'sha256:r5i-provider-free-compatibility',
    items: [{
      type: 'message',
      itemId: 'input-user',
      role: 'user',
      content: [{ type: 'text', text: userText }],
    }],
  }
}

function messageText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function legacyObservation(
  result: GenerateResult,
  dispatches: LegacyRunnerCompatibilityObservation['dispatches'],
): LegacyRunnerCompatibilityObservation {
  const orderedTextItems: CompatibilityTextItem[] = []
  const toolResults = new Map<string, AgentRunJsonValue>()
  for (const message of result.messages) {
    if (message instanceof ToolMessage) {
      toolResults.set(message.tool_call_id, message.content as AgentRunJsonValue)
      continue
    }
    const type = message.getType()
    if (type !== 'human' && type !== 'ai') continue
    const text = messageText(message.content)
    if (text.length > 0) orderedTextItems.push({ role: type === 'human' ? 'user' : 'assistant', text })
  }

  const reads: CompatibilityRead[] = []
  for (const message of result.messages) {
    if (!(message instanceof AIMessage)) continue
    for (const call of message.tool_calls ?? []) {
      const readResult = call.id === undefined ? undefined : toolResults.get(call.id)
      if (call.id === undefined || readResult === undefined) continue
      reads.push({
        callId: call.id,
        toolId: call.name,
        arguments: call.args as AgentRunJsonValue,
        result: readResult,
      })
    }
  }

  const outcome: CompatibilityTerminalOutcome = result.stopReason === 'aborted'
    ? { status: 'cancelled-before-dispatch' }
    : { status: 'completed' }
  return {
    orderedTextItems,
    reads,
    usage: {
      inputTokens: result.usage.totalInputTokens,
      outputTokens: result.usage.totalOutputTokens,
    },
    outcome,
    dispatches,
  }
}

function runnerText(item: AgentItem): CompatibilityTextItem | undefined {
  if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) {
    return undefined
  }
  const text = item.content
    .filter((block) => block.type === 'text')
    .map((block) => block.type === 'text' ? block.text : '')
    .join('')
  return text.length > 0 ? { role: item.role, text } : undefined
}

function runnerOutcome(result: AgentRunnerResult): CompatibilityTerminalOutcome {
  if (result.state.status === 'completed') return { status: 'completed' }
  if (result.state.status === 'cancelled') return { status: 'cancelled-before-dispatch' }
  const unknown = result.state.invocations.find((invocation) => invocation.state === 'effect-unknown')
  if (unknown !== undefined) return { status: 'outcome-unknown', code: 'effect-unknown' }
  const failure = result.events.findLast((event) => event.type === 'model.failed')
  const payload = failure?.payload
  const payloadRecord = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined
  const code = typeof payloadRecord?.code === 'string' ? payloadRecord.code : 'runner-failed'
  return { status: 'failed-before-dispatch', code }
}

function runnerObservation(
  result: AgentRunnerResult,
  dispatches: LegacyRunnerCompatibilityObservation['dispatches'],
): LegacyRunnerCompatibilityObservation {
  const items = [...result.state.input, ...result.state.committedItems]
  const orderedTextItems = items
    .map(runnerText)
    .filter((item): item is CompatibilityTextItem => item !== undefined)
  const results = new Map<string, AgentRunJsonValue>(
    result.state.committedItems
      .filter((item) => item.type === 'tool-result')
      .map((item) => [item.callId, item.output as unknown as AgentRunJsonValue] as const),
  )
  const reads = result.state.committedItems
    .filter((item) => item.type === 'tool-call')
    .flatMap((item): CompatibilityRead[] => {
      const output = results.get(item.callId)
      return output === undefined ? [] : [{
        callId: item.callId,
        toolId: item.toolId,
        arguments: item.arguments,
        result: output,
      }]
    })
  const usageRecords = result.state.usage.records
  const hasComparableUsage = usageRecords.length > 0 && usageRecords.every(
    (record) => record.inputTokens !== undefined && record.outputTokens !== undefined,
  )
  const usage = hasComparableUsage
    ? {
        inputTokens: usageRecords.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
        outputTokens: usageRecords.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
      }
    : undefined
  return {
    orderedTextItems,
    reads,
    ...(usage === undefined ? {} : { usage }),
    outcome: runnerOutcome(result),
    dispatches,
  }
}

async function runCompletedPair(callCount: number) {
  const legacyModel = new LegacyModelFixture([
    toolTurn(callCount),
    usageMessage(finalText, { inputTokens: 12, outputTokens: 5 }),
  ])
  const legacyToolCalls: string[] = []
  const legacyRead = tool(async ({ recordId }: { recordId: string }) => {
    legacyToolCalls.push(recordId)
    return `value:${recordId}`
  }, {
    name: 'read-record',
    description: 'Read a deterministic provider-free record.',
    schema: z.object({ recordId: z.string() }),
  })
  const legacy = new DzupAgent({
    id: 'r5i-agent',
    instructions: 'Use only the deterministic read fixture.',
    model: legacyModel.model,
    tools: [legacyRead],
    toolExecution: { wrapToolResults: false },
  })
  const legacyResult = await legacy.generate([new HumanMessage(userText)])

  const runnerModel = new RunnerModelFixture([runnerTurn(callCount), runnerFinal()])
  const runnerRead = new RunnerReadFixture()
  const runnerResult = await createRunner(runnerModel, runnerRead).run(runnerInput())
  return {
    legacy: legacyObservation(legacyResult, {
      model: legacyModel.calls.length,
      tool: legacyToolCalls.length,
    }),
    runner: runnerObservation(runnerResult, {
      model: runnerModel.calls.length,
      tool: runnerRead.calls.length,
    }),
    legacyToolCalls,
    runnerRead,
  }
}

describe('AgentRunner legacy compatibility contract', () => {
  it.each([1, 2])(
    'compares completed text, usage, and %i ordered read call(s) exactly',
    async (callCount) => {
      const pair = await runCompletedPair(callCount)
      expect(pair.legacy.reads).toEqual(pair.runner.reads)
      expect(compareCompletedLegacyRunnerExecution(pair.legacy, pair.runner)).toEqual([
        { capability: 'ordered-text-items', status: 'exact', reason: 'exact-match' },
        { capability: 'read-calls', status: 'exact', reason: 'exact-match' },
        { capability: 'usage', status: 'exact', reason: 'exact-match' },
        { capability: 'terminal-outcome', status: 'exact', reason: 'exact-match' },
      ])
      expect(pair.legacyToolCalls).toEqual(
        Array.from({ length: callCount }, (_, index) => `record-${index + 1}`),
      )
      expect(pair.runnerRead.calls.map((call) => ({ callId: call.callId, input: call.input })))
        .toEqual(Array.from({ length: callCount }, (_, index) => ({
          callId: `call-${index + 1}`,
          input: { recordId: `record-${index + 1}` },
        })))
    },
  )

  it('proves equivalent cancellation before model or tool dispatch', async () => {
    const legacyModel = new LegacyModelFixture([usageMessage('unreachable', {
      inputTokens: 1,
      outputTokens: 1,
    })])
    const legacy = new DzupAgent({
      id: 'r5i-agent',
      instructions: 'Do not dispatch after cancellation.',
      model: legacyModel.model,
    })
    const abort = new AbortController()
    abort.abort()
    const legacyResult = await legacy.generate([new HumanMessage(userText)], { signal: abort.signal })
    const legacyObserved = legacyObservation(legacyResult, {
      model: legacyModel.calls.length,
      tool: 0,
    })

    const runnerModel = new RunnerModelFixture([runnerFinal()])
    const runnerRead = new RunnerReadFixture()
    const control = new RunControl()
    const cancellation = control.requestCancel()
    if (!cancellation.accepted) throw new Error('Expected cancellation admission')
    const runnerResult = await createRunner(runnerModel, runnerRead).run(runnerInput(), { control })
    const runnerObserved = runnerObservation(runnerResult, {
      model: runnerModel.calls.length,
      tool: runnerRead.calls.length,
    })

    expect(comparePreDispatchCancellation(legacyObserved, runnerObserved)).toEqual({
      capability: 'pre-dispatch-cancellation',
      status: 'exact',
      reason: 'exact-match',
    })
    expect(legacyModel.calls).toHaveLength(0)
    expect(runnerModel.calls).toHaveLength(0)
    expect(runnerRead.calls).toHaveLength(0)
  })

  it('does not equate a legacy dispatched failure with a runner pre-dispatch failure', async () => {
    const legacyModel = new LegacyModelFixture([new Error('deterministic legacy rejection')])
    const legacy = new DzupAgent({
      id: 'r5i-agent',
      instructions: 'Exercise deterministic failure classification.',
      model: legacyModel.model,
    })
    await expect(legacy.generate([new HumanMessage(userText)]))
      .rejects.toThrow('deterministic legacy rejection')

    const runnerModel = new RunnerModelFixture([{
      status: 'failed-before-dispatch',
      code: 'deterministic-runner-rejection',
      category: 'unavailable',
      retryClassification: 'non-retryable',
    }])
    const runnerRead = new RunnerReadFixture()
    const runnerResult = await createRunner(runnerModel, runnerRead).run(runnerInput())

    expect(compareTerminalOutcome(
      { status: 'failed', code: 'legacy-dispatch-rejected' },
      runnerOutcome(runnerResult),
    )).toEqual({
      capability: 'terminal-outcome',
      status: 'different',
      reason: 'outcome-provenance-not-comparable',
    })
    expect(legacyModel.calls).toHaveLength(1)
    expect(runnerModel.calls).toHaveLength(1)
    expect(runnerRead.calls).toHaveLength(0)
  })

  it('retains runner unknown-outcome custody without claiming legacy equivalence or replay', async () => {
    const runnerModel = new RunnerModelFixture([runnerTurn(1)])
    const runnerRead = new RunnerReadFixture(true)
    const runnerResult = await createRunner(runnerModel, runnerRead).run(runnerInput())

    expect(compareTerminalOutcome(
      { status: 'failed', code: 'legacy-tool-error-is-model-visible' },
      runnerOutcome(runnerResult),
    )).toEqual({
      capability: 'terminal-outcome',
      status: 'unsupported',
      reason: 'outcome-provenance-not-comparable',
    })
    expect(runnerResult.state.invocations).toMatchObject([{ state: 'effect-unknown', attempt: 1 }])
    expect(runnerRead.calls).toHaveLength(1)
    expect(runnerModel.calls).toHaveLength(1)
  })

  it('reports legacy-only obligations as unsupported instead of manufacturing parity', () => {
    expect([
      unsupportedLegacyRunnerCapability('memory'),
      unsupportedLegacyRunnerCapability('guardrails'),
      unsupportedLegacyRunnerCapability('middleware'),
      unsupportedLegacyRunnerCapability('structured-output'),
      unsupportedLegacyRunnerCapability('streaming-deltas'),
      unsupportedLegacyRunnerCapability('run-handle-control'),
    ]).toEqual([
      'memory',
      'guardrails',
      'middleware',
      'structured-output',
      'streaming-deltas',
      'run-handle-control',
    ].map((capability) => ({
      capability,
      status: 'unsupported',
      reason: 'runner-obligation-not-represented',
    })))
  })
})
