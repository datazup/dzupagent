import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentMessageItem } from '@dzupagent/agent-types/run'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'

import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig, GenerateOptions } from '../agent/agent-types.js'
import {
  AgentRunnerNoToolDelegationError,
  InMemoryAgentRunner,
  digestRunnerJson,
  validateAgentRunnerNoToolDelegationAdmission,
  validateAgentRunnerNoToolDelegationSource,
  type AgentRunnerIdentityKind,
  type AgentRunnerModelInvocationResult,
  type AgentRunnerModelPort,
  type AgentRunnerModelRequest,
  type AgentRunnerNoToolDelegationBridge,
  type AgentRunnerNoToolDelegationOutcome,
  type AgentRunnerNoToolDelegationRequest,
} from '../runner.js'

const instructions = 'Answer using only the deterministic R5N fixture.'
const measuredUsage = { input: 13, output: 5 }

type BridgeMode =
  | 'completed'
  | 'partial-usage'
  | 'rejected-before-dispatch'
  | 'failed-after-dispatch'
  | 'outcome-unknown'
  | 'envelope-failure'
  | 'source-drift'
  | 'session-state'
  | 'adapter-state'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function response(content: BaseMessage['content'], invalidEnvelope = false): AIMessage {
  const message = new AIMessage({
    content,
    ...(invalidEnvelope ? { response_metadata: { provider: 'unsupported' } } : {}),
  })
  ;(message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
    input_tokens: measuredUsage.input,
    output_tokens: measuredUsage.output,
    total_tokens: measuredUsage.input + measuredUsage.output,
  }
  return message
}

function canonicalContent(content: BaseMessage['content']): AgentMessageItem['content'] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((block) => {
    if (block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') {
      throw new Error('Unsupported R5N fixture content')
    }
    return { type: 'text', text: block.text }
  })
}

function idFactory(runId: string): (kind: AgentRunnerIdentityKind) => string {
  const counts = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    if (kind === 'run') return runId
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    return `${kind}-${next}`
  }
}

class DeterministicBridge implements AgentRunnerNoToolDelegationBridge {
  readonly bridgeId = 'r5n-provider-free-bridge/v1'
  readonly calls: AgentRunnerNoToolDelegationRequest[] = []
  modelCalls = 0

  constructor(
    readonly content: BaseMessage['content'],
    readonly mode: BridgeMode = 'completed',
  ) {}

