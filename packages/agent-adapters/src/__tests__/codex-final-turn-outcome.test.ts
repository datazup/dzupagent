import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalDigestPrefixed, sha256Prefixed } from '@dzupagent/canonical-json'
import { ForgeError } from '@dzupagent/core/events'
import { toFailedEvent, wrapRawEvent } from '../codex/codex-cli-adapter/events.js'
import {
  CODEX_CLI_FINAL_TURN_QUALIFICATION,
  CODEX_FINAL_TURN_OUTCOMES,
  classifyCodexFinalTurn,
  type CodexFinalTurnClassification,
  type CodexFinalTurnExpectation,
  type CodexFinalTurnQualification,
} from '../codex/final-turn-outcome.js'
import type { ModelCapabilityCatalogEntry } from '../model-capability-catalog.js'
import { normalizeCodex } from '../normalize-codex.js'
import { prepareManagedRequest, type ManagedPreparationManifest } from '../prompts/managed-preparation.js'
import type { AgentStreamEvent } from '../types.js'
import { fixtureBinding, fixtureProfile, fixtureRegistry } from './hard-budget-test-fixtures.js'

type RawRecord = Record<string, unknown>
const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-final-turn-events.json', import.meta.url), 'utf8')) as {
  provenance: string; sessionId: string; object: string; otherObject: string; streams: Record<string, RawRecord[]>
}
const SESSION = fixture.sessionId
const OBJECT = JSON.parse(fixture.object) as Record<string, unknown>
const INPUT = { prompt: 'fixture' }
const MODEL = 'provider-free-codex-fixture'
const VERSION = '0.0.0-fixture'

/**
 * The events the Codex CLI adapter yields for raw records: each raw record first, then what the real normalizer
 * maps it to, one started event, and the adapter's fallback that fills an empty completed result from the last
 * assistant message of any turn.
 */
function adapterStream(records: readonly RawRecord[]): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = []
  let started = false
  let lastAssistant = ''
  records.forEach((record, index) => {
    events.push(wrapRawEvent(record, SESSION, INPUT, index + 1))
    const mapped = normalizeCodex(record, SESSION)
    if (!mapped) return
    if (mapped.type === 'adapter:started') {
      if (started) return
      started = true
    }
    if (mapped.type === 'adapter:message' && mapped.role === 'assistant') lastAssistant = mapped.content
    events.push(mapped.type === 'adapter:completed' && !mapped.result && lastAssistant ? { ...mapped, result: lastAssistant } : mapped)
  })
  return events
}
const stream = (name: string): AgentStreamEvent[] => {
  const records = fixture.streams[name]
  if (!records) throw new Error(`no fixture stream ${name}`)
  return adapterStream(records)
}
const adapterFailure = (code: 'ADAPTER_TIMEOUT' | 'AGENT_ABORTED' | 'ADAPTER_EXECUTION_FAILED' | 'CAPABILITY_DENIED', message: string) =>
  toFailedEvent(new ForgeError({ code, message, recoverable: false }), SESSION, INPUT)

const schema = () => ({
  type: 'object', additionalProperties: false, required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer' } } } },
  },
})
/** The text of the file the adapter writes for `--output-schema`. */
const schemaFileText = (value: unknown = schema()) => `${JSON.stringify(value)}\n`
const digest = (value: unknown) => canonicalDigestPrefixed(value, 'adapter-digest-v1')

