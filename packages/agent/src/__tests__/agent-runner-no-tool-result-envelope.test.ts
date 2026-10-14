import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentMessageItem } from '@dzupagent/agent-types/run'
import { describe, expect, it, vi } from 'vitest'

import { DzupAgent } from '../agent/dzip-agent.js'
import {
  InMemoryAgentRunner,
  RunControl,
  digestRunnerJson,
  type AgentRunnerIdentityKind,
  type AgentRunnerInput,
  type AgentRunnerModelInvocationResult,
  type AgentRunnerModelPort,
  type AgentRunnerModelRequest,
  type AgentRunnerResult,
} from '../runner.js'
import {
  captureLegacyNoToolResultEnvelope,
  projectLegacyNoToolGenerateResult,
  type LegacyNoToolResultEnvelope,
} from '../runner/legacy-runner-no-tool-result-envelope.js'
import {
  buildRunnerProviderFreeExecutionProfile,
  type LegacyRunnerExecutionProfile,
} from '../runner/legacy-runner-execution-profile.js'

const behaviorDigest = 'sha256:r5m-provider-free-no-tool-result'
const instructions = 'Answer using only the deterministic provider-free fixture.'
const usage = { input: 11, output: 4 }

function ids(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

function profile(
  projection: 'runner-direct-only' | 'no-tool-generate-result/v1' =
    'no-tool-generate-result/v1',
): LegacyRunnerExecutionProfile {
  return buildRunnerProviderFreeExecutionProfile({
    behaviorDigest,
    maxModelTurns: 4,
    maxToolAttempts: 2,
    observedMessageCount: 8,
    observedMessageTokens: 256,
    structuredOutputRequested: false,
    legacyResultProjection: projection,
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function runnerRole(message: BaseMessage): AgentMessageItem['role'] {
  const role = message._getType()
  if (role === 'system') return 'system'
  if (role === 'human') return 'user'
  if (role === 'ai') return 'assistant'
  throw new Error(`Unsupported R5M fixture role ${role}`)
}

function runnerContent(message: BaseMessage): AgentMessageItem['content'] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return message.content.map((block) => {
    const text = 'text' in block ? block.text : undefined
    if (block.type !== 'text' || typeof text !== 'string') {
      throw new Error('Unsupported R5M fixture block')
    }
    return { type: 'text', text }
  })
}

function item(message: BaseMessage, itemId: string): AgentMessageItem {
  return {
    type: 'message',
    itemId,
    role: runnerRole(message),
    content: runnerContent(message),
  }
}

class Model implements AgentRunnerModelPort {
  readonly adapterId = 'r5m-provider-free-model/v1'
  readonly requests: AgentRunnerModelRequest[] = []

  constructor(readonly response: AgentRunnerModelInvocationResult) {}

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult> {
    this.requests.push(request)
    return this.response
  }
}

function runnerInput(preparedInput: readonly BaseMessage[]): AgentRunnerInput {
  return {
    agentId: 'r5m-agent',
    behaviorDigest,
    items: preparedInput.map((message, index) => item(message, `input-${index + 1}`)),
  }
}

function runnerResponse(finalAssistant: BaseMessage, completeUsage = true): AgentRunnerModelInvocationResult {
  return {
    status: 'completed',
    item: item(finalAssistant, 'assistant-final'),
    usage: completeUsage
      ? {
          accountingSource: 'provider-free-r5m',
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.input + usage.output,
        }
      : { accountingSource: 'provider-free-r5m', inputTokens: usage.input },
    finishReason: 'stop',
  }
}

async function legacyResult(
  input: readonly BaseMessage[],
  finalContent: BaseMessage['content'],
) {
  const finalAssistant = new AIMessage(finalContent)
  ;(finalAssistant as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
  }
  const calls: BaseMessage[][] = []
  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      calls.push([...messages])
      return finalAssistant
    }),
    bindTools() { return this },
  } as unknown as BaseChatModel
  const result = await new DzupAgent({
    id: 'r5m-agent',
    instructions,
    model,
    guardrails: { maxIterations: 4 },
  }).generate([...input])
  const preparedInput = calls[0]
  if (preparedInput === undefined) throw new Error('Expected R5M legacy model call')
  return { result, preparedInput, finalAssistant }
}

