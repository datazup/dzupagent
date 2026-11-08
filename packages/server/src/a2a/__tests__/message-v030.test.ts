import { describe, expect, it } from 'vitest'
import { toAgentCardV030 } from '../agent-card-v030.js'
import { parseMessageV030, partToV030, stateToV030, taskToV030 } from '../message-v030.js'
import type { A2ATask, A2ATaskState } from '../a2a-types.js'

const task = (over: Partial<A2ATask> = {}): A2ATask => ({
  id: 't1', state: 'working', input: 'i', agentName: 'a', createdAt: 'c', updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [], artifacts: [], ...over,
})

describe('A2A v0.3.0 mappers', () => {
  it('maps every internal state, with cancelled spelled canceled', () => {
    const states: A2ATaskState[] = ['submitted', 'working', 'input-required', 'completed', 'failed', 'cancelled']
    expect(states.map(stateToV030)).toEqual(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'])
  })

  it('parses text and data parts and carries taskId and contextId', () => {
    const parsed = parseMessageV030({
      kind: 'message', messageId: 'm', role: 'agent', taskId: 'T', contextId: 'C',
      parts: [{ kind: 'text', text: 'a' }, { kind: 'data', data: { k: 1 } }],
    })
    expect(parsed).toEqual({
      ok: true, taskId: 'T', contextId: 'C',
      message: { role: 'agent', parts: [{ type: 'text', text: 'a' }, { type: 'data', data: { k: 1 } }] },
    })
  })

  it('rejects what the specification rules out, and flags file parts as unsupported content', () => {
    const base = { kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'a' }] }
    const bad = [
      null, [], { ...base, kind: 'task' }, { messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'a' }] }, { ...base, messageId: '' }, { ...base, role: 'x' }, { ...base, parts: {} },
      { ...base, parts: [null] }, { ...base, parts: [{ kind: 'data', data: [] }] }, { ...base, taskId: 3 }, { ...base, contextId: '' },
      { ...base, metadata: [] }, { ...base, extensions: 42 }, { ...base, extensions: [1] }, { ...base, referenceTaskIds: [false] },
      { ...base, parts: [{ kind: 'text', text: 'a', metadata: null }] },
    ]
    for (const value of bad) expect(parseMessageV030(value)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseMessageV030({ ...base, parts: [{ kind: 'file', file: {} }] })).toMatchObject({ ok: false, reason: 'content' })
  })

  it('keeps an unknown internal part type as a marker and states the payload is not carried', () => {
    expect(partToV030({ type: 'custom', data: { value: 1 } })).toEqual({ kind: 'data', data: { type: 'custom' } })
    expect(partToV030({ type: 'text' })).toEqual({ kind: 'data', data: { type: 'text' } })
  })

  it('maps a task: synthesized ids, stored artifact index first, metadata only when present', () => {
    const mapped = taskToV030(task({
      state: 'cancelled',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'u' }] }, { role: 'agent', parts: [{ type: 'data', data: { z: 2 } }] }],
      artifacts: [{ parts: [{ type: 'text', text: 'p' }], index: 4 }, { parts: [], name: 'n' }],
    }), 'ctx')
    expect(mapped).toEqual({
      kind: 'task', id: 't1', contextId: 'ctx',
      status: { state: 'canceled', timestamp: '2026-01-01T00:00:00.000Z' },
      history: [
        { kind: 'message', messageId: 't1-m0', role: 'user', parts: [{ kind: 'text', text: 'u' }] },
        { kind: 'message', messageId: 't1-m1', role: 'agent', parts: [{ kind: 'data', data: { z: 2 } }] },
      ],
      artifacts: [{ artifactId: 't1-a4', parts: [{ kind: 'text', text: 'p' }] }, { artifactId: 't1-a1', name: 'n', parts: [] }],
    })
    expect(taskToV030(task({ metadata: { m: 1 } })).metadata).toEqual({ m: 1 })
    expect('metadata' in taskToV030(task())).toBe(false)
  })

  it('derives the v0.3.0 card: endpoint url without a double slash, skills from capabilities when the card has none', () => {
    const card = toAgentCardV030({
      name: 'n', description: 'd', url: 'https://host.example/', version: 'v',
      capabilities: [{ name: 'cap', description: 'cd', inputSchema: {} }],
    })
    expect(card.url).toBe('https://host.example/a2a')
    expect(card.skills).toEqual([{ id: 'cap', name: 'cap', description: 'cd', tags: [] }])
    expect(card.protocolVersion).toBe('0.3.0')
  })
})
