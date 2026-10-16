import { test, expect, vi, afterEach } from 'vitest'
import { PromptCache } from '../prompt/template-cache.js'
import type { StoredTemplate } from '../prompt/template-types.js'

afterEach(() => vi.restoreAllMocks())
test('prompt cache retains priority and category fallbacks until expiry, and clears stale entries on preload', async () => {
  let time = 100
  vi.spyOn(Date, 'now').mockImplementation(() => time)
  const cache = new PromptCache(10)
  const template: StoredTemplate = { id: 'first', type: 'chat', category: 'specific', content: 'fixture', variables: [], config: {} }
  await cache.preload({ findTemplate: async () => null, findAllTemplates: async () => [template, { ...template, id: 'lower-priority' }] }, { types: ['chat'] })
  expect(cache.size).toBe(2)
  expect(cache.get('chat', 'specific')?.id).toBe('first')
  expect(cache.get('chat', 'other')?.id).toBe('first')
  expect(cache.get('absent')).toBeNull()
  cache.set('chat', 'new', { ...template, id: 'new' })
  cache.set('other', undefined, template)
  expect(cache.get('chat', 'new')?.id).toBe('new')
  time += 11
  expect(cache.isExpired()).toBe(true)
  expect(cache.get('chat')).toBeNull()
  cache.clear()
  expect(cache.size).toBe(0)
})