async function scenario(
  input: readonly BaseMessage[],
  finalContent: BaseMessage['content'],
  completeUsage = true,
) {
  const legacy = await legacyResult(input, finalContent)
  const runner = await new InMemoryAgentRunner({
    model: new Model(runnerResponse(legacy.finalAssistant, completeUsage)),
    createId: ids(),
    now: () => '2026-08-10T17:00:00.000Z',
  }).run(runnerInput(legacy.preparedInput))
  const admitted = profile()
  const captured = captureLegacyNoToolResultEnvelope({
    profile: admitted,
    preparedInput: legacy.preparedInput,
    finalAssistant: legacy.finalAssistant,
    result: runner,
  })
  if (captured.status !== 'captured') {
    throw new Error(`R5M envelope capture rejected: ${captured.reasons.join(',')}`)
  }
  return { legacy, runner, admitted, envelope: captured.envelope }
}

function project(
  admitted: LegacyRunnerExecutionProfile,
  envelope: LegacyNoToolResultEnvelope,
  result: AgentRunnerResult,
  expectedEnvelopeDigest = envelope.envelopeDigest,
) {
  return projectLegacyNoToolGenerateResult({
    profile: admitted,
    expectedProfileDigest: admitted.profileDigest,
    expectedBehaviorDigest: behaviorDigest,
    expectedEnvelopeDigest,
    envelope,
    result,
  })
}

function messageDicts(messages: readonly BaseMessage[]) {
  return messages.map((message) => message.toDict())
}

