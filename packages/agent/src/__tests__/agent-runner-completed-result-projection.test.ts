import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { DzupAgent } from '../agent/dzip-agent.js'
import {
  InMemoryAgentRunner,
  InMemoryAgentRunnerPersistence,
  RunControl,
  type AgentRunnerIdentityKind,
  type AgentRunnerModelInvocationResult,
  type AgentRunnerModelPort,
  type AgentRunnerModelRequest,
  type AgentRunnerModelUsage,
  type AgentRunnerReadOnlyToolPort,
  type AgentRunnerReadOnlyToolRequest,
  type AgentRunnerReadOnlyToolResult,
  type AgentRunnerResult,
} from '../runner.js'
import {
  projectLegacyCompletedRunnerResult,
  type LegacyCompletedResultProjectionInput,
} from '../runner/legacy-runner-completed-result-projection.js'
import {
  buildRunnerProviderFreeExecutionProfile,
} from '../runner/legacy-runner-execution-profile.js'

const behaviorDigest = 'sha256:r5l-provider-free-completed-result'
const userText = 'Read the deterministic records.'
const finalText = 'All deterministic reads completed.'

function deterministicIds(): (kind: AgentRunnerIdentityKind) => string {
  const counters = new Map<AgentRunnerIdentityKind, number>()
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }
}

class ModelFixture implements AgentRunnerModelPort {
  readonly adapterId = 'r5l-provider-free-model/v1'
  readonly calls: AgentRunnerModelRequest[] = []
  readonly #responses: AgentRunnerModelInvocationResult[]

  constructor(responses: AgentRunnerModelInvocationResult[]) {
    this.#responses = [...responses]
  }

  async invoke(request: AgentRunnerModelRequest): Promise<AgentRunnerModelInvocationResult> {
    this.calls.push(request)
    const response = this.#responses.shift()
    if (response === undefined) throw new Error('R5L model fixture exhausted')
    return response
  }
}

class ReadFixture implements AgentRunnerReadOnlyToolPort {
  readonly toolId = 'read-record'
  readonly toolRevision = '1'
  readonly effectClass = 'read' as const
  readonly calls: AgentRunnerReadOnlyToolRequest[] = []
  readonly approval?: AgentRunnerReadOnlyToolPort['approval']
  readonly #unknown: boolean

  constructor(options: { readonly unknown?: boolean; readonly approval?: boolean } = {}) {
    this.#unknown = options.unknown ?? false
    if (options.approval === true) {
      this.approval = {
        requestedBy: { principalId: 'r5l-host', principalType: 'host' },
        decisionPolicyRef: 'policy:r5l-read',
        decisionPolicyRevision: '1',
      }
    }
  }

  async execute(request: AgentRunnerReadOnlyToolRequest): Promise<AgentRunnerReadOnlyToolResult> {
    this.calls.push(request)
    if (this.#unknown) throw new Error('R5L deterministic unknown outcome')
    const recordId = (request.input as { readonly recordId: string }).recordId
    return { status: 'completed', output: `value:${recordId}` }
  }
}

function finalTurn(usage: AgentRunnerModelUsage | undefined = {
  accountingSource: 'provider-free',
  inputTokens: 12,
  outputTokens: 5,
  totalTokens: 17,
}): AgentRunnerModelInvocationResult {
  return {
    status: 'completed',
    item: {
      type: 'message', itemId: 'assistant-final', role: 'assistant',
      content: [{ type: 'text', text: finalText }],
    },
    ...(usage === undefined ? {} : { usage }),
    finishReason: 'stop',
  }
}

function readTurn(callCount: number): AgentRunnerModelInvocationResult {
  return {
    status: 'completed',
    item: {
      type: 'message', itemId: 'assistant-preface', role: 'assistant',
      content: [{ type: 'text', text: 'Reading the records in order.' }],
    },
    additionalItems: Array.from({ length: callCount }, (_, index) => ({
      type: 'tool-call' as const,
      itemId: `tool-call-${index + 1}`,
      callId: `call-${index + 1}`,
      toolId: 'read-record',
      arguments: { recordId: `record-${index + 1}` },
    })),
    usage: {
      accountingSource: 'provider-free', inputTokens: 10, outputTokens: 4, totalTokens: 14,
    },
    finishReason: 'tool-calls',
  }
}

function runnerInput() {
  return {
    agentId: 'r5l-agent',
    behaviorDigest,
    items: [{
      type: 'message' as const,
      itemId: 'input-user',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: userText }],
    }],
  }
}

