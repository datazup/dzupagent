import { expect, test } from 'vitest'
import { AIMessage, ToolMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { compactCompletedToolResults } from '../tool-results/compact-completed-tool-results.js'
import { cloneCompactedToolMessage, contentText, measureMessages, safeMessageType, safeToolCalls, COMPACTED_CONTENT } from '../tool-results/compaction-internals.js'
import type { CompletedToolCompactionProfileV1 } from '../tool-results/types.js'
import { __internals } from '../tiktoken-counter.js'

const profile: CompletedToolCompactionProfileV1 = { schema: 'datazup.context.completed-tool-compaction-profile/v1', preserveRecentCompletedPairs: 0, minimumResultTokens: 1, maxCompactedResults: 1, measurement: 'allow-heuristic' }
test('malformed profiles fail closed without touching transcript or invoking accessors', () => {
  const messages = [new HumanMessage('fixture')]
  for (const extra of [{ unknown: 1 }, { schema: 'wrong' }, { preserveRecentCompletedPairs: -1 }, { minimumResultTokens: 0 }, { maxCompactedResults: 257 }, { targetReclaimedTokens: NaN }, { measurement: 'wrong' }]) {
    const result = compactCompletedToolResults(messages, { ...profile, ...extra } as CompletedToolCompactionProfileV1)
    expect(result.reason).toBe('invalid-profile')
    expect(result.messages).toBe(messages)
  }
  let invoked = false
  const hostile = Object.defineProperty({ ...profile }, 'schema', { get() { invoked = true; throw new Error('getter') } })
  expect(compactCompletedToolResults(messages, hostile).reason).toBe('invalid-profile')
  expect(invoked).toBe(false)
})
test('compaction preserves the transcript when per-result or replacement measurement becomes untrusted', () => {
  const call = new AIMessage({ content: 'calling', tool_calls: [{ id: 'call', name: 'lookup', args: {} }] })
  const result = new ToolMessage({ content: 'x'.repeat(1000), tool_call_id: 'call', id: 'stable', name: 'lookup', status: 'success', artifact: {} })
  const messages = [call, result]
  for (const failAt of [2, 3]) {
    let count = 0
    const tokenCounter = { count: () => 1, countDetailed: () => { count++; if (count === failAt) throw new Error('counter unavailable'); return { tokens: count === 1 ? 1000 : 500, method: 'exact' as const } } }
    expect(compactCompletedToolResults(messages, { ...profile, measurement: 'require-tokenizer' }, { tokenCounter }).reason).toBe('token-measurement-unproven')
  }
  let count = 0
  const tokenCounter = { count: () => 1, countDetailed: () => ({ tokens: ++count === 1 ? 1000 : 500, method: count === 3 ? 'heuristic' as const : 'exact' as const }) }
  expect(compactCompletedToolResults(messages, { ...profile, measurement: 'require-tokenizer' }, { tokenCounter }).reason).toBe('token-measurement-unproven')
  expect(compactCompletedToolResults([call, new ToolMessage({ content: COMPACTED_CONTENT, tool_call_id: 'call' })], profile).reason).toBe('no-token-reclamation')
  expect(compactCompletedToolResults([call, new ToolMessage({ content: 'large', tool_call_id: 'call', artifact: () => {} })], profile).reason).toBe('clone-rejected')
  const clone = cloneCompactedToolMessage(result)
  expect(clone).toMatchObject({ id: 'stable', name: 'lookup', status: 'success' })
  expect(() => measureMessages([Object.assign(new HumanMessage('fixture'), { _getType: () => 1 }) as unknown as BaseMessage], {})).toThrow(/invalid message/)
  expect(() => measureMessages([Object.assign(new ToolMessage({ content: 'fixture', tool_call_id: 'call' }), { tool_call_id: 1 }) as unknown as BaseMessage], {})).toThrow(/invalid tool call/)
  for (const value of [null, new Proxy(new HumanMessage('fixture'), {}), Object.assign(new HumanMessage('fixture'), { _getType: undefined })]) expect(safeMessageType(value as unknown as BaseMessage)).toBeNull()
  const malformedCall = new AIMessage('fixture'); Object.defineProperty(malformedCall, 'tool_calls', { value: [null], configurable: true })
  expect(compactCompletedToolResults([malformedCall], profile).reason).toBe('invalid-tool-pairing')
  const accessorCall = Object.defineProperty({}, 'id', { get() { throw new Error('untrusted') } }); Object.defineProperty(malformedCall, 'tool_calls', { value: [accessorCall], configurable: true })
  expect(compactCompletedToolResults([malformedCall], profile).reason).toBe('invalid-tool-pairing')
})

test('compaction cloning refuses unsafe values and retains supported detached artifact types', () => {
  const artifact = { map: new Map([['key', { value: 1 }]]), set: new Set(['value']), date: new Date(0), regexp: /fixture/, buffer: new Uint8Array([1]), bigint: 1n, nil: null }
  const original = new ToolMessage({ content: 'long output', tool_call_id: 'call', artifact })
  const clone = cloneCompactedToolMessage(original)
  expect(clone.artifact).toEqual(artifact)
  expect(clone.artifact).not.toBe(artifact)
  for (const value of [NaN, () => {}, Symbol('fixture'), new WeakMap(), new Proxy({}, {}), Object.defineProperty({}, 'value', { get() { throw new Error('getter') } }), 'x'.repeat(4_000_001)]) {
    expect(() => cloneCompactedToolMessage(new ToolMessage({ content: 'output', tool_call_id: 'call', artifact: value }))).toThrow(/clone rejected/)
  }
  expect(() => contentText(new HumanMessage('x'.repeat(4_000_001)))).toThrow(/too large/)
  expect(() => measureMessages([new HumanMessage({ content: 'a', name: 'x'.repeat(1025) })], {})).toThrow(/invalid name/)
  expect(safeMessageType({ _getType: () => { throw new Error('hostile') } } as unknown as BaseMessage)).toBeNull()
  expect(safeToolCalls(Object.assign(new AIMessage('fixture'), { tool_calls: Array(65).fill({}) }))).toBeNull()
  __internals.resetEncoderCache()
})

test('ambiguous tool pairing cannot reclaim tokens or manufacture a completed tool result', () => {
  const call = (id: string) => new AIMessage({ content: 'calling', tool_calls: [{ id, name: 'lookup', args: {} }] })
  for (const messages of [[new ToolMessage({ content: 'orphan', tool_call_id: 'missing' })], [call('same'), call('same')], [call(''), new ToolMessage({ content: 'result', tool_call_id: '' })], [call('call'), new ToolMessage({ content: 'result', tool_call_id: 'different' })]]) {
    expect(compactCompletedToolResults(messages, profile).reason).toBe('invalid-tool-pairing')
  }
})
test('compaction rejects untrusted message accessors, unbounded artifacts and unproven measurement', () => {
  const call = new AIMessage({ content: 'calling', tool_calls: [{ id: 'call', name: 'lookup', args: {} }] })
  const result = new ToolMessage({ content: 'x'.repeat(1000), tool_call_id: 'call' })
  const throwsType = Object.assign(new HumanMessage('fixture'), { _getType: () => { throw new Error('hostile') } })
  expect(safeMessageType(throwsType)).toBeNull()
  const callsGetter = Object.defineProperty(new AIMessage('fixture'), 'tool_calls', { get() { throw new Error('hostile') } })
  expect(safeToolCalls(callsGetter)).toBeNull()
  expect(compactCompletedToolResults([callsGetter], profile).reason).toBe('invalid-tool-pairing')
  const invalidName = Object.defineProperty(new HumanMessage('fixture'), 'name', { value: 1 })
  expect(() => measureMessages([invalidName], {})).toThrow(/invalid name/)
  let deep: unknown = { value: 'fixture' }
  for (let i = 0; i < 66; i++) deep = { child: deep }
  expect(() => cloneCompactedToolMessage(new ToolMessage({ content: 'fixture', tool_call_id: 'call', artifact: deep }))).toThrow(/clone rejected/)
  expect(() => cloneCompactedToolMessage(new ToolMessage({ content: 'fixture', tool_call_id: 'call', artifact: Array.from({ length: 20_001 }, () => ({})) }))).toThrow(/clone rejected/)
  const cycle: Record<string, unknown> = { undefined: undefined }; cycle.self = cycle
  const clone = cloneCompactedToolMessage(new ToolMessage({ content: 'fixture', tool_call_id: 'call', artifact: cycle }))
  expect(clone.artifact.self).toBe(clone.artifact)
  expect(() => contentText(Object.defineProperty(new HumanMessage('fixture'), 'content', { value: undefined }))).toThrow(/invalid content/)
  const invalidCounter = { count: () => 1.5, countDetailed: () => ({ tokens: 1.5, method: 'exact' as const }) }
  expect(compactCompletedToolResults([call, result], profile, { tokenCounter: invalidCounter }).status).toBe('rejected')
  expect(compactCompletedToolResults([call, result], { ...profile, measurement: 'require-tokenizer' }, { tokenCounter: { count: () => 1 } }).reason).toBe('token-measurement-unproven')
})