describe('AgentRunner R5M no-tool legacy result envelope', () => {
  it.each([
    ['string', [new HumanMessage('Return one answer.')], 'deterministic answer'],
    [
      'standard text blocks',
      [new HumanMessage([{ type: 'text', text: 'Return one block answer.' }])],
      [{ type: 'text', text: 'deterministic block answer' }],
    ],
  ] as const)('reconstructs the complete legacy GenerateResult for %s content', async (
    _name,
    input,
    finalContent,
  ) => {
    const value = await scenario(
      input,
      typeof finalContent === 'string' ? finalContent : finalContent.map((block) => ({ ...block })),
    )
    const projected = project(value.admitted, value.envelope, value.runner)
    expect(projected.status).toBe('projected')
    if (projected.status !== 'projected') return
    expect(projected.result).toMatchObject({
      content: value.legacy.result.content,
      usage: value.legacy.result.usage,
      hitIterationLimit: false,
      stopReason: 'complete',
      toolStats: [],
    })
    expect(Object.keys(projected.result).sort()).toEqual(
      ['content', 'hitIterationLimit', 'messages', 'stopReason', 'toolStats', 'usage'].sort(),
    )
    expect(messageDicts(projected.result.messages)).toEqual(
      messageDicts(value.legacy.result.messages),
    )
    expect(projected.report.fullGenerateResultCompatible).toBe(true)
  })

  it('preserves exact system, multiple-user, historical-assistant, and content encoding order', async () => {
    const input = [
      new HumanMessage('first user'),
      new AIMessage('historical assistant'),
      new HumanMessage([{ type: 'text', text: 'second user' }]),
    ]
    const value = await scenario(input, 'final answer')
    const projected = project(value.admitted, value.envelope, value.runner)
    expect(projected.status).toBe('projected')
    if (projected.status !== 'projected') return
    expect(projected.result.messages.map((message) => message._getType()))
      .toEqual(['system', 'human', 'ai', 'human', 'ai'])
    expect(messageDicts(projected.result.messages)).toEqual(
      messageDicts(value.legacy.result.messages),
    )
    expect(value.envelope.preparedInput.map((entry) => entry.content.encoding))
      .toEqual(['string', 'string', 'string', 'standard-text-blocks'])
  })

  it('reconstructs from JSON with deterministic envelope and result identities', async () => {
    const value = await scenario([new HumanMessage('json round trip')], 'stable result')
    const first = project(value.admitted, value.envelope, value.runner)
    const second = project(clone(value.admitted), clone(value.envelope), clone(value.runner))
    expect(second).toMatchObject({
      status: 'projected',
      report: first.status === 'projected' ? first.report : {},
    })
    if (first.status !== 'projected' || second.status !== 'projected') return
    expect(messageDicts(second.result.messages)).toEqual(messageDicts(first.result.messages))
  })

  it('keeps prior direct-runner profiles disabled and requires the named R5M admission', async () => {
    const value = await scenario([new HumanMessage('profile binding')], 'answer')
    const direct = profile('runner-direct-only')
    expect(captureLegacyNoToolResultEnvelope({
      profile: direct,
      preparedInput: value.legacy.preparedInput,
      finalAssistant: value.legacy.finalAssistant,
      result: value.runner,
    })).toEqual({ status: 'rejected', reasons: ['projection-profile-required'] })
    expect(project(direct, value.envelope, value.runner)).toMatchObject({ status: 'rejected' })
  })

  it('rejects tools, structured output, partial usage, and state extensions independently', async () => {
    const value = await scenario([new HumanMessage('narrow subset')], 'answer')
    const withTool = clone(value.runner)
    ;(withTool.state.committedItems as unknown as unknown[]).splice(0, 0, {
      type: 'tool-call', itemId: 'tool-call', callId: 'call', toolId: 'read', arguments: {},
    })
    expect(project(value.admitted, value.envelope, withTool)).toEqual({
      status: 'rejected', reasons: ['result-not-no-tool'],
    })

    const structured = clone(value.runner)
    ;(structured.state as unknown as Record<string, unknown>).structuredOutput = {
      schema: 'dzupagent.structuredOutputRequest/v1', schemaName: 'r5m.answer',
      schemaDigest: 'sha256:r5m', jsonSchema: { type: 'object' },
      allowedStrategies: ['json-text'], maxAttempts: 1,
    }
    expect(project(value.admitted, value.envelope, structured)).toEqual({
      status: 'rejected', reasons: ['result-state-extension-unsupported'],
    })

    const partial = await scenario([new HumanMessage('partial usage')], 'answer', false)
    expect(project(partial.admitted, partial.envelope, partial.runner)).toEqual({
      status: 'rejected', reasons: ['completed-result-evidence-inexact'],
    })

    for (const key of ['sessionBinding', 'adapterState', 'sandboxRef'] as const) {
      const extended = clone(value.runner)
      ;(extended.state as unknown as Record<string, unknown>)[key] = key === 'sessionBinding'
        ? { sessionId: 'session', baseRevision: 'revision' }
        : key === 'adapterState'
          ? { adapter: { adapterId: 'fixture', revision: '1' } }
          : { sandboxId: 'sandbox', manifestDigest: 'sha256:manifest' }
      expect(project(value.admitted, value.envelope, extended)).toEqual({
        status: 'rejected', reasons: ['result-state-extension-unsupported'],
      })
    }
  })

  it('rejects cancellation, suspension history, and source/profile/envelope drift', async () => {
    const value = await scenario([new HumanMessage('fail closed')], 'answer')
    const control = new RunControl()
    expect(control.requestCancel()).toMatchObject({ accepted: true })
    const cancelled = await new InMemoryAgentRunner({
      model: new Model(runnerResponse(value.legacy.finalAssistant)),
      createId: ids(),
      now: () => '2026-08-10T17:00:00.000Z',
    }).run(runnerInput(value.legacy.preparedInput), { control })
    expect(project(value.admitted, value.envelope, cancelled)).toEqual({
      status: 'rejected', reasons: ['result-not-uninterrupted-completion'],
    })

    const suspended = clone(value.runner)
    const nonterminal = suspended.events.find((event) => event.type === 'model.requested')
    if (nonterminal === undefined) throw new Error('Expected model request')
    ;(nonterminal as unknown as { type: string }).type = 'run.suspended'
    expect(project(value.admitted, value.envelope, suspended)).toEqual({
      status: 'rejected', reasons: ['result-not-uninterrupted-completion'],
    })

    const schema = clone(value.envelope)
    ;(schema as unknown as { schema: string }).schema = 'future.envelope/v2'
    expect(project(value.admitted, schema, value.runner)).toMatchObject({ status: 'rejected' })

    const digest = clone(value.envelope)
    ;(digest.finalAssistant as { itemDigest: string }).itemDigest = 'sha256:changed'
    expect(project(value.admitted, digest, value.runner)).toEqual({
      status: 'rejected', reasons: ['envelope-digest-mismatch'],
    })

    const binding = clone(value.envelope)
    ;(binding.finalAssistant as { itemDigest: string }).itemDigest = 'sha256:changed'
    const { envelopeDigest: _bindingDigest, ...bindingBody } = binding
    ;(binding as { envelopeDigest: string }).envelopeDigest = digestRunnerJson(bindingBody)
    expect(project(
      value.admitted,
      binding,
      value.runner,
      binding.envelopeDigest,
    )).toEqual({ status: 'rejected', reasons: ['message-binding-mismatch'] })

    const reordered = clone(value.envelope)
    ;(reordered.preparedInput as LegacyNoToolResultEnvelope['preparedInput'][number][]).reverse()
    const { envelopeDigest: _reorderedDigest, ...reorderedBody } = reordered
    ;(reordered as { envelopeDigest: string }).envelopeDigest = digestRunnerJson(reorderedBody)
    expect(project(
      value.admitted,
      reordered,
      value.runner,
      reordered.envelopeDigest,
    )).toEqual({ status: 'rejected', reasons: ['message-envelope-malformed'] })

    const source = clone(value.envelope)
    ;(source.source as { stateRevision: number }).stateRevision += 1
    const { envelopeDigest: _old, ...body } = source
    ;(source as { envelopeDigest: string }).envelopeDigest = digestRunnerJson(body)
    expect(project(value.admitted, source, value.runner)).toEqual({
      status: 'rejected', reasons: ['source-binding-mismatch'],
    })
  })

  it('rejects unsupported metadata/content and never invokes injected callbacks', async () => {
    const value = await scenario([new HumanMessage('sanitized')], 'answer')
    const named = new HumanMessage({ content: 'named', name: 'retained-name' })
    expect(captureLegacyNoToolResultEnvelope({
      profile: value.admitted,
      preparedInput: [named],
      finalAssistant: value.legacy.finalAssistant,
      result: value.runner,
    })).toMatchObject({ status: 'rejected' })

    const providerMetadata = new AIMessage({
      content: 'answer',
      response_metadata: { finish_reason: 'stop' },
    })
    expect(captureLegacyNoToolResultEnvelope({
      profile: value.admitted,
      preparedInput: value.legacy.preparedInput,
      finalAssistant: providerMetadata,
      result: value.runner,
    })).toEqual({ status: 'rejected', reasons: ['message-metadata-unsupported'] })

    const unsupportedContent = new HumanMessage([{
      type: 'image_url', image_url: { url: 'https://invalid.local/image' },
    }])
    expect(captureLegacyNoToolResultEnvelope({
      profile: value.admitted,
      preparedInput: [unsupportedContent, ...value.legacy.preparedInput.slice(1)],
      finalAssistant: value.legacy.finalAssistant,
      result: value.runner,
    })).toEqual({ status: 'rejected', reasons: ['message-content-unsupported'] })

    const callback = vi.fn()
    const candidate = {
      profile: value.admitted,
      expectedProfileDigest: value.admitted.profileDigest,
      expectedBehaviorDigest: behaviorDigest,
      expectedEnvelopeDigest: value.envelope.envelopeDigest,
      envelope: value.envelope,
      result: value.runner,
      callback,
    } as unknown as Parameters<typeof projectLegacyNoToolGenerateResult>[0]
    expect(projectLegacyNoToolGenerateResult(candidate)).toEqual({
      status: 'rejected', reasons: ['input-not-json-safe'],
    })
    expect(callback).not.toHaveBeenCalled()

    const cleanInput = {
      profile: value.admitted,
      expectedProfileDigest: value.admitted.profileDigest,
      expectedBehaviorDigest: behaviorDigest,
      expectedEnvelopeDigest: value.envelope.envelopeDigest,
      envelope: value.envelope,
      result: value.runner,
    }
    expect(projectLegacyNoToolGenerateResult({
      ...cleanInput,
      futureEvidence: true,
    } as unknown as Parameters<typeof projectLegacyNoToolGenerateResult>[0])).toEqual({
      status: 'rejected', reasons: ['projection-input-malformed'],
    })
    for (const extra of [{ credential: 'not-retained' }, { hostPath: '/not/retained' }]) {
      expect(projectLegacyNoToolGenerateResult({
        ...cleanInput,
        ...extra,
      } as unknown as Parameters<typeof projectLegacyNoToolGenerateResult>[0])).toEqual({
        status: 'rejected', reasons: ['input-not-json-safe'],
      })
    }
  })
})
