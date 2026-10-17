import { AIMessage, HumanMessage, ToolMessage, type BaseMessage, type StandardMessageStructure } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { DzupAgent } from '../agent/dzip-agent.js'
import { InMemoryAgentRunner, type AgentRunnerReadToolDelegationRequest,
  type AgentRunnerReadToolDelegationOutcome, type AgentRunnerReadToolDelegationBridge,
  validateAgentRunnerReadToolDelegationAdmission, validateAgentRunnerReadToolDelegationSource } from '../runner.js'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const usage = [{ input_tokens: 10, output_tokens: 4, total_tokens: 14 }, { input_tokens: 12, output_tokens: 5, total_tokens: 17 }]
const options = (preDispatchPolicy: 'fail-closed' | 'fallback-to-legacy' = 'fail-closed') => ({
  runId: 'r5p-run', experimentalReadToolGenerateDelegation: { enabled: true as const, preDispatchPolicy },
})
const comparable = (value: Awaited<ReturnType<DzupAgent['generate']>>) => ({
  ...value, messages: value.messages.map((message) => message.toDict()),
  middlewareState: { ...value.middlewareState,
    messages: (value.middlewareState!.messages as BaseMessage[]).map((message) => message.toDict()) },
})

function fixture(input: { mode?: string; blocks?: boolean; constructorUsage?: boolean;
  config?: Record<string, unknown>; onModel?: (turn: number) => void; onRead?: () => void;
  onDispatch?: (request: AgentRunnerReadToolDelegationRequest) => void } = {}) {
  const mode = input.mode ?? 'completed'
  let clock = 1000
  const counts = { legacyModel: 0, runnerModel: 0, tools: 0, dispatch: 0 }
  const requests: AgentRunnerReadToolDelegationRequest[] = []
  const content = input.blocks ? [{ type: 'text' as const, text: 'Read complete.' }] : 'Read complete.'
  const call = { id: 'call-one', name: 'read-one', args: { recordId: 'one' } }
  const messages = [
    new AIMessage<StandardMessageStructure>({ content: 'Reading.', tool_calls: [call],
      ...(input.constructorUsage ? { usage_metadata: usage[0]! } : {}) }),
    new AIMessage<StandardMessageStructure>({ content,
      ...(input.constructorUsage ? { usage_metadata: usage[1]! } : {}) }),
  ]
  messages.forEach((message, index) => { message.usage_metadata = { ...usage[index]! } })
  const read = tool(async ({ recordId }) => {
    counts.tools += 1; clock += 25; input.onRead?.()
    if (mode === 'tool-throw') throw new Error('untrusted tool detail')
    return `value:${recordId}`
  }, { name: call.name, description: 'Read one deterministic record.', schema: z.object({ recordId: z.string() }) })
  const bridge: AgentRunnerReadToolDelegationBridge = {
    bridgeId: 'r5p-native-read/v1',
    binding: { toolId: call.name, toolRevision: '1', effectClass: 'read', maxCalls: 1, timingPolicy: 'host-elapsed-ms/v1' },
    async dispatch(request) {
      counts.dispatch += 1; requests.push(request)
      input.onDispatch?.(request)
      if (mode === 'throw') throw new Error('untrusted provider detail')
      if (mode === 'rejected-before-dispatch' || mode === 'late-port') return { status: 'rejected-before-dispatch', source: request.admission.source, code: 'not-ready' }
      if (mode === 'mutate-admission') Object.assign(request.admission.source, { runId: 'foreign' })
      const ids = new Map<string, number>()
      let currentTurn = 0
      const result = await new InMemoryAgentRunner({
        model: { adapterId: 'r5p-fake-model/v1', async invoke() {
          const turn = ++currentTurn
          counts.runnerModel += 1; input.onModel?.(turn)
          return turn === 1 || mode === 'repeat-model-read'
            ? { status: 'completed', item: { type: 'message', itemId: `assistant-call-${turn}`, role: 'assistant',
                content: [{ type: 'text', text: 'Reading.' }] }, additionalItems: [{ type: 'tool-call',
                itemId: `tool-call-${turn}`, callId: turn === 1 ? call.id : 'call-two', toolId: call.name, arguments: call.args }],
                usage: { accountingSource: 'fixture', inputTokens: 10, outputTokens: 4, totalTokens: 14 }, finishReason: 'tool-calls' }
            : { status: 'completed', item: { type: 'message', itemId: 'assistant-final', role: 'assistant',
                content: [{ type: 'text', text: 'Read complete.' }] },
                usage: { accountingSource: 'fixture', inputTokens: 12, outputTokens: 5, totalTokens: 17 }, finishReason: 'stop' }
        } },
        tools: [mode === 'skip-port' ? { ...request.readTool, async execute() { return { status: 'completed' as const, output: 'value:one' } } } : request.readTool],
        maxModelTurns: request.admission.maxModelTurns, maxToolAttempts: request.admission.maxToolAttempts,
        createId(kind) {
          if (kind === 'run') return request.admission.source.runId
          ids.set(kind, (ids.get(kind) ?? 0) + 1); return `${kind}-${ids.get(kind)}`
        }, now: () => '2026-10-14T20:30:00.000Z',
      }).run(request.input, { control: request.control })
      if (mode === 'double-port') {
        await request.readTool.execute({ runId: request.admission.source.runId, invocationId: 'invocation-two',
          callId: 'call-two', attempt: 1, input: call.args }).catch(() => {})
      }
      if (mode === 'refusal-after-read') return { status: 'rejected-before-dispatch', source: request.admission.source, code: 'not-ready' }
      if (mode === 'failed-after-dispatch' || mode === 'outcome-unknown') return { status: mode, source: request.admission.source, code: 'fixture-failure' }
      const source = clone(request.admission.source)
      const retained = clone(result)
      if (mode === 'source-drift') Object.assign(source, { inputDigest: 'sha256:foreign' })
      if (mode === 'input-drift') Object.assign(retained.state.input[0]!, { itemId: 'foreign' })
      if (mode === 'revision-drift') Object.assign(retained.state.invocations[0]!, { toolRevision: '2' })
      if (mode === 'output-drift') Object.assign(retained.state.committedItems[2]!, { output: 'foreign' })
      if (mode === 'unknown-state') Object.assign(retained.state, { extension: true })
      const toolMessage = new ToolMessage({ content: 'value:one', tool_call_id: call.id, name: call.name })
      if (mode === 'metadata') toolMessage.artifact = { unqualified: true }
      return { status: 'completed', source, result: retained,
        assistantCall: messages[0]!, toolMessage, finalAssistant: messages[1]! } satisfies AgentRunnerReadToolDelegationOutcome
    },
  }
  const model = { bindTools() { return this }, async invoke() {
    const index = (counts.legacyModel++) % 2
    if (mode === 'structured-correction' && counts.legacyModel >= 4) {
      return new AIMessage<StandardMessageStructure>({ content: '{"answer":"done"}', usage_metadata: usage[1]! })
    }
    return messages[index]!
  } } as unknown as BaseChatModel
  const config = { id: 'r5p-agent', instructions: 'Read one deterministic record.', model, tools: [read],
    guardrails: { maxIterations: 4, stuckDetector: false as const }, memoryWriteBack: false,
    toolExecution: { wrapToolResults: false }, experimentalReadToolGenerateBridge: bridge, ...input.config }
  const agent = new DzupAgent(config)
  return { agent, config, bridge, read, messages, requests, counts, now: () => clock }
}