/** A manifest from the real managed preparation, with or without an output schema. */
function manifest(withSchema = true): ManagedPreparationManifest {
  const catalog: ModelCapabilityCatalogEntry[] = [{
    route: 'codex-cli', modelId: MODEL, connectorVersion: VERSION, qualification: 'fixture',
    capabilities: { 'tool.use/v1': 'unknown', 'streaming/v1': 'unknown', 'structured.output/v1': 'supported' },
  }]
  const content = 'You review changes.'
  const prepared = prepareManagedRequest({
    originalRequest: 'Summarise the change and list the files.',
    binding: { workflowId: 'workflow-1', taskId: 'task-1', attemptId: 'attempt-1', attemptGeneration: 1, expectedTaskVersion: 2 },
    layers: [{ kind: 'persona', ref: 'persona/reviewer', content, contentSha256: sha256Prefixed(content) }],
    descriptorFingerprint: `sha256:${'d'.repeat(64)}`,
    policy: 'POLICY: never push.',
    acceptance: 'ACCEPTANCE: the result names every changed file.',
    templateContext: {},
    declaredVariables: [],
    context: [],
    target: { providerId: 'codex', route: 'codex-cli', connectorVersion: VERSION, modelId: MODEL },
    ...(withSchema ? { outputSchema: schema() } : {}),
    budget: {
      policy: {
        registry: fixtureRegistry([fixtureProfile({ id: 'provider-free-codex-fixture', provider: 'codex', model: MODEL, contextWindowTokens: 20_000 })]),
        binding: fixtureBinding(),
      },
    },
  }, { catalog })
  if (!prepared.ok) throw new Error(`preparation refused: ${prepared.code} ${prepared.detail ?? ''}`)
  return prepared.manifest
}

const FIXTURE_TABLE: CodexFinalTurnQualification = { refused: 'unqualified', truncated: 'unqualified', finalAnswer: 'supported' }
const expectation = (over: Partial<CodexFinalTurnExpectation> = {}): CodexFinalTurnExpectation => ({
  manifest: manifest(),
  schemaText: schemaFileText(),
  observed: { connectorVersion: VERSION, modelId: MODEL },
  ...over,
})
/** Classify with a structured result expected, on the fixture table. */
const expecting = (events: readonly AgentStreamEvent[], over: Partial<CodexFinalTurnExpectation> = {}, table = FIXTURE_TABLE) =>
  classifyCodexFinalTurn({ events, expected: expectation(over) }, table)
const outcome = (value: CodexFinalTurnClassification) => {
  if (value.kind !== 'outcome') throw new Error(`refused: ${value.field}`)
  return value
}
/** `[outcome, reason]`, or `[outcome, source]` for a completed run. */
const verdict = (value: CodexFinalTurnClassification): [string, string | null] => {
  const result = outcome(value)
  return [result.outcome, result.outcome === 'completed' ? result.resultSource : result.reason]
}
const mismatch = (value: CodexFinalTurnClassification) => {
  if (value.kind !== 'refusal') throw new Error(`expected a refusal, got ${value.outcome}`)
  return [value.code, value.field, value.pointer]
}
const withoutEvent = (events: readonly AgentStreamEvent[], index: number) => events.filter((_, position) => position !== index)
const indexOfMessage = (events: readonly AgentStreamEvent[]) => events.findIndex(event => event.type === 'adapter:message')

