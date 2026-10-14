import { AIMessage, HumanMessage, type BaseMessage, type StandardMessageStructure } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'
import { InMemoryAgentRunner, digestRunnerJson, type AgentRunnerModelInvocationResult } from '../runner.js'
import { buildRunnerProviderFreeExecutionProfile } from '../runner/legacy-runner-execution-profile.js'
import { createLegacyRunnerMessageItem } from '../runner/legacy-runner-message-envelope-codec.js'
import {
  captureLegacyReadToolResultEnvelope, projectLegacyReadToolGenerateResult,
  LEGACY_READ_TOOL_TIMING_POLICY, type LegacyReadToolTiming,
} from '../runner/legacy-runner-read-tool-result-envelope.js'

const runId = 'r5o-run'
const behaviorDigest = 'sha256:r5o-provider-free-single-read'
const usage = [{ input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  { input_tokens: 12, output_tokens: 5, total_tokens: 17 }]
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
const mutable = <T>(value: T): Mutable<T> => clone(value) as Mutable<T>

function comparable(result: Awaited<ReturnType<DzupAgent['generate']>>) {
  return { ...result, messages: result.messages.map((message) => message.toDict()),
    middlewareState: { ...result.middlewareState,
      messages: (result.middlewareState?.messages as BaseMessage[]).map((message) => message.toDict()) } }
}

async function scenario(constructorUsage = false, blocks = false) {
  let clock = 1000
  const calls = { legacyModel: 0, legacyTool: 0, runnerModel: 0, runnerTool: 0 }
  const content = blocks ? [{ type: 'text' as const, text: 'Read complete.' }] : 'Read complete.'
  const call = { id: 'call-one', name: 'read-record', args: { recordId: 'one' } }
  const messages = [
    new AIMessage<StandardMessageStructure>({ content: 'Reading.', tool_calls: [call],
      ...(constructorUsage ? { usage_metadata: usage[0]! } : {}) }),
    new AIMessage<StandardMessageStructure>({ content,
      ...(constructorUsage ? { usage_metadata: usage[1]! } : {}) }),
  ]
  messages.forEach((message, index) => { message.usage_metadata = { ...usage[index]! } })
  let prepared: BaseMessage[] = []
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  let legacy
  try {
    const model = { bindTools() { return this }, async invoke(input: BaseMessage[]) {
      if (calls.legacyModel === 0) prepared = [...input]
      return messages[calls.legacyModel++]!
    } } as unknown as BaseChatModel
    const read = tool(async ({ recordId }: { recordId: string }) => {
      calls.legacyTool += 1
      clock += 25
      return `value:${recordId}`
    }, { name: call.name, description: 'Read one deterministic record.',
      schema: z.object({ recordId: z.string() }) })
    legacy = await new DzupAgent({ id: 'r5o-agent', instructions: 'Use the deterministic read.',
      model, tools: [read], guardrails: { maxIterations: 4, stuckDetector: false },
      memoryWriteBack: false, toolExecution: { wrapToolResults: false },
    }).generate([new HumanMessage('Read one record.')], { runId })
  } finally {
    spy.mockRestore()
  }
  let timing: LegacyReadToolTiming | undefined
  let runnerClock = 2000
  const counters = new Map<string, number>()
  const turns: AgentRunnerModelInvocationResult[] = [
    { status: 'completed', item: { type: 'message', itemId: 'assistant-call', role: 'assistant',
      content: [{ type: 'text', text: 'Reading.' }] }, additionalItems: [{ type: 'tool-call',
      itemId: 'tool-call', callId: call.id, toolId: call.name, arguments: call.args }],
      usage: { accountingSource: 'r5o-fixture', inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      finishReason: 'tool-calls' },
    { status: 'completed', item: { type: 'message', itemId: 'assistant-final', role: 'assistant',
      content: [{ type: 'text', text: 'Read complete.' }] },
      usage: { accountingSource: 'r5o-fixture', inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      finishReason: 'stop' },
  ]
  const result = await new InMemoryAgentRunner({
    model: { adapterId: 'r5o-model/v1', async invoke() { return turns[calls.runnerModel++]! } },
    tools: [{ toolId: call.name, toolRevision: '1', effectClass: 'read', async execute(request) {
      calls.runnerTool += 1
      const startedMs = runnerClock
      const output = `value:${(request.input as { recordId: string }).recordId}`
      runnerClock += 25
      timing = { policy: LEGACY_READ_TOOL_TIMING_POLICY, runId: request.runId,
        invocationId: request.invocationId, callId: request.callId, attempt: 1,
        startedMs, completedMs: runnerClock }
      return { status: 'completed', output }
    } }],
    createId(kind) {
      if (kind === 'run') return runId
      counters.set(kind, (counters.get(kind) ?? 0) + 1)
      return `${kind}-${counters.get(kind)}`
    }, now: () => '2026-10-14T18:40:00.000Z', maxModelTurns: 4, maxToolAttempts: 2,
  }).run({ agentId: 'r5o-agent', behaviorDigest, items: prepared.map((message, index) => {
    const item = createLegacyRunnerMessageItem(message, `input-${index}`)
    if (typeof item === 'string') throw new Error(item)
    return item
  }) })
  const profile = buildRunnerProviderFreeExecutionProfile({ behaviorDigest, maxModelTurns: 4,
    maxToolAttempts: 2, observedMessageCount: prepared.length, observedMessageTokens: 256,
    structuredOutputRequested: false })
  if (timing === undefined) throw new Error('No host timing observation')
  const input = { profile, result, preparedInput: prepared, assistantCall: messages[0]!,
    toolMessage: legacy.messages[prepared.length + 1] as Parameters<typeof captureLegacyReadToolResultEnvelope>[0]['toolMessage'],
    finalAssistant: messages[1]!, timing }
  const captured = captureLegacyReadToolResultEnvelope(input)
  if (captured.status !== 'captured') throw new Error(`Capture rejected: ${captured.reason}`)
  const projection = { profile, result, envelope: captured.envelope,
    expectedEnvelopeDigest: captured.envelope.envelopeDigest }
  return { input, projection, legacy, calls }
}

describe('R5O single-read legacy result/timing envelope', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'matches the complete independently executed legacy result (constructor usage %s, blocks %s)',
    async (constructorUsage, blocks) => {
      const value = await scenario(constructorUsage, blocks)
      const actual = projectLegacyReadToolGenerateResult(value.projection)
      expect(actual.status).toBe('projected')
      if (actual.status !== 'projected') return
      expect(comparable(actual.result)).toEqual(comparable(value.legacy))
      expect(actual.result.toolStats).toEqual([{ name: 'read-record', calls: 1, errors: 0, totalMs: 25, avgMs: 25 }])
      expect(value.calls).toEqual({ legacyModel: 2, legacyTool: 1, runnerModel: 2, runnerTool: 1 })
      expect(Object.keys(actual.result).sort()).toEqual(Object.keys(value.legacy).sort())
    },
  )

  it('reconstructs stable result identities after JSON roundtrip without any replay', async () => {
    const value = await scenario()
    const before = { ...value.calls }
    const first = projectLegacyReadToolGenerateResult(value.projection)
    const second = projectLegacyReadToolGenerateResult(clone(value.projection))
    expect(first.status).toBe('projected')
    expect(second).toEqual(first)
    expect(value.calls).toEqual(before)
  })

  it('snapshots messages and timing instead of retaining mutable caller objects', async () => {
    const value = await scenario()
    const digest = value.projection.envelope.envelopeDigest
    value.input.preparedInput[0]!.content = 'caller mutation'
    value.input.assistantCall.content = 'caller mutation'
    const timing = value.input.timing as Mutable<LegacyReadToolTiming>
    timing.completedMs += 999
    expect(digestRunnerJson((({ envelopeDigest: _digest, ...body }) => body)(value.projection.envelope))).toBe(digest)
    expect(projectLegacyReadToolGenerateResult(value.projection).status).toBe('projected')
  })

  it.each(['missing', 'negative', 'reverse', 'fractional', 'nonfinite', 'policy', 'run', 'invocation',
    'call', 'attempt', 'unknown-field', 'hidden-field', 'symbol', 'accessor'])(
    'rejects %s timing without provider work or accessor side effects', async (mode) => {
      const value = await scenario()
      const timing = mutable(value.input.timing)
      let sideEffects = 0
      if (mode === 'negative') timing.startedMs = -1
      if (mode === 'reverse') timing.completedMs = timing.startedMs - 1
      if (mode === 'fractional') timing.completedMs += 0.5
      if (mode === 'nonfinite') timing.completedMs = Number.POSITIVE_INFINITY
      if (mode === 'policy') Object.assign(timing, { policy: 'unqualified-clock' })
      if (mode === 'run') timing.runId = 'another-run'
      if (mode === 'invocation') timing.invocationId = 'another-invocation'
      if (mode === 'call') timing.callId = 'another-call'
      if (mode === 'attempt') Object.assign(timing, { attempt: 2 })
      if (mode === 'unknown-field') Object.assign(timing, { extra: true })
      if (mode === 'hidden-field') Object.defineProperty(timing, 'extra', { value: true })
      if (mode === 'symbol') Object.assign(timing, { [Symbol('extension')]: true })
      if (mode === 'accessor') Object.defineProperty(timing, 'completedMs', {
        enumerable: true, get() { sideEffects += 1; return 2025 },
      })
      const input = { ...value.input, timing: mode === 'missing' ? undefined : timing }
      expect(captureLegacyReadToolResultEnvelope(input as typeof value.input).status).toBe('rejected')
      expect(sideEffects).toBe(0)
      expect(value.calls).toEqual({ legacyModel: 2, legacyTool: 1, runnerModel: 2, runnerTool: 1 })
    },
  )

  it.each(['input', 'call', 'output', 'order', 'effect', 'retry', 'failed', 'unknown', 'suspended',
    'context', 'session', 'adapter', 'sandbox', 'structured', 'handoff', 'usage', 'extension', 'invocation-extension',
    'event-call', 'duplicate-item', 'completion-evidence', 'event-extension', 'payload-extension',
    'usage-extension', 'usage-record-extension', 'budget-extension', 'budget-limits-extension',
    'budget-consumed-extension', 'tool-selection', 'model-itemids', 'model-callids', 'model-turn',
    'item-event', 'usage-source'])(
    'rejects %s runner drift and never replays execution', async (mode) => {
      const value = await scenario()
      const result = mutable(value.input.result)
      const call = result.state.committedItems[1]!
      if (mode === 'input') Object.assign(result.state.input[0]!, {
        content: [{ type: 'text', text: 'different admitted content' }],
      })
      if (mode === 'call' && call.type === 'tool-call') call.callId = 'drift'
      if (mode === 'output') Object.assign(result.state.committedItems[2]!, { output: 'drift' })
      if (mode === 'order') result.state.committedItems.reverse()
      if (mode === 'effect') result.state.invocations[0]!.effectClass = 'external'
      if (mode === 'retry') result.state.invocations[0]!.attempt = 2
      if (mode === 'failed') result.state.status = 'failed'
      if (mode === 'unknown') result.state.invocations[0]!.state = 'effect-unknown'
      if (mode === 'suspended') result.state.status = 'suspended'
      if (mode === 'context') Object.assign(result.state, { context: { state: 'inline', value: {} } })
      if (mode === 'session') result.state.sessionBinding = { sessionId: 'session', baseRevision: '1' }
      if (mode === 'adapter') result.state.adapterState = {}
      if (mode === 'sandbox') result.state.sandboxRef = { sandboxId: 'sandbox', manifestDigest: 'digest' }
      if (mode === 'structured') Object.assign(result.state, { structuredOutput: {} })
      if (mode === 'handoff') Object.assign(result.state, { handoffs: [{}] })
      if (mode === 'usage') result.state.usage.records.pop()
      if (mode === 'extension') Object.assign(result.state, { extension: true })
      if (mode === 'invocation-extension') Object.assign(result.state.invocations[0]!, { extension: true })
      if (mode === 'event-call') Object.assign(result.events.find((event) => event.type === 'tool.started')!.payload!, { callId: 'drift' })
      if (mode === 'duplicate-item') result.state.committedItems[3]!.itemId = result.state.input[0]!.itemId
      if (mode === 'completion-evidence') Object.assign(result.state.invocations[0]!, { completionEvidence: { resultDigest: 'drift' } })
      if (mode === 'event-extension') Object.assign(result.events[0]!, { extension: true })
      if (mode === 'payload-extension') Object.assign(result.events[0]!.payload!, { extension: true })
      if (mode === 'usage-extension') Object.assign(result.state.usage, { extension: true })
      if (mode === 'usage-record-extension') Object.assign(result.state.usage.records[0]!, { extension: true })
      if (mode === 'budget-extension') Object.assign(result.state.budget, { extension: true })
      if (mode === 'budget-limits-extension') result.state.budget.limits.extension = true
      if (mode === 'budget-consumed-extension') result.state.budget.consumed.extension = true
      if (mode === 'tool-selection') Object.assign(result.events.find((event) => event.type === 'tool.selected')!.payload!, { callId: 'drift' })
      if (mode === 'model-itemids') Object.assign(result.events.find((event) => event.type === 'model.completed')!.payload!, { itemIds: ['drift'] })
      if (mode === 'model-callids') Object.assign(result.events.find((event) => event.type === 'model.completed')!.payload!, { callIds: ['drift'] })
      if (mode === 'model-turn') Object.assign(result.events.find((event) => event.type === 'model.completed')!.payload!, { turn: 99 })
      if (mode === 'item-event') Object.assign(result.events.find((event) => event.type === 'item.added')!.payload!, { itemId: 'drift' })
      if (mode === 'usage-source') Object.assign(result.events.find((event) => event.type === 'usage.recorded')!.payload!, { accountingSource: 'drift' })
      expect(captureLegacyReadToolResultEnvelope({ ...value.input, result }).status).toBe('rejected')
      expect(projectLegacyReadToolGenerateResult({ ...value.projection, result }).status).toBe('rejected')
      expect(value.calls).toEqual({ legacyModel: 2, legacyTool: 1, runnerModel: 2, runnerTool: 1 })
    },
  )

  it('rejects input identity drift after capture and projection-profile drift before capture', async () => {
    const value = await scenario()
    const result = mutable(value.projection.result)
    result.state.input[0]!.itemId = 'different-input-identity'
    expect(projectLegacyReadToolGenerateResult({ ...value.projection, result }).status).toBe('rejected')
    const profile = buildRunnerProviderFreeExecutionProfile({ behaviorDigest, maxModelTurns: 4,
      maxToolAttempts: 2, observedMessageCount: 2, observedMessageTokens: 256,
      structuredOutputRequested: false, legacyResultProjection: 'no-tool-generate-delegation/v1' })
    expect(captureLegacyReadToolResultEnvelope({ ...value.input, profile }).status).toBe('rejected')
  })

  it('rejects sparse arrays and array extensions before reading their values', async () => {
    const value = await scenario()
    const result = mutable(value.input.result)
    delete result.events[0]
    Object.assign(result.events, { extension: true })
    expect(captureLegacyReadToolResultEnvelope({ ...value.input, result }).status).toBe('rejected')
  })

  it.each(['digest', 'prepared-content', 'assistant-usage', 'tool-metadata', 'final-metadata', 'new-field'])(
    'rejects %s envelope or unsupported message evidence', async (mode) => {
      const value = await scenario()
      const envelope = mutable(value.projection.envelope)
      if (mode === 'digest') envelope.envelopeDigest = 'sha256:drift'
      if (mode === 'prepared-content') envelope.preparedInput[0]!.itemId = 'drift'
      if (mode === 'assistant-usage') envelope.assistantCall.usageMetadata!.input_tokens += 1
      if (mode === 'new-field') Object.assign(envelope, { extension: true })
      if (mode === 'tool-metadata') {
        value.input.toolMessage.response_metadata = { unsupported: true }
        expect(captureLegacyReadToolResultEnvelope(value.input).status).toBe('rejected')
      } else if (mode === 'final-metadata') {
        value.input.finalAssistant.response_metadata = { unsupported: true }
        expect(captureLegacyReadToolResultEnvelope(value.input).status).toBe('rejected')
      } else {
        expect(projectLegacyReadToolGenerateResult({ ...value.projection, envelope }).status).toBe('rejected')
      }
    },
  )
})