describe('R5P public single-read delegation', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'matches every legacy result field with usage encoding %s and block content %s', async (constructorUsage, blocks) => {
      const value = fixture({ constructorUsage, blocks })
      const spy = vi.spyOn(Date, 'now').mockImplementation(value.now)
      try {
        const messages = [new HumanMessage('First'), new AIMessage('History'), new HumanMessage('Read one')]
        const legacy = await value.agent.generate(messages, { runId: 'r5p-run' })
        const actual = await value.agent.generate(messages, options())
        expect(comparable(actual)).toEqual(comparable(legacy))
        expect(actual.toolStats).toEqual([{ name: 'read-one', calls: 1, errors: 0, totalMs: 25, avgMs: 25 }])
        expect(value.counts).toEqual({ legacyModel: 2, runnerModel: 2, tools: 2, dispatch: 1 })
        expect(validateAgentRunnerReadToolDelegationAdmission(clone(value.requests[0]!.admission))).toBe(true)
        expect(validateAgentRunnerReadToolDelegationSource(clone(value.requests[0]!.admission.source))).toBe(true)
        expect(Object.isFrozen(value.requests[0]!.admission.source.readTool)).toBe(true)
        for (const [index, message] of actual.messages.entries()) {
          for (const field of Object.getOwnPropertyNames(message)) {
            if (field === 'lc_kwargs') continue
            expect(Reflect.get(message, field)).toEqual(Reflect.get(legacy.messages[index]!, field))
          }
        }
      } finally { spy.mockRestore() }
    })

  it('keeps default legacy dispatch and permits certified pre-dispatch fallback once', async () => {
    for (const mode of ['completed', 'rejected-before-dispatch']) {
      const value = fixture({ mode })
      await value.agent.generate([new HumanMessage('Read')], mode === 'completed' ? undefined : options('fallback-to-legacy'))
      expect(value.counts).toEqual({ legacyModel: 2, runnerModel: 0, tools: 1, dispatch: mode === 'completed' ? 0 : 1 })
    }
  })

  it('fails closed on certified pre-dispatch refusal and missing bridge', async () => {
    for (const value of [fixture({ mode: 'rejected-before-dispatch' }), fixture({ config: { experimentalReadToolGenerateBridge: undefined } })]) {
      await expect(value.agent.generate([new HumanMessage('Read')], options())).rejects.toMatchObject({ replay: 'not-dispatched' })
      expect(value.counts.tools).toBe(0); expect(value.counts.legacyModel).toBe(0)
    }
  })

  it.each(['middleware', 'memory', 'guardrails', 'wrapped', 'tools', 'effect', 'revision', 'timing', 'binding-extension'])(
    'rejects %s before any model/tool work', async (mode) => {
      const config = mode === 'middleware' ? { middleware: [{}] } : mode === 'memory' ? { memoryWriteBack: true }
        : mode === 'guardrails' ? { guardrails: { maxIterations: 4, stuckDetector: false, maxTokens: 100 } }
          : mode === 'wrapped' ? { toolExecution: { wrapToolResults: true } } : mode === 'tools' ? { tools: [] } : {}
      const value = fixture({ config })
      if (mode === 'effect') Object.assign(value.bridge.binding, { effectClass: 'external' })
      if (mode === 'revision') Object.assign(value.bridge.binding, { toolRevision: '' })
      if (mode === 'timing') Object.assign(value.bridge.binding, { timingPolicy: 'unqualified' })
      if (mode === 'binding-extension') Object.assign(value.bridge.binding, { extension: true })
      await expect(value.agent.generate([new HumanMessage('Read')], options())).rejects.toMatchObject({ phase: 'admission', replay: 'not-dispatched' })
      expect(value.counts).toEqual({ legacyModel: 0, runnerModel: 0, tools: 0, dispatch: 0 })
    })

  it.each(['throw', 'mutate-admission', 'source-drift', 'input-drift', 'revision-drift', 'output-drift',
    'unknown-state', 'metadata', 'skip-port', 'double-port', 'repeat-model-read', 'refusal-after-read',
    'failed-after-dispatch', 'outcome-unknown', 'tool-throw'])(
    'forbids replay after %s even with fallback selected', async (mode) => {
      const value = fixture({ mode })
      await expect(value.agent.generate([new HumanMessage('Read')], options('fallback-to-legacy'))).rejects.toMatchObject({
        name: 'AgentRunnerReadToolDelegationError',
      })
      expect(value.counts.legacyModel).toBe(0)
      expect(value.counts.tools).toBeLessThanOrEqual(1)
    })

  it('keeps a thrown bridge error as cause and classifies an abort during dispatch', async () => {
    const thrown = fixture({ mode: 'throw' })
    const failure = await thrown.agent.generate([new HumanMessage('Read')], options('fallback-to-legacy')).catch((e: unknown) => e)
    expect(failure).toMatchObject({ code: 'bridge-threw-with-unknown-outcome', replay: 'forbidden-unknown-outcome',
      message: 'AgentRunner read-tool delegation failed: bridge-threw-with-unknown-outcome' })
    expect((failure as Error).cause).toMatchObject({ message: 'untrusted provider detail' })

    const controller = new AbortController()
    const aborted = fixture({ mode: 'throw', onDispatch() { controller.abort() } })
    const cancelled = await aborted.agent.generate([new HumanMessage('Read')],
      { ...options('fallback-to-legacy'), signal: controller.signal }).catch((e: unknown) => e)
    expect(cancelled).toMatchObject({ code: 'cancelled-during-dispatch', phase: 'outcome-unknown',
      replay: 'forbidden-unknown-outcome', message: 'AgentRunner read-tool delegation failed: cancelled-during-dispatch' })
    expect(aborted.counts.legacyModel).toBe(0)
  })

  it('revokes a retained read port before pre-dispatch fallback', async () => {
    const value = fixture({ mode: 'late-port' })
    await value.agent.generate([new HumanMessage('Read')], options('fallback-to-legacy'))
    await expect(value.requests[0]!.readTool.execute({ runId: 'r5p-run', invocationId: 'late', callId: 'late',
      attempt: 1, input: { recordId: 'one' } })).rejects.toMatchObject({ replay: 'forbidden-after-dispatch' })
    expect(value.counts.tools).toBe(1)
  })

  it.each(['before', 'model', 'read', 'after-read'])('honors cancellation %s without replay', async (when) => {
    const controller = new AbortController()
    const value = fixture({ onModel(turn) {
      if ((when === 'model' && turn === 1) || (when === 'after-read' && turn === 2)) controller.abort()
    }, onRead() { if (when === 'read') controller.abort() } })
    if (when === 'before') controller.abort()
    await expect(value.agent.generate([new HumanMessage('Read')], { ...options('fallback-to-legacy'), signal: controller.signal })).rejects.toMatchObject({
      name: 'AgentRunnerReadToolDelegationError',
    })
    expect(value.counts.legacyModel).toBe(0)
    expect(value.counts.tools).toBe(when === 'read' || when === 'after-read' ? 1 : 0)
  })

  it.each(['hidden', 'accessor', 'inherited', 'symbol', 'both-options'])('rejects %s options without accessor effects', async (mode) => {
    const value = fixture()
    const selected = options()
    let effects = 0
    if (mode === 'hidden') Object.defineProperty(selected, 'experimentalReadToolGenerateDelegation', { enumerable: false })
    if (mode === 'accessor') Object.defineProperty(selected, 'experimentalReadToolGenerateDelegation', {
      enumerable: true, get() { effects += 1; return { enabled: true, preDispatchPolicy: 'fallback-to-legacy' } },
    })
    if (mode === 'inherited') {
      const opt = selected.experimentalReadToolGenerateDelegation
      Reflect.deleteProperty(selected, 'experimentalReadToolGenerateDelegation')
      Object.setPrototypeOf(selected, { experimentalReadToolGenerateDelegation: opt })
    }
    if (mode === 'symbol') Object.assign(selected, { [Symbol('extra')]: true })
    if (mode === 'both-options') Object.assign(selected, { experimentalNoToolGenerateDelegation: { enabled: true, preDispatchPolicy: 'fallback-to-legacy' } })
    await expect(value.agent.generate([new HumanMessage('Read')], selected)).rejects.toMatchObject({ replay: 'not-dispatched' })
    expect(effects).toBe(0); expect(value.counts.tools).toBe(0); expect(value.counts.dispatch).toBe(0)
  })

  it('does not retain unknown message own data behind serialization', async () => {
    const value = fixture()
    const message = new HumanMessage('Read')
    Object.assign(message, { id: 'assigned-after-construction' })
    await expect(value.agent.generate([message], options())).rejects.toMatchObject({ replay: 'not-dispatched' })
    expect(value.counts.dispatch).toBe(0)
  })

  it('launch retains the legacy path when read delegation is present', async () => {
    const value = fixture()
    const handle = await value.agent.launch([new HumanMessage('Read')], { generateOptions: options() })
    expect((await handle.result()).status).toBe('completed')
    expect(value.counts).toEqual({ legacyModel: 2, runnerModel: 0, tools: 1, dispatch: 0 })
  })

  it('structured fallback and schema correction never dispatch read delegation', async () => {
    const value = fixture({ mode: 'structured-correction' })
    const actual = await value.agent.generateStructured([new HumanMessage('Read')], z.object({ answer: z.string() }), options())
    expect(actual.data).toEqual({ answer: 'done' })
    expect(value.counts).toEqual({ legacyModel: 4, runnerModel: 0, tools: 2, dispatch: 0 })
  })

  it.each(['_agentToolDepth', '_memoryReadContext', 'context'])(
    'validates before reading the foreign %s option accessor', async (field) => {
      const value = fixture()
      const selected = options()
      let effects = 0
      Object.defineProperty(selected, field, { enumerable: true, get() { effects += 1; return undefined } })
      await expect(value.agent.generate([new HumanMessage('Read')], selected)).rejects.toMatchObject({ replay: 'not-dispatched' })
      expect(effects).toBe(0)
      expect(value.counts).toEqual({ legacyModel: 0, runnerModel: 0, tools: 0, dispatch: 0 })
    })

  it.each(['fallback-to-legacy', 'invalid-policy'])(
    'does not change admitted fail-closed policy to %s during dispatch', async (next) => {
      const selected = options()
      const value = fixture({ mode: 'rejected-before-dispatch', onDispatch() {
        Object.assign(selected.experimentalReadToolGenerateDelegation, { preDispatchPolicy: next })
      } })
      await expect(value.agent.generate([new HumanMessage('Read')], selected)).rejects.toMatchObject({ replay: 'not-dispatched' })
      expect(value.requests[0]!.admission.policy).toBe('fail-closed')
      expect(value.counts.legacyModel).toBe(0); expect(value.counts.tools).toBe(0)
    })

  it('retains explicitly admitted fallback if caller policy changes to fail-closed', async () => {
    const selected = options('fallback-to-legacy')
    const value = fixture({ mode: 'rejected-before-dispatch', onDispatch() {
      selected.experimentalReadToolGenerateDelegation.preDispatchPolicy = 'fail-closed'
    } })
    await value.agent.generate([new HumanMessage('Read')], selected)
    expect(value.requests[0]!.admission.policy).toBe('fallback-to-legacy')
    expect(value.counts).toEqual({ legacyModel: 2, runnerModel: 0, tools: 1, dispatch: 1 })
  })

  it.each(['model', 'read'])('retains and detaches the original signal when changed during %s', async (when) => {
    const original = new AbortController(), replacement = new AbortController()
    const selected = { ...options('fallback-to-legacy'), signal: original.signal }
    const remove = vi.spyOn(original.signal, 'removeEventListener')
    const add = vi.spyOn(original.signal, 'addEventListener')
    const mutate = () => { selected.signal = replacement.signal; original.abort() }
    const value = fixture({ onModel(turn) { if (when === 'model' && turn === 1) mutate() },
      onRead() { if (when === 'read') mutate() } })
    try {
      await expect(value.agent.generate([new HumanMessage('Read')], selected)).rejects.toMatchObject({ name: 'AgentRunnerReadToolDelegationError' })
      expect(value.requests[0]!.signal).toBe(original.signal)
      const listener = add.mock.calls.find(([kind]) => kind === 'abort')?.[1]
      expect(listener).toBeDefined()
      expect(remove).toHaveBeenCalledWith('abort', listener)
      expect(value.counts.legacyModel).toBe(0)
      expect(value.counts.tools).toBe(when === 'read' ? 1 : 0)
    } finally { remove.mockRestore(); add.mockRestore() }
  })

  it.each(['number', 'object', 'undefined', 'null'])(
    'rejects a %s refusal code without coercion or legacy fallback', async (kind) => {
      const value = fixture()
      let coercions = 0
      const code = kind === 'number' ? 7 : kind === 'undefined' ? undefined : kind === 'null' ? null
        : { toString() { coercions += 1; return 'coerced-code' } }
      value.bridge.dispatch = async (request) => ({ status: 'rejected-before-dispatch', source: request.admission.source, code } as never)
      await expect(value.agent.generate([new HumanMessage('Read')], options('fallback-to-legacy'))).rejects.toMatchObject({ replay: 'forbidden-unknown-outcome' })
      expect(coercions).toBe(0); expect(value.counts.legacyModel).toBe(0); expect(value.counts.tools).toBe(0)
    })

  it('rejects accessor tool arguments before invoking the configured tool', async () => {
    const value = fixture()
    let effects = 0
    const args = Object.defineProperty({}, 'recordId', { enumerable: true, get() { effects += 1; return 'one' } })
    value.bridge.dispatch = async (request) => {
      await request.readTool.execute({ runId: request.admission.source.runId, invocationId: 'invalid-args',
        callId: 'invalid-args', attempt: 1, input: args }).catch(() => {})
      return { status: 'rejected-before-dispatch', source: request.admission.source, code: 'not-ready' }
    }
    await expect(value.agent.generate([new HumanMessage('Read')], options('fallback-to-legacy'))).rejects.toMatchObject({ replay: 'forbidden-after-dispatch' })
    expect(effects).toBe(0); expect(value.counts.tools).toBe(0); expect(value.counts.legacyModel).toBe(0)
  })
})

