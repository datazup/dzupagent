import { describe, it, expect, vi } from 'vitest'

import { parseJsonl } from '../utils/parse-jsonl.js'

describe('parseJsonl', () => {
  it('parses one record per line', () => {
    const raw = '{"a":1}\n{"a":2}\n{"a":3}'
    expect(parseJsonl<{ a: number }>(raw)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('returns [] for empty string', () => {
    expect(parseJsonl('')).toEqual([])
  })

  it('returns [] for whitespace-only input', () => {
    expect(parseJsonl('   \n\n\n')).toEqual([])
  })

  it('skips trailing newline (appendFile-style) without emitting an empty record', () => {
    const raw = '{"id":"a"}\n{"id":"b"}\n'
    expect(parseJsonl<{ id: string }>(raw)).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('skips interior blank lines', () => {
    const raw = '{"x":1}\n\n{"x":2}'
    expect(parseJsonl<{ x: number }>(raw)).toEqual([{ x: 1 }, { x: 2 }])
  })

  it('skips malformed JSON lines without throwing', () => {
    const raw = '{"ok":1}\n{not-json}\n{"ok":2}'
    expect(parseJsonl<{ ok: number }>(raw)).toEqual([{ ok: 1 }, { ok: 2 }])
  })

  it('reports malformed lines via onSkip with reason and error', () => {
    const onSkip = vi.fn()
    parseJsonl('{"ok":1}\nBROKEN', { onSkip })
    expect(onSkip).toHaveBeenCalledTimes(1)
    const args = onSkip.mock.calls[0]!
    expect(args[0]).toBe('malformed-json')
    expect(args[1]).toBe('BROKEN')
    expect(args[2]).toBeInstanceOf(Error)
  })

  it('applies validate type-guard and skips failing records', () => {
    interface Evt { type: string }
    const isEvt = (x: unknown): x is Evt =>
      typeof x === 'object' && x !== null && 'type' in x && typeof (x as Evt).type === 'string'
    const onSkip = vi.fn()
    const raw = '{"type":"start"}\n{"foo":1}\n{"type":"end"}'
    const out = parseJsonl<Evt>(raw, { validate: isEvt, onSkip })
    expect(out).toEqual([{ type: 'start' }, { type: 'end' }])
    expect(onSkip).toHaveBeenCalledWith('failed-validation', '{"foo":1}')
  })

  it('tolerates a JSON primitive per line (numbers, strings)', () => {
    expect(parseJsonl<number>('1\n2\n3')).toEqual([1, 2, 3])
    expect(parseJsonl<string>('"a"\n"b"')).toEqual(['a', 'b'])
  })

  it('does not throw on a single broken line', () => {
    expect(() => parseJsonl('not-json')).not.toThrow()
    expect(parseJsonl('not-json')).toEqual([])
  })

  it('preserves order with mixed valid/invalid input', () => {
    const onSkip = vi.fn()
    const raw = [
      '{"i":1}',
      'bad',
      '{"i":2}',
      '',
      '{"i":3}',
    ].join('\n')
    expect(parseJsonl<{ i: number }>(raw, { onSkip })).toEqual([
      { i: 1 },
      { i: 2 },
      { i: 3 },
    ])
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onSkip).toHaveBeenCalledWith('malformed-json', 'bad', expect.any(Error))
  })
})