describe('classifyCodexFinalTurn', () => {
  it('uses shape fixtures that say they are not recordings', () => {
    expect(fixture.provenance).toContain('not a recording')
    expect(Object.keys(fixture.streams).length).toBeGreaterThan(20)
  })

  it('completes with the object of the final message on the fixture table, and without a result when no schema is expected', () => {
    const events = stream('completedObject')
    const result = outcome(expecting(events))
    const messageIndex = indexOfMessage(events)
    expect(result).toEqual({
      kind: 'outcome', outcome: 'completed', result: OBJECT, resultSource: 'final_message',
      usage: { inputTokens: 7, outputTokens: 2 },
      positions: { terminal: events.length - 1, turnStart: 3, result: messageIndex },
    })
    expect(events[messageIndex - 1]?.type).toBe('adapter:provider_raw')

    for (const table of [CODEX_CLI_FINAL_TURN_QUALIFICATION, FIXTURE_TABLE]) {
      expect(outcome(classifyCodexFinalTurn({ events }, table))).toMatchObject({ outcome: 'completed', result: null, resultSource: null })
      expect(outcome(classifyCodexFinalTurn({ events, expected: { manifest: manifest(false) } }, table)))
        .toMatchObject({ outcome: 'completed', result: null, resultSource: null })
    }
    expect(outcome(classifyCodexFinalTurn({ events }))).toMatchObject({ outcome: 'completed', result: null })
    // A marker that names the final answer does not block the message.
    expect(verdict(expecting(stream('messageMarkedFinalAnswer')))).toEqual(['completed', 'final_message'])
  })

  it('binds the schema file text, the tuple and the observed runtime to the manifest', () => {
    const events = stream('completedObject')
    const prepared = manifest()
    expect(digest(JSON.parse(schemaFileText()))).toBe(prepared.outputSchemaSha256)
    expect(expecting(events).kind).toBe('outcome')

    const otherSchema = { ...schema(), required: ['items', 'summary'], properties: { ...schema().properties, summary: { type: 'string', description: 'x' } } }
    expect(mismatch(expecting(events, { schemaText: schemaFileText(otherSchema) }))).toEqual(['qualification_mismatch', 'outputSchemaSha256', undefined])
    expect(mismatch(expecting(events, { schemaText: '{"type":"object"' }))).toEqual(['qualification_mismatch', 'schemaText', undefined])
    expect(mismatch(expecting(events, { schemaText: undefined }))).toEqual(['qualification_mismatch', 'schemaText', undefined])
    for (const target of [
      { ...prepared.target, providerId: 'claude' as const },
      { ...prepared.target, route: 'codex-app-server' as never },
    ]) {
      expect(mismatch(expecting(events, { manifest: { ...prepared, target } }))).toEqual(['qualification_mismatch', 'target', undefined])
    }
    expect(mismatch(expecting(events, { observed: { connectorVersion: '9.9.9', modelId: MODEL } }))).toEqual(['qualification_mismatch', 'connectorVersion', undefined])
    expect(mismatch(expecting(events, { observed: { connectorVersion: null, modelId: MODEL } }))).toEqual(['qualification_mismatch', 'connectorVersion', undefined])
    expect(mismatch(expecting(events, { observed: { connectorVersion: VERSION, modelId: 'another-model' } }))).toEqual(['qualification_mismatch', 'modelId', undefined])
    expect(mismatch(expecting(events, { observed: undefined }))).toEqual(['qualification_mismatch', 'observed', undefined])

    const named = (model: string) => events.map(event => (event.type === 'adapter:started' ? { ...event, model } : event))
    expect(mismatch(expecting(named('another-model')))).toEqual(['qualification_mismatch', 'startedModel', undefined])
    expect(expecting(named(MODEL)).kind).toBe('outcome')

    // A manifest that is not one, or that has no digest field, is checked and never read as "no schema".
    expect(mismatch(expecting(events, { manifest: undefined as never }))).toEqual(['qualification_mismatch', 'target', undefined])
    const { outputSchemaSha256: _dropped, ...withoutDigest } = prepared
    expect(mismatch(expecting(events, { manifest: withoutDigest as never }))).toEqual(['qualification_mismatch', 'outputSchemaSha256', undefined])
  })

  it('refuses a schema outside the pilot subset even when its digest equals the manifest digest', () => {
    const events = stream('completedObject')
    const outside = { ...schema(), properties: { ...schema().properties, summary: { type: 'string', pattern: '^a' } } }
    const forged = { ...manifest(), outputSchemaSha256: digest(outside) }
    expect(mismatch(expecting(events, { manifest: forged, schemaText: schemaFileText(outside) })))
      .toEqual(['qualification_mismatch', 'schemaSubset', '/properties/summary/pattern'])
    const scalar = { ...manifest(), outputSchemaSha256: digest('text') }
    expect(mismatch(expecting(events, { manifest: scalar, schemaText: '"text"' }))).toEqual(['qualification_mismatch', 'schemaSubset', '/'])
  })

  it('returns no structured result on the shipped table', () => {
    expect(CODEX_CLI_FINAL_TURN_QUALIFICATION).toEqual({ refused: 'unqualified', truncated: 'unqualified', finalAnswer: 'unqualified' })
    expect(Object.isFrozen(CODEX_CLI_FINAL_TURN_QUALIFICATION)).toBe(true)
    for (const name of Object.keys(fixture.streams)) {
      const events = stream(name)
      expect(mismatch(classifyCodexFinalTurn({ events, expected: expectation() }))).toEqual(['qualification_mismatch', 'finalAnswer', undefined])
      expect(mismatch(expecting(events, {}, CODEX_CLI_FINAL_TURN_QUALIFICATION))).toEqual(['qualification_mismatch', 'finalAnswer', undefined])
    }
    expect(mismatch(expecting(stream('completedObject'), {}, {} as never))).toEqual(['qualification_mismatch', 'finalAnswer', undefined])
  })

  it('accepts only a final message that is one JSON object', () => {
    for (const name of ['finalProseAroundJson', 'finalFencedObject', 'finalTwoObjects', 'finalArray']) {
      expect([name, ...verdict(expecting(stream(name)))]).toEqual([name, 'failed', 'result_invalid'])
    }
  })

  it('never takes an object from an earlier turn, a stream delta, a tool result or a reasoning item', () => {
    expect(verdict(expecting(stream('objectInEarlierTurn')))).toEqual(['failed', 'result_invalid'])
    for (const name of ['objectInStreamDelta', 'objectInToolResult', 'objectInReasoningItem']) {
      const events = stream(name)
      expect(JSON.stringify(events)).toContain('Two files changed.')
      expect([name, ...verdict(expecting(events))]).toEqual([name, 'failed', 'result_missing'])
    }
  })

  it('never takes commentary as the result, also when its text is a valid object', () => {
    // The only message is followed by a tool call before the turn completes.
    expect(verdict(expecting(stream('messageThenToolCall')))).toEqual(['failed', 'result_unattributed'])
    // The raw record marks the message as commentary.
    expect(verdict(expecting(stream('messageMarkedCommentary')))).toEqual(['failed', 'result_unattributed'])
    // A stream delta of the turn is marked as commentary, by `phase` or by `channel`.
    const base = stream('completedObject')
    const at = indexOfMessage(base) - 1
    for (const marker of [{ phase: 'commentary' }, { channel: 'analysis' }]) {
      const delta = { type: 'adapter:stream_delta', providerId: 'codex', content: fixture.object, timestamp: 0, ...marker } as AgentStreamEvent
      expect(verdict(expecting([...base.slice(0, at), delta, ...base.slice(at)]))).toEqual(['failed', 'result_unattributed'])
    }
    const finalDelta = { type: 'adapter:stream_delta', providerId: 'codex', content: fixture.object, timestamp: 0, phase: 'final_answer' } as AgentStreamEvent
    expect(verdict(expecting([...base.slice(0, at), finalDelta, ...base.slice(at)]))).toEqual(['completed', 'final_message'])
    // The message has no raw record, or its raw record is not an `item.completed` record, or holds another text.
    expect(verdict(expecting(withoutEvent(base, at)))).toEqual(['failed', 'result_unattributed'])
    expect(verdict(expecting(stream('messageNotAnItemRecord')))).toEqual(['failed', 'result_unattributed'])
    const other = wrapRawEvent({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: fixture.otherObject } }, SESSION, INPUT, 99)
    expect(verdict(expecting(base.map((event, index) => (index === at ? other : event))))).toEqual(['failed', 'result_unattributed'])
    const wrongItem = wrapRawEvent({ type: 'item.completed', item: { id: 'item-1', type: 'reasoning', text: fixture.object } }, SESSION, INPUT, 99)
    expect(verdict(expecting(base.map((event, index) => (index === at ? wrongItem : event))))).toEqual(['failed', 'result_unattributed'])
    // A tool call, a tool result or a message of any role after the message does the same without a raw record.
    const later: AgentStreamEvent[] = [
      { type: 'adapter:tool_call', providerId: 'codex', toolName: 'shell', input: { command: 'ls' }, timestamp: 0 },
      { type: 'adapter:tool_result', providerId: 'codex', toolName: 'shell', output: 'a.txt', durationMs: 1, timestamp: 0 },
      { type: 'adapter:message', providerId: 'codex', content: 'note', role: 'system', timestamp: 0 },
    ]
    for (const event of later) {
      expect([event.type, ...verdict(expecting([...base.slice(0, at + 2), event, ...base.slice(at + 2)]))])
        .toEqual([event.type, 'failed', 'result_unattributed'])
    }
    // A raw item record after the message takes the attribution away; a raw record of the thread does not.
    const reasoning = wrapRawEvent({ type: 'item.completed', item: { id: 'item-9', type: 'reasoning', text: 'thinking' } }, SESSION, INPUT, 99)
    expect(verdict(expecting([...base.slice(0, at + 2), reasoning, ...base.slice(at + 2)]))).toEqual(['failed', 'result_unattributed'])
    const repeated = stream('threadRecordAfterMessage')
    expect(repeated.filter(event => event.type === 'adapter:started')).toHaveLength(1)
    expect(repeated.at(-3)).toMatchObject({ type: 'adapter:provider_raw', rawEvent: { payload: { type: 'thread.started' } } })
    expect(outcome(expecting(repeated))).toMatchObject({ outcome: 'completed', result: OBJECT, resultSource: 'final_message' })
  })

  it('lets the native terminal result win and never trusts the adapter fallback', () => {
    expect(verdict(expecting(stream('nativeInvalidNextToValidMessage')))).toEqual(['failed', 'result_invalid'])
    const alone = stream('nativeAlone')
    expect(outcome(expecting(alone))).toMatchObject({
      outcome: 'completed', result: OBJECT, resultSource: 'native', positions: { terminal: alone.length - 1, result: alone.length - 2 },
    })
    expect(verdict(expecting(stream('nativeNextToSameMessage')))).toEqual(['completed', 'native'])
    expect(verdict(expecting(stream('nativeNextToDifferentMessage')))).toEqual(['failed', 'result_conflict'])
    // Only a final message conflicts. Commentary, or a message followed by a tool call, leaves the native result.
    for (const name of ['nativeNextToCommentary', 'nativeAfterMessageAndToolCall']) {
      expect([name, outcome(expecting(stream(name)))]).toMatchObject([name, { outcome: 'completed', result: OBJECT, resultSource: 'native' }])
    }

    // The second turn has no message. The adapter fills its completed result from the first turn; that is not used.
    const second = stream('secondTurnWithoutMessage')
    expect(second.at(-1)).toMatchObject({ type: 'adapter:completed', result: fixture.object })
    expect(verdict(expecting(second))).toEqual(['failed', 'result_missing'])
    // A completed event that carries a result without a raw terminal record is the same case.
    const bare = [...stream('errorRecord').slice(0, 3), { ...second.at(-1) } as AgentStreamEvent]
    expect(verdict(expecting(bare))).toEqual(['failed', 'result_missing'])
  })

  it('maps abort, cancel, timeout and failures, and a stream without a terminal event', () => {
    const open = stream('turnFailedRecord').slice(0, 3)
    const cancelled = {
      type: 'recovery:cancelled', providerId: 'codex', strategy: 'abort', error: 'cancelled', totalAttempts: 1, totalDurationMs: 5, timestamp: 0,
    } as AgentStreamEvent
    const cases: [AgentStreamEvent[], unknown][] = [
      [[...open, adapterFailure('AGENT_ABORTED', 'run was aborted')], ['interrupted', 'aborted', 'AGENT_ABORTED']],
      [[...open, cancelled], ['interrupted', 'aborted', null]],
      [[...open, adapterFailure('ADAPTER_TIMEOUT', 'run timed out')], ['interrupted', 'timeout', 'ADAPTER_TIMEOUT']],
      [stream('errorRecord'), ['failed', 'adapter_failed', 'server_error']],
      [[...open, adapterFailure('ADAPTER_EXECUTION_FAILED', 'process exited with code 2')], ['failed', 'adapter_failed', 'ADAPTER_EXECUTION_FAILED']],
      // The raw `turn.failed` record maps to nothing; the adapter then fails because no terminal event arrived.
      [[...stream('turnFailedRecord'), adapterFailure('CAPABILITY_DENIED', 'Native Codex terminal event is missing')], ['failed', 'adapter_failed', 'CAPABILITY_DENIED']],
      [stream('turnFailedRecord'), ['failed', 'terminal_missing', null]],
      [stream('noTerminal'), ['failed', 'terminal_missing', null]],
      [[], ['failed', 'terminal_missing', null]],
    ]
    for (const [events, expected] of cases) {
      for (const classified of [classifyCodexFinalTurn({ events }), expecting(events)]) {
        const result = outcome(classified)
        if (result.outcome === 'completed') throw new Error('expected no completed outcome')
        expect([result.outcome, result.reason, result.code]).toEqual(expected)
        expect('result' in result).toBe(false)
      }
    }
  })

  it('decides by the last terminal event', () => {
    expect(verdict(expecting(stream('completedThenFailed')))).toEqual(['failed', 'adapter_failed'])
    expect(verdict(classifyCodexFinalTurn({ events: stream('completedThenFailed') }))).toEqual(['failed', 'adapter_failed'])
    const recovered = stream('failedThenCompleted')
    expect(outcome(expecting(recovered))).toMatchObject({ outcome: 'completed', result: OBJECT, resultSource: 'final_message' })
    expect(verdict(classifyCodexFinalTurn({ events: recovered }))).toEqual(['completed', null])
  })

  it('never returns refused or truncated, with any table', () => {
    expect(CODEX_FINAL_TURN_OUTCOMES).toEqual(['completed', 'refused', 'truncated', 'interrupted', 'failed'])
    const tables: CodexFinalTurnQualification[] = [
      CODEX_CLI_FINAL_TURN_QUALIFICATION, FIXTURE_TABLE, { refused: 'supported', truncated: 'supported', finalAnswer: 'supported' },
    ]
    const refusalWording = adapterStream([
      { type: 'thread.started', thread_id: SESSION }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'I cannot help with that request.' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const cutShort = adapterStream([
      { type: 'thread.started', thread_id: SESSION }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: '{"summary":"Two files cha' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const seen = new Set<string>()
    for (const events of [...Object.keys(fixture.streams).map(stream), refusalWording, cutShort]) {
      for (const table of tables) {
        for (const classified of [classifyCodexFinalTurn({ events }, table), expecting(events, {}, table)]) {
          if (classified.kind === 'outcome') seen.add(classified.outcome)
        }
      }
    }
    expect([...seen].sort()).toEqual(['completed', 'failed'])
    expect(verdict(expecting(refusalWording))).toEqual(['failed', 'result_invalid'])
    expect(verdict(expecting(cutShort))).toEqual(['failed', 'result_invalid'])
  })

  it('gives equal output for equal input and does not change its input', () => {
    const freeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const item of Object.values(value)) freeze(item)
      }
      return value
    }
    for (const name of Object.keys(fixture.streams)) {
      const events = freeze(stream(name))
      const expected = freeze(expectation())
      const before = JSON.stringify([events, expected])
      const first = classifyCodexFinalTurn({ events, expected }, FIXTURE_TABLE)
      const second = classifyCodexFinalTurn({ events, expected }, FIXTURE_TABLE)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      expect(JSON.stringify(classifyCodexFinalTurn({ events }))).toBe(JSON.stringify(classifyCodexFinalTurn({ events })))
      expect(JSON.stringify([events, expected])).toBe(before)
    }
  })
})