function runner(model: AgentRunnerModelPort, tools: readonly AgentRunnerReadOnlyToolPort[] = []) {
  return new InMemoryAgentRunner({
    model,
    tools,
    createId: deterministicIds(),
    now: () => '2026-08-10T15:00:00.000Z',
  })
}

function profile(structuredOutputRequested = false) {
  return buildRunnerProviderFreeExecutionProfile({
    behaviorDigest,
    maxModelTurns: 4,
    maxToolAttempts: 2,
    observedMessageCount: 4,
    observedMessageTokens: 256,
    structuredOutputRequested,
  })
}

function project(
  result: AgentRunnerResult,
  options: { readonly structured?: boolean; readonly expectedDigest?: string } = {},
) {
  const admitted = profile(options.structured)
  return projectLegacyCompletedRunnerResult({
    profile: admitted,
    expectedProfileDigest: options.expectedDigest ?? admitted.profileDigest,
    expectedBehaviorDigest: behaviorDigest,
    result,
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fieldStatus(result: ReturnType<typeof project>, name: string) {
  if (result.status !== 'projected') return undefined
  return result.report.fields.find((entry) => entry.field === name)
}

async function completedReads(callCount: number): Promise<AgentRunnerResult> {
  return runner(
    new ModelFixture([readTurn(callCount), finalTurn()]),
    [new ReadFixture()],
  ).run(runnerInput())
}

async function legacyCompletedReads(callCount: number) {
  const responses = [
    new AIMessage({
      content: 'Reading the records in order.',
      tool_calls: Array.from({ length: callCount }, (_, index) => ({
        id: `call-${index + 1}`,
        name: 'read-record',
        args: { recordId: `record-${index + 1}` },
      })),
    }),
    new AIMessage(finalText),
  ]
  const usage = [{ input: 10, output: 4 }, { input: 12, output: 5 }]
  responses.forEach((message, index) => {
    const item = usage[index]
    ;(message as unknown as { usage_metadata: Record<string, number> }).usage_metadata = {
      input_tokens: item?.input ?? 0,
      output_tokens: item?.output ?? 0,
      total_tokens: (item?.input ?? 0) + (item?.output ?? 0),
    }
  })
  const model = {
    invoke: async (_messages: BaseMessage[]) => {
      const response = responses.shift()
      if (response === undefined) throw new Error('R5L legacy fixture exhausted')
      return response
    },
    bindTools() { return this },
  } as unknown as BaseChatModel
  const read = tool(async ({ recordId }: { recordId: string }) => `value:${recordId}`, {
    name: 'read-record',
    description: 'Read one provider-free fixture.',
    schema: z.object({ recordId: z.string() }),
  })
  return new DzupAgent({
    id: 'r5l-agent',
    instructions: 'Use only the deterministic read fixture.',
    model,
    tools: [read],
    toolExecution: { wrapToolResults: false },
  }).generate([new HumanMessage(userText)])
}

describe('AgentRunner R5L completed-result compatibility projector', () => {
  it('projects the exact measured text-only subset without claiming full GenerateResult parity', async () => {
    const result = project(await runner(new ModelFixture([finalTurn()])).run(runnerInput()))
    expect(result.status).toBe('projected')
    if (result.status !== 'projected') return
    expect(result.report).toMatchObject({
      outcome: 'completed',
      fullGenerateResultCompatible: false,
      exactSubset: {
        content: finalText,
        usage: { totalInputTokens: 12, totalOutputTokens: 5, llmCalls: 1 },
        hitIterationLimit: false,
        stopReason: 'complete',
      },
    })
    expect(fieldStatus(result, 'messages')).toMatchObject({
      status: 'different', reason: 'legacy-message-envelope-unrepresented',
    })
    expect(fieldStatus(result, 'toolStats')).toMatchObject({ status: 'exact', value: [] })
  })

  it.each([1, 2])('matches legacy content, usage, and ordered observations for %i read call(s)', async (calls) => {
    const [legacy, runnerResult] = await Promise.all([
      legacyCompletedReads(calls),
      completedReads(calls),
    ])
    const projected = project(runnerResult)
    expect(projected.status).toBe('projected')
    if (projected.status !== 'projected') return
    expect(projected.report.exactSubset).toMatchObject({
      content: legacy.content,
      usage: legacy.usage,
      reads: Array.from({ length: calls }, (_, index) => ({
        callId: `call-${index + 1}`,
        toolId: 'read-record',
        arguments: { recordId: `record-${index + 1}` },
        result: `value:record-${index + 1}`,
      })),
    })
    expect(fieldStatus(projected, 'toolStats')).toMatchObject({
      status: 'unsupported', reason: 'legacy-tool-timing-unrepresented',
    })
    expect(projected.report.fullGenerateResultCompatible).toBe(false)
  })

  it('keeps partial usage unsupported while retaining the exact model-call count', async () => {
    const result = await runner(new ModelFixture([finalTurn({
      accountingSource: 'provider-free', inputTokens: 7,
    })])).run(runnerInput())
    const projected = project(result)
    expect(fieldStatus(projected, 'usage.totalInputTokens')).toMatchObject({
      status: 'unsupported', reason: 'usage-measurement-incomplete',
    })
    expect(fieldStatus(projected, 'usage.totalOutputTokens')).toMatchObject({
      status: 'unsupported', reason: 'usage-measurement-incomplete',
    })
    expect(fieldStatus(projected, 'usage.llmCalls')).toMatchObject({ status: 'exact', value: 1 })
    expect(projected).toMatchObject({ status: 'projected' })
    if (projected.status === 'projected') expect(projected.report).not.toHaveProperty('exactSubset')
  })

  it('keeps structured completion distinct from legacy text content', async () => {
    const base = await runner(new ModelFixture([finalTurn()])).run(runnerInput())
    const structured = clone(base)
    ;(structured.state as unknown as Record<string, unknown>).structuredOutput = {
      schema: 'dzupagent.structuredOutputRequest/v1',
      schemaName: 'r5l.answer',
      schemaDigest: 'sha256:r5l-answer',
      jsonSchema: { type: 'object' },
      allowedStrategies: ['json-text'],
      maxAttempts: 1,
    }
    const projected = project(structured, { structured: true })
    expect(fieldStatus(projected, 'content')).toMatchObject({
      status: 'different', reason: 'structured-output-content-different',
    })
    expect(projected).toMatchObject({ status: 'projected' })
    if (projected.status === 'projected') expect(projected.report).not.toHaveProperty('exactSubset')
  })

  it('rejects structured profile/state drift and does not equate runner context with legacy memory', async () => {
    const base = await runner(new ModelFixture([finalTurn()])).run(runnerInput())
    const structured = clone(base)
    ;(structured.state as unknown as Record<string, unknown>).structuredOutput = {
      schema: 'dzupagent.structuredOutputRequest/v1',
      schemaName: 'r5l.answer',
      schemaDigest: 'sha256:r5l-answer',
      jsonSchema: { type: 'object' },
      allowedStrategies: ['json-text'],
      maxAttempts: 1,
    }
    expect(project(structured)).toEqual({
      status: 'rejected', reasons: ['profile-state-binding-mismatch'],
    })

    const contextual = clone(base)
    ;(contextual.state as unknown as Record<string, unknown>).context = {
      state: 'included', schema: 'r5l.context/v1', value: { retained: true },
    }
    expect(fieldStatus(project(contextual), 'memoryFrame')).toMatchObject({
      status: 'unsupported', reason: 'runner-context-not-legacy-memory',
    })
  })

  it('distinguishes cancelled, known failure, unknown outcome, and suspension', async () => {
    const control = new RunControl()
    expect(control.requestCancel()).toMatchObject({ accepted: true })
    const cancelled = await runner(new ModelFixture([finalTurn()])).run(runnerInput(), { control })
    const known = await runner(new ModelFixture([{
      status: 'failed-before-dispatch',
      code: 'r5l-known-failure',
      category: 'unavailable',
      retryClassification: 'non-retryable',
    }])).run(runnerInput())
    const unknown = await runner(
      new ModelFixture([readTurn(1)]),
      [new ReadFixture({ unknown: true })],
    ).run(runnerInput())
    const suspended = await runner(
      new ModelFixture([readTurn(1)]),
      [new ReadFixture({ approval: true })],
    ).run(runnerInput())

    expect([cancelled, known, unknown, suspended].map((item) => {
      const projected = project(item)
      return projected.status === 'projected' ? projected.report.outcome : projected.status
    })).toEqual(['cancelled', 'failed-known', 'failed-unknown', 'suspended'])
    for (const item of [cancelled, known, unknown, suspended]) {
      expect(fieldStatus(project(item), 'stopReason')).toMatchObject({
        status: 'unsupported', reason: 'runner-outcome-not-legacy-result',
      })
    }
  })

  it('does not project a completed run with prior approval suspension as an uninterrupted result', async () => {
    const persistence = new InMemoryAgentRunnerPersistence()
    const createId = deterministicIds()
    const read = new ReadFixture({ approval: true })
    const suspended = await new InMemoryAgentRunner({
      model: new ModelFixture([readTurn(1)]),
      tools: [read],
      persistence,
      createId,
      now: () => '2026-08-10T15:00:00.000Z',
    }).run(runnerInput())
    const interaction = suspended.state.interactions[0]
    if (interaction === undefined) throw new Error('Expected R5L approval interaction')

    const completed = await new InMemoryAgentRunner({
      model: new ModelFixture([finalTurn()]),
      tools: [read],
      persistence,
      createId,
      now: () => '2026-08-10T15:00:00.000Z',
    }).resume({
      runId: suspended.state.runId,
      behaviorDigest,
      decision: {
        interactionId: interaction.interactionId,
        generation: interaction.generation,
        requestDigest: interaction.requestDigest,
        stateRevision: suspended.state.revision,
        decision: 'approved',
        decisionPolicyRef: interaction.decisionPolicyRef,
        decisionPolicyRevision: interaction.decisionPolicyRevision,
        actor: { principalId: 'r5l-operator', principalType: 'user' },
      },
    })
    const projected = project(completed)
    expect(projected).toMatchObject({
      status: 'projected',
      report: { outcome: 'completed-after-suspension', fullGenerateResultCompatible: false },
    })
    if (projected.status === 'projected') expect(projected.report).not.toHaveProperty('exactSubset')
  })

  it.each([
    ['missing', (value: AgentRunnerResult) => {
      ;(value as unknown as { events: unknown[] }).events = value.events.slice(1)
    }],
    ['duplicate', (value: AgentRunnerResult) => {
      const events = value.events as unknown as Array<Record<string, unknown>>
      if (events[1] !== undefined && events[0] !== undefined) events[1].eventId = events[0].eventId
    }],
    ['reordered', (value: AgentRunnerResult) => {
      const events = value.events as unknown as unknown[]
      ;[events[0], events[1]] = [events[1], events[0]]
    }],
    ['unknown', (value: AgentRunnerResult) => {
      const events = value.events as unknown as Array<Record<string, unknown>>
      if (events[0] !== undefined) events[0].type = 'future.unreviewed'
    }],
  ])('rejects %s event evidence', async (_name, mutate) => {
    const value = clone(await runner(new ModelFixture([finalTurn()])).run(runnerInput()))
    mutate(value)
    expect(project(value)).toMatchObject({ status: 'rejected' })
  })

  it('rejects profile, behavior, and profile-digest drift', async () => {
    const result = await runner(new ModelFixture([finalTurn()])).run(runnerInput())
    expect(project(result, { expectedDigest: 'sha256:stale-profile' })).toEqual({
      status: 'rejected', reasons: ['profile-digest-mismatch'],
    })
    const behavior = clone(result)
    ;(behavior.state.agent as { behaviorDigest: string }).behaviorDigest = 'sha256:changed'
    expect(project(behavior)).toEqual({
      status: 'rejected', reasons: ['behavior-digest-mismatch'],
    })
  })

  it('reconstructs with the same report identity and never invokes injected callbacks', async () => {
    const result = await completedReads(1)
    const first = project(result)
    expect(project(clone(result))).toEqual(first)
    const callback = vi.fn()
    const admitted = profile()
    const candidate = {
      profile: admitted,
      expectedProfileDigest: admitted.profileDigest,
      expectedBehaviorDigest: behaviorDigest,
      result: { ...result, callback },
    } as unknown as LegacyCompletedResultProjectionInput
    expect(projectLegacyCompletedRunnerResult(candidate)).toEqual({
      status: 'rejected', reasons: ['input-not-json-safe'],
    })
    expect(callback).not.toHaveBeenCalled()
  })

  it('rejects sensitive or unrestricted host values without retaining them', async () => {
    const result = await runner(new ModelFixture([finalTurn()])).run(runnerInput())
    const admitted = profile()
    for (const extra of [{ credential: 'not-retained' }, { hostPath: '/not/retained' }]) {
      const candidate = {
        profile: admitted,
        expectedProfileDigest: admitted.profileDigest,
        expectedBehaviorDigest: behaviorDigest,
        result: { ...result, ...extra },
      } as unknown as LegacyCompletedResultProjectionInput
      expect(projectLegacyCompletedRunnerResult(candidate)).toEqual({
        status: 'rejected', reasons: ['input-not-json-safe'],
      })
    }
  })
})
