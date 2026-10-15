import { expect, test } from 'vitest'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { applyCacheBreakpoints } from '../prompt-cache.js'

test('cache breakpoints preserve mixed provider content without treating non-text blocks as stable text', () => {
  const mixed = new HumanMessage('fixture')
  Object.assign(mixed, { content: ['text', { type: 'text', text: 1 }, null, { type: 'image_url', image_url: 'fixture' }] })
  const output = applyCacheBreakpoints([mixed])
  expect(output).toHaveLength(1)
  expect(output[0]).not.toBe(mixed)
  expect(mixed.content).toEqual(['text', { type: 'text', text: 1 }, null, { type: 'image_url', image_url: 'fixture' }])
  const malformed = Object.assign(new HumanMessage('fixture'), { content: null })
  expect(applyCacheBreakpoints([malformed])[0]!.content).toBeNull()
  expect(applyCacheBreakpoints([undefined, new HumanMessage('fixture')] as unknown as BaseMessage[])).toHaveLength(1)
})