  async dispatch(
    request: AgentRunnerNoToolDelegationRequest,
  ): Promise<AgentRunnerNoToolDelegationOutcome> {
    this.calls.push(request)
    if (this.mode === 'rejected-before-dispatch') {
      return {
        status: 'rejected-before-dispatch',
        code: 'fixture-not-ready',
        source: request.admission.source,
      }
    }

    const finalAssistant = response(
      this.content,
      this.mode === 'envelope-failure',
    )
    const finalItem: AgentMessageItem = {
      type: 'message',
      itemId: 'r5n-final-assistant',
      role: 'assistant',
      content: canonicalContent(this.content),
    }
    const model: AgentRunnerModelPort = {
      adapterId: 'r5n-provider-free-model/v1',
      invoke: async (_modelRequest: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult> => {
        this.modelCalls += 1
        return {
          status: 'completed',
          item: finalItem,
          usage: this.mode === 'partial-usage'
            ? { accountingSource: 'r5n-fixture', inputTokens: measuredUsage.input }
            : {
                accountingSource: 'r5n-fixture',
                inputTokens: measuredUsage.input,
                outputTokens: measuredUsage.output,
                totalTokens: measuredUsage.input + measuredUsage.output,
              },
          finishReason: 'stop',
        }
      },
    }
    const result = await new InMemoryAgentRunner({
      model,
      createId: idFactory(request.admission.source.runId),
      now: () => '2026-08-10T18:00:00.000Z',
      maxModelTurns: request.admission.maxModelTurns,
      maxToolAttempts: request.admission.maxToolAttempts,
    }).run(request.input, { control: request.control })

    if (this.mode === 'failed-after-dispatch') {
      return {
        status: 'failed-after-dispatch',
        code: 'fixture-failed',
        source: request.admission.source,
      }
    }
    if (this.mode === 'outcome-unknown') {
      return {
        status: 'outcome-unknown',
        code: 'fixture-unknown',
        source: request.admission.source,
      }
    }
    if (this.mode === 'source-drift') {
      const source = clone(request.admission.source)
      ;(source as { profileDigest: string }).profileDigest = 'sha256:drifted-profile'
      const { sourceDigest: _sourceDigest, ...body } = source
      ;(source as { sourceDigest: string }).sourceDigest = digestRunnerJson(body)
      return { status: 'completed', source, result, finalAssistant }
    }

    const retainedResult = clone(result)
    if (this.mode === 'session-state') {
      retainedResult.state.sessionBinding = {
        sessionId: 'fixture-session',
        baseRevision: 'fixture-revision',
      }
    }
    if (this.mode === 'adapter-state') {
      retainedResult.state.adapterState = {
        adapter: { adapterId: 'fixture-adapter', revision: '1' },
      }
    }
    return {
      status: 'completed',
      source: request.admission.source,
      result: retainedResult,
      finalAssistant,
    }
  }
}

function legacyModel(finalAssistant: AIMessage) {
  const messageSnapshots: BaseMessage[][] = []
  const invoke = vi.fn(async (messages: BaseMessage[]) => {
    messageSnapshots.push([...messages])
    return finalAssistant
  })
  const model = {
    invoke,
    bindTools() { return this },
  } as unknown as BaseChatModel
  return { model, invoke, messageSnapshots }
}

function agentConfig(
  model: BaseChatModel,
  bridge?: AgentRunnerNoToolDelegationBridge,
  overrides: Partial<DzupAgentConfig> = {},
): DzupAgentConfig {
  return {
    id: 'r5n-agent',
    instructions,
    model,
    guardrails: { maxIterations: 4, stuckDetector: false },
    ...(bridge === undefined ? {} : { experimentalNoToolGenerateBridge: bridge }),
    ...overrides,
  }
}

function options(
  preDispatchPolicy: 'fail-closed' | 'fallback-to-legacy' = 'fail-closed',
): GenerateOptions {
  return {
    runId: 'r5n-run',
    experimentalNoToolGenerateDelegation: {
      enabled: true,
      preDispatchPolicy,
    },
  }
}

function messageDicts(messages: readonly BaseMessage[]) {
  return messages.map((message) => message.toDict())
}

async function capturedError(run: () => Promise<unknown>): Promise<AgentRunnerNoToolDelegationError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRunnerNoToolDelegationError)
    return error as AgentRunnerNoToolDelegationError
  }
  throw new Error('Expected R5N delegation error')
}

