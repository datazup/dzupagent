import { describe, it, expect } from 'vitest'

/**
 * Fuzz-style tests for the JSON parsing resilience used in JSONL streaming.
 *
 * spawnAndStreamJsonl (in process-helpers.ts) parses each stdout line with
 * JSON.parse, accepts only non-null, non-array objects, and silently skips
 * everything else. This suite exercises that logic with a broad range of
 * malformed, edge-case, and valid inputs.
 */
describe('JSONL parsing resilience', () => {
  /**
   * Replicate the try/catch JSON.parse pattern from process-helpers.
   * Accepts only non-null, non-array objects — exactly matching the
   * runtime filter in spawnAndStreamJsonl.
   */
  function tryParseJson(line: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return undefined
    } catch {
      return undefined
    }
  }

  // --- Valid inputs ---

  it('parses valid JSON objects', () => {
    expect(tryParseJson('{"key":"value"}')).toEqual({ key: 'value' })
  })

  it('handles empty object', () => {
    expect(tryParseJson('{}')).toEqual({})
  })

  it('handles unicode content', () => {
    expect(tryParseJson('{"emoji":"🎉","cjk":"你好"}')).toEqual({ emoji: '🎉', cjk: '你好' })
  })

  it('handles escaped characters', () => {
    expect(tryParseJson('{"path":"C:\\\\Users\\\\test"}')).toEqual({ path: 'C:\\Users\\test' })
  })

  it('handles newlines in values', () => {
    expect(tryParseJson('{"text":"line1\\nline2"}')).toEqual({ text: 'line1\nline2' })
  })

  it('handles deeply nested JSON', () => {
    const deep = '{"a":'.repeat(50) + '{}' + '}'.repeat(50)
    const result = tryParseJson(deep)
    expect(result).toBeDefined()
  })

  it('handles very long string values', () => {
    const long = JSON.stringify({ content: 'x'.repeat(100_000) })
    const result = tryParseJson(long)
    expect(result).toBeDefined()
    expect((result as Record<string, unknown>).content).toHaveLength(100_000)
  })

  // --- Rejected but valid JSON (non-object types) ---

  it('handles JSON null', () => {
    expect(tryParseJson('null')).toBeUndefined()
  })

  it('handles JSON number', () => {
    expect(tryParseJson('42')).toBeUndefined()
  })

  it('handles JSON string', () => {
    expect(tryParseJson('"string"')).toBeUndefined()
  })

  it('handles JSON boolean true', () => {
    expect(tryParseJson('true')).toBeUndefined()
  })

  it('handles JSON boolean false', () => {
    expect(tryParseJson('false')).toBeUndefined()
  })

  it('handles JSON array', () => {
    expect(tryParseJson('[1,2,3]')).toBeUndefined()
  })

  it('handles nested array', () => {
    expect(tryParseJson('[[[]]]')).toBeUndefined()
  })

  // --- Malformed / invalid inputs ---

  it('handles empty string', () => {
    expect(tryParseJson('')).toBeUndefined()
  })

  it('handles plain text', () => {
    expect(tryParseJson('not json at all')).toBeUndefined()
  })

  it('handles truncated JSON', () => {
    expect(tryParseJson('{"incomplete": ')).toBeUndefined()
  })

  it('handles binary data', () => {
    expect(tryParseJson('\x00\x01\x02')).toBeUndefined()
  })

  it('handles single open brace', () => {
    expect(tryParseJson('{')).toBeUndefined()
  })

  it('handles trailing comma', () => {
    expect(tryParseJson('{"a":1,}')).toBeUndefined()
  })

  it('handles single quotes (invalid JSON)', () => {
    expect(tryParseJson("{'key':'value'}")).toBeUndefined()
  })

  it('handles unquoted keys', () => {
    expect(tryParseJson('{key: "value"}')).toBeUndefined()
  })

  it('handles JavaScript-style comments', () => {
    expect(tryParseJson('{"a":1} // comment')).toBeUndefined()
  })

  it('handles multiple JSON objects on one line', () => {
    expect(tryParseJson('{"a":1}{"b":2}')).toBeUndefined()
  })

  it('handles whitespace-only string', () => {
    expect(tryParseJson('   ')).toBeUndefined()
  })

  it('handles tab characters', () => {
    expect(tryParseJson('\t\t')).toBeUndefined()
  })

  it('handles NaN (invalid JSON)', () => {
    expect(tryParseJson('NaN')).toBeUndefined()
  })

  it('handles undefined literal (invalid JSON)', () => {
    expect(tryParseJson('undefined')).toBeUndefined()
  })

  it('handles Infinity (invalid JSON)', () => {
    expect(tryParseJson('Infinity')).toBeUndefined()
  })

  it('handles ANSI escape codes', () => {
    expect(tryParseJson('\x1b[31mError\x1b[0m')).toBeUndefined()
  })

  it('handles zero-width characters', () => {
    expect(tryParseJson('\u200B\u200C\u200D')).toBeUndefined()
  })

  // --- Mixed valid/invalid batch ---

  it('correctly filters mixed valid and invalid lines', () => {
    const lines = [
      '{"valid":true}',
      'garbage',
      '{"also":"valid"}',
      '',
      '{"more":123}',
      'not{json',
      'null',
      '[1,2]',
      '42',
      '{"last":"one"}',
    ]
    const results = lines.map(tryParseJson).filter(Boolean)
    expect(results).toHaveLength(4)
    expect(results).toEqual([
      { valid: true },
      { also: 'valid' },
      { more: 123 },
      { last: 'one' },
    ])
  })
})
