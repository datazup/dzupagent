import { describe, it, expect } from 'vitest'

import { parseYamlSubset } from '../mini-yaml.js'

describe('parseYamlSubset', () => {
  describe('empty / blank input', () => {
    it('returns empty object for empty string', () => {
      const result = parseYamlSubset('')
      expect(result).toEqual({ ok: true, value: {} })
    })

    it('returns empty object for only whitespace', () => {
      const result = parseYamlSubset('   \n   \n')
      expect(result).toEqual({ ok: true, value: {} })
    })

    it('ignores comment-only lines', () => {
      const result = parseYamlSubset('# this is a comment\n# another comment')
      expect(result).toEqual({ ok: true, value: {} })
    })
  })

  describe('scalar values', () => {
    it('parses a simple string mapping', () => {
      const result = parseYamlSubset('key: value')
      expect(result).toEqual({ ok: true, value: { key: 'value' } })
    })

    it('parses a boolean true', () => {
      const result = parseYamlSubset('flag: true')
      expect(result).toEqual({ ok: true, value: { flag: true } })
    })

    it('parses a boolean false', () => {
      const result = parseYamlSubset('flag: false')
      expect(result).toEqual({ ok: true, value: { flag: false } })
    })

    it('parses null with null keyword', () => {
      const result = parseYamlSubset('val: null')
      expect(result).toEqual({ ok: true, value: { val: null } })
    })

    it('parses null with tilde', () => {
      const result = parseYamlSubset('val: ~')
      expect(result).toEqual({ ok: true, value: { val: null } })
    })

    it('parses a positive integer', () => {
      const result = parseYamlSubset('count: 42')
      expect(result).toEqual({ ok: true, value: { count: 42 } })
    })

    it('parses a negative integer', () => {
      const result = parseYamlSubset('count: -7')
      expect(result).toEqual({ ok: true, value: { count: -7 } })
    })

    it('parses a decimal number', () => {
      const result = parseYamlSubset('ratio: 3.14')
      expect(result).toEqual({ ok: true, value: { ratio: 3.14 } })
    })

    it('parses double-quoted string', () => {
      const result = parseYamlSubset('msg: "hello world"')
      expect(result).toEqual({ ok: true, value: { msg: 'hello world' } })
    })

    it('parses single-quoted string', () => {
      const result = parseYamlSubset("msg: 'hello world'")
      expect(result).toEqual({ ok: true, value: { msg: 'hello world' } })
    })
  })

  describe('nested objects', () => {
    it('parses nested mapping', () => {
      const source = 'parent:\n  child: value'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { parent: { child: 'value' } } })
    })

    it('parses multiply-nested mapping', () => {
      const source = 'a:\n  b:\n    c: deep'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { a: { b: { c: 'deep' } } } })
    })

    it('parses sibling keys at the same level', () => {
      const source = 'x: 1\ny: 2'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { x: 1, y: 2 } })
    })
  })

  describe('sequences', () => {
    it('parses a simple sequence', () => {
      const source = '- a\n- b\n- c'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: ['a', 'b', 'c'] })
    })

    it('parses a sequence of numbers', () => {
      const source = '- 1\n- 2\n- 3'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: [1, 2, 3] })
    })

    it('parses inline mapping entries inside sequences', () => {
      const source = '- key: value\n- key: other'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: [{ key: 'value' }, { key: 'other' }] })
    })

    it('parses a sequence value under a mapping key', () => {
      const source = 'tags:\n  - a\n  - b'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { tags: ['a', 'b'] } })
    })
  })

  describe('literal block scalar', () => {
    it('parses a literal block (pipe) into a multiline string', () => {
      const source = 'desc: |\n  line one\n  line two'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { desc: 'line one\nline two' } })
    })
  })

  describe('inline arrays', () => {
    it('parses an inline array of strings', () => {
      const source = 'tags: [foo, bar, baz]'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { tags: ['foo', 'bar', 'baz'] } })
    })

    it('parses an empty inline array', () => {
      const source = 'items: []'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { items: [] } })
    })
  })

  describe('error cases', () => {
    it('returns error for tab-indented line', () => {
      const source = 'key: value\n\tchild: bad'
      const result = parseYamlSubset(source)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors[0]?.code).toBe('INVALID_YAML_SUBSET')
        expect(result.errors[0]?.message).toContain('Tabs')
      }
    })

    it('returns error for invalid mapping entry', () => {
      // starts with a digit — not a valid identifier start
      const source = '123bad: value'
      const result = parseYamlSubset(source)
      expect(result.ok).toBe(false)
    })

    it('returns error for unexpected trailing content', () => {
      // Two mapping blocks at different indentation without nesting
      const source = 'a: 1\n b: 2'
      const result = parseYamlSubset(source)
      expect(result.ok).toBe(false)
    })
  })

  describe('CRLF normalization', () => {
    it('handles CRLF line endings', () => {
      const source = 'key: value\r\nother: 2'
      const result = parseYamlSubset(source)
      expect(result).toEqual({ ok: true, value: { key: 'value', other: 2 } })
    })
  })
})
