import { test, expect } from 'vitest'
import { z } from 'zod'
import { JsonOutputSchema, RegexOutputSchema, extractJsonFromMarkdown, extractJsonFromText } from '../structured/output-schema.js'

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
})
