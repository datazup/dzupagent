import { describe, it, expect } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { MockChatModel } from '../mock-model.js'

describe('MockChatModel', () => {
  it('returns responses in order', async () => {
    const model = new MockChatModel(['first', 'second', 'third'])

    const r1 = await model.invoke([new HumanMessage('hello')])
    expect(r1.content).toBe('first')

    const r2 = await model.invoke([new HumanMessage('world')])
    expect(r2.content).toBe('second')
  })

  it('cycles back to first response after exhausting all', async () => {
    const model = new MockChatModel(['a', 'b'])

    await model.invoke([new HumanMessage('1')])
    await model.invoke([new HumanMessage('2')])
    const r3 = await model.invoke([new HumanMessage('3')])
    expect(r3.content).toBe('a') // cycles
  })

  it('tracks call count', async () => {
    const model = new MockChatModel(['resp'])
    expect(model.callCount).toBe(0)

    await model.invoke([new HumanMessage('x')])
    expect(model.callCount).toBe(1)

    await model.invoke([new HumanMessage('y')])
    expect(model.callCount).toBe(2)
  })

  it('records call log with messages', async () => {
    const model = new MockChatModel(['resp'])
    await model.invoke([new HumanMessage('test message')])

    expect(model.callLog).toHaveLength(1)
    expect(model.callLog[0]!.messages[0]!.content).toBe('test message')
  })

  it('reset() clears call state', async () => {
    const model = new MockChatModel(['a', 'b'])
    await model.invoke([new HumanMessage('x')])
    await model.invoke([new HumanMessage('y')])
    expect(model.callCount).toBe(2)

    model.reset()
    expect(model.callCount).toBe(0)
    expect(model.callLog).toHaveLength(0)

    const r = await model.invoke([new HumanMessage('z')])
    expect(r.content).toBe('a') // back to first
  })

  it('accepts MockResponse objects with tool_calls', async () => {
    const model = new MockChatModel([
      { content: 'I will use the tool', tool_calls: [{ id: 'tc1', name: 'read_file', args: { path: 'a.ts' } }] },
    ])

    const result = await model.invoke([new HumanMessage('read the file')])
    expect(result.content).toBe('I will use the tool')
  })

  it('handles empty response array gracefully', async () => {
    const model = new MockChatModel([])
    const r = await model.invoke([new HumanMessage('hello')])
    expect(r.content).toBe('')
  })

  it('returns correct _llmType', () => {
    const model = new MockChatModel(['x'])
    expect(model._llmType()).toBe('mock')
  })
})