describe('AgentRunner R5N opt-in no-tool generate delegation', () => {
  it.each([
    ['string', 'delegated answer'],
    ['standard text blocks', [{ type: 'text', text: 'delegated block answer' }]],
  ] as const)('delegates %s content once and returns the exact legacy result', async (
    _name,
    finalContent,
  ) => {
    const input = [new HumanMessage(
      typeof finalContent === 'string'
        ? 'return a string'
        : [{ type: 'text', text: 'return a standard block' }],
    )]
    const expectedModel = legacyModel(response(finalContent))
    const expected = await new DzupAgent(agentConfig(expectedModel.model))
      .generate([...input], { runId: 'legacy-run' })

    const bridge = new DeterministicBridge(finalContent)
    const unusedLegacy = legacyModel(response('must not execute'))
    const actual = await new DzupAgent(agentConfig(unusedLegacy.model, bridge))
      .generate([...input], options())

    expect(unusedLegacy.invoke).not.toHaveBeenCalled()
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.modelCalls).toBe(1)
    expect(actual).toMatchObject({
      content: expected.content,
      usage: expected.usage,
      hitIterationLimit: false,
      stopReason: 'complete',
      toolStats: [],
    })
    expect(messageDicts(actual.messages)).toEqual(messageDicts(expected.messages))
  })

  it('keeps default-off and ineligible explicit fallback on the untouched legacy path', async () => {
    const bridge = new DeterministicBridge('unused')
    const defaultLegacy = legacyModel(response('default legacy'))
    const defaultResult = await new DzupAgent(agentConfig(defaultLegacy.model, bridge))
      .generate([new HumanMessage('default')], { runId: 'default-run' })
    expect(defaultResult.content).toBe('default legacy')
    expect(defaultLegacy.invoke).toHaveBeenCalledTimes(1)
    expect(bridge.calls).toHaveLength(0)

    const fallbackLegacy = legacyModel(response('fallback legacy'))
    const fallbackResult = await new DzupAgent(agentConfig(fallbackLegacy.model, bridge))
      .generate([new HumanMessage('fallback')], {
        ...options('fallback-to-legacy'),
        context: 'unsupported delegated context',
      })
    expect(fallbackResult.content).toBe('fallback legacy')
    expect(fallbackLegacy.invoke).toHaveBeenCalledTimes(1)
    expect(bridge.calls).toHaveLength(0)
  })

  it('fails closed before dispatch for tools, structured options, memory, policy drift, and metadata', async () => {
    const fakeTool = {
      name: 'read_fixture',
      description: 'fixture',
      invoke: vi.fn(),
    } as unknown as StructuredToolInterface
    const cases: Array<{
      readonly name: string
      readonly config?: Partial<DzupAgentConfig>
      readonly messages?: BaseMessage[]
      readonly options?: GenerateOptions
    }> = [
      { name: 'tools', config: { tools: [fakeTool] } },
      { name: 'structured', options: { ...options(), schemaName: 'fixture.schema' } },
      { name: 'memory', config: { memoryWriteBack: true } },
      {
        name: 'policy drift',
        options: {
          ...options(),
          experimentalNoToolGenerateDelegation: {
            ...options().experimentalNoToolGenerateDelegation!,
            unsupported: true,
          } as unknown as GenerateOptions['experimentalNoToolGenerateDelegation'],
        },
      },
      {
        name: 'metadata',
        messages: [new HumanMessage({ content: 'named', name: 'unsupported-name' })],
      },
    ]

    for (const testCase of cases) {
      const bridge = new DeterministicBridge('unused')
      const legacy = legacyModel(response('must not execute'))
      const agent = new DzupAgent(agentConfig(legacy.model, bridge, testCase.config))
      const error = await capturedError(() => agent.generate(
        testCase.messages ?? [new HumanMessage(testCase.name)],
        testCase.options ?? options(),
      ))
      expect(error.phase).toBe('admission')
      expect(error.replay).toBe('not-dispatched')
      expect(bridge.calls).toHaveLength(0)
      expect(legacy.invoke).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['partial-usage', 'after-dispatch', 'forbidden-after-dispatch'],
    ['session-state', 'after-dispatch', 'forbidden-after-dispatch'],
    ['adapter-state', 'after-dispatch', 'forbidden-after-dispatch'],
    ['source-drift', 'outcome-unknown', 'forbidden-unknown-outcome'],
  ] as const)('rejects %s evidence without replay', async (mode, phase, replay) => {
    const bridge = new DeterministicBridge('answer', mode)
    const legacy = legacyModel(response('must not replay'))
    const error = await capturedError(() => new DzupAgent(agentConfig(legacy.model, bridge))
      .generate([new HumanMessage(mode)], options()))
    expect(error.phase).toBe(phase)
    expect(error.replay).toBe(replay)
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.modelCalls).toBe(1)
    expect(legacy.invoke).not.toHaveBeenCalled()
  })

  it('performs no bridge or legacy model work when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const bridge = new DeterministicBridge('unused')
    const legacy = legacyModel(response('must not execute'))
    const error = await capturedError(() => new DzupAgent(agentConfig(legacy.model, bridge))
      .generate([new HumanMessage('cancel')], { ...options(), signal: controller.signal }))
    expect(error).toMatchObject({
      code: 'cancelled-before-dispatch',
      phase: 'before-dispatch',
      replay: 'not-dispatched',
    })
    expect(bridge.calls).toHaveLength(0)
    expect(legacy.invoke).not.toHaveBeenCalled()
  })

  it('honors bridge-certified pre-dispatch rejection policy', async () => {
    const fallbackBridge = new DeterministicBridge('unused', 'rejected-before-dispatch')
    const fallbackLegacy = legacyModel(response('legacy fallback'))
    const fallback = await new DzupAgent(agentConfig(fallbackLegacy.model, fallbackBridge))
      .generate([new HumanMessage('fallback')], options('fallback-to-legacy'))
    expect(fallback.content).toBe('legacy fallback')
    expect(fallbackBridge.calls).toHaveLength(1)
    expect(fallbackBridge.modelCalls).toBe(0)
    expect(fallbackLegacy.invoke).toHaveBeenCalledTimes(1)

    const closedBridge = new DeterministicBridge('unused', 'rejected-before-dispatch')
    const closedLegacy = legacyModel(response('must not execute'))
    const error = await capturedError(() => new DzupAgent(agentConfig(closedLegacy.model, closedBridge))
      .generate([new HumanMessage('closed')], options('fail-closed')))
    expect(error).toMatchObject({ phase: 'before-dispatch', replay: 'not-dispatched' })
    expect(closedBridge.calls).toHaveLength(1)
    expect(closedBridge.modelCalls).toBe(0)
    expect(closedLegacy.invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['failed-after-dispatch', 'after-dispatch', 'forbidden-after-dispatch'],
    ['outcome-unknown', 'outcome-unknown', 'forbidden-unknown-outcome'],
  ] as const)('never replays a %s bridge outcome', async (mode, phase, replay) => {
    const bridge = new DeterministicBridge('unused', mode)
    const legacy = legacyModel(response('must not replay'))
    const error = await capturedError(() => new DzupAgent(agentConfig(legacy.model, bridge))
      .generate([new HumanMessage(mode)], options('fallback-to-legacy')))
    expect(error).toMatchObject({ phase, replay })
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.modelCalls).toBe(1)
    expect(legacy.invoke).not.toHaveBeenCalled()
  })

  it('never replays envelope or projection rejection after runner completion', async () => {
    const bridge = new DeterministicBridge('answer', 'envelope-failure')
    const legacy = legacyModel(response('must not replay'))
    const error = await capturedError(() => new DzupAgent(agentConfig(legacy.model, bridge))
      .generate([new HumanMessage('projection')], options('fallback-to-legacy')))
    expect(error).toMatchObject({
      code: 'post-dispatch-envelope-message-metadata-unsupported',
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
    })
    expect(bridge.modelCalls).toBe(1)
    expect(legacy.invoke).not.toHaveBeenCalled()
  })

  it('binds run, snapshot, profile, and input identities across JSON reconstruction', async () => {
    const bridge = new DeterministicBridge('stable answer')
    const legacy = legacyModel(response('must not execute'))
    await new DzupAgent(agentConfig(legacy.model, bridge))
      .generate([new HumanMessage('stable input')], options())

    expect(bridge.calls).toHaveLength(1)
    const request = bridge.calls[0]!
    expect(Object.isFrozen(request.preparedMessages)).toBe(true)
    expect(request.admission.source.runId).toBe('r5n-run')
    expect(request.input.behaviorDigest).toBe(request.admission.source.behaviorDigest)
    expect(request.profile.profileDigest).toBe(request.admission.source.profileDigest)
    expect(digestRunnerJson(request.input)).toBe(request.admission.source.inputDigest)
    expect(validateAgentRunnerNoToolDelegationAdmission(clone(request.admission))).toBe(true)
    expect(validateAgentRunnerNoToolDelegationSource(clone(request.admission.source))).toBe(true)
    expect(digestRunnerJson(clone(request.profile))).toBe(digestRunnerJson(request.profile))
    expect(bridge.modelCalls).toBe(1)
  })

  it('does not adopt generateStructured or launch entry points', async () => {
    const structuredBridge = new DeterministicBridge('unused')
    const structuredLegacy = legacyModel(response('{"answer":"legacy structured"}'))
    const structuredAgent = new DzupAgent(agentConfig(structuredLegacy.model, structuredBridge))
    const structured = await structuredAgent.generateStructured(
      [new HumanMessage('structured')],
      z.object({ answer: z.string() }),
      options(),
    )
    expect(structured.data).toEqual({ answer: 'legacy structured' })
    expect(structuredBridge.calls).toHaveLength(0)
    expect(structuredLegacy.invoke).toHaveBeenCalledTimes(1)

    const launchBridge = new DeterministicBridge('unused')
    const launchLegacy = legacyModel(response('legacy launch'))
    const handle = await new DzupAgent(agentConfig(launchLegacy.model, launchBridge))
      .launch([new HumanMessage('launch')], {
        runId: 'launch-run',
        generateOptions: options(),
      })
    const launched = await handle.result()
    expect(launched.status).toBe('completed')
    expect(launchBridge.calls).toHaveLength(0)
    expect(launchLegacy.invoke).toHaveBeenCalledTimes(1)
  })
})
