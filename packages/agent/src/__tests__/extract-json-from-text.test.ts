import { describe, it, expect } from 'vitest'
import { extractJsonFromText } from '../agent/dzip-agent.js'

describe('extractJsonFromText', () => {
  it('returns bare JSON object unchanged', () => {
    const input = '{"name":"Alice","age":30}'
    expect(extractJsonFromText(input)).toBe(input)
  })

  it('returns bare JSON array unchanged', () => {
    const input = '[1,2,3]'
    expect(extractJsonFromText(input)).toBe(input)
  })

  it('extracts JSON from fenced ```json block', () => {
    const input = '```json\n{"ok":true}\n```'
    expect(extractJsonFromText(input)).toBe('{"ok":true}')
  })

  it('extracts JSON from fenced ``` block (no language tag)', () => {
    const input = '```\n{"ok":true}\n```'
    expect(extractJsonFromText(input)).toBe('{"ok":true}')
  })

  it('extracts JSON when preceded by preamble text', () => {
    const input = 'Here is the result:\n{"score":42}'
    expect(extractJsonFromText(input)).toBe('{"score":42}')
  })

  it('extracts JSON when followed by trailing text', () => {
    const input = '{"done":true} Hope that helps!'
    const result = extractJsonFromText(input)
    expect(JSON.parse(result)).toEqual({ done: true })
  })

  it('extracts JSON array when preceded by preamble', () => {
    const input = 'Output: [{"id":1},{"id":2}]'
    const result = extractJsonFromText(input)
    expect(JSON.parse(result)).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns plain text for non-JSON input (JSON.parse caller will throw)', () => {
    const result = extractJsonFromText('not json at all')
    expect(() => JSON.parse(result)).toThrow(SyntaxError)
  })

  it('returns empty string for empty input (JSON.parse caller will throw)', () => {
    const result = extractJsonFromText('')
    expect(() => JSON.parse(result)).toThrow(SyntaxError)
  })

  it('returns truncated string (JSON.parse caller will throw)', () => {
    const result = extractJsonFromText('{"incomplete":')
    expect(() => JSON.parse(result)).toThrow(SyntaxError)
  })
})
