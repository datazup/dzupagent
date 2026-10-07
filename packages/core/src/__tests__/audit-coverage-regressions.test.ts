import { test, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { PromptCache } from '../prompt/template-cache.js'
import type { StoredTemplate } from '../prompt/template-types.js'
import { KeywordMatcher } from '../router/keyword-matcher.js'
import { getString, getNumber, getObject, toJsonString } from '../utils/event-record.js'
import { JsonOutputSchema, RegexOutputSchema, extractJsonFromMarkdown, extractJsonFromText } from '../structured/output-schema.js'
import { fetchWithOutboundUrlPolicy } from '../security/outbound-url-policy.js'
import { createServer } from 'node:http'

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

test('event projections ignore wrong types and nonfinite numbers without losing valid aliases', () => {
  const input = { invalid: null, array: [], number: 12, infinity: Infinity, text: 'valid', object: { retained: true } }
  expect(getString(input, 'invalid', 'text')).toBe('valid')
  expect(getString(input, 'number')).toBeUndefined()
  expect(getNumber(input, 'infinity', 'number')).toBe(12)
  expect(getNumber(input, 'text')).toBeUndefined()
  expect(getObject(input, 'array', 'object')).toEqual({ retained: true })
  expect(getObject(input, 'invalid')).toBeUndefined()
  expect(toJsonString('text')).toBe('text')
  expect(toJsonString(null)).toBe('""')
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  expect(toJsonString(cycle)).toBe('[object Object]')
})

test('structured output parses valid JSON and fenced output while rejecting malformed or mismatched values', () => {
  const schema = JsonOutputSchema.fromZod(z.object({ value: z.string() }), { schemaName: 'fixture' })
  expect(schema.parse('{"value":"valid"}')).toEqual({ value: 'valid' })
  expect(schema.parse('```json\n{"value":"valid"}\n```')).toEqual({ value: 'valid' })
  expect(() => schema.parse('not JSON')).toThrow(/not valid JSON/)
  expect(() => schema.parse('```json\nbroken\n```')).toThrow(/not valid JSON/)
  expect(() => schema.parse('{"value":1}')).toThrow()
  expect(schema.describe()).toContain('fixture')
  expect(extractJsonFromMarkdown('nothing')).toBeNull()
  expect(extractJsonFromText('prefix {"value":1} suffix')).toBe('{"value":1}')
  const regex = new RegexOutputSchema('fixture', /value=(\d+)/)
  expect(regex.parse('value=12')[1]).toBe('12')
  expect(() => regex.parse('absent')).toThrow(/does not match/)
  expect(regex.describe()).toContain('value=')
  const matcher = new KeywordMatcher().addPattern(/one/, 'first').addPattern(/two/, 'second')
  expect(matcher.match('one two')).toBe('first')
  expect(matcher.matchAll('one two')).toEqual(['first', 'second'])
  expect(matcher.match('absent')).toBeNull()
})

test('pinned fetch releases sockets after consumption and redirect cancellation', async () => {
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/final' }); response.end('redirect body') }
    else response.end('fixture')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  const policy = { allowHttp: true, allowedIpAddresses: ['127.0.0.1'], lookup: async () => [{ address: '127.0.0.1', family: 4 }] }
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetchWithOutboundUrlPolicy(`http://audit-fixture.invalid:${address.port}/redirect`, {}, { policy })
      expect(await response.text()).toBe('fixture')
    }
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 2000 })
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
