import { describe, it, expect } from 'vitest'
import {
  flattenContext,
  resolveTemplate,
  extractVariables,
  validateTemplate,
} from '../prompt/template-engine.js'
import type { TemplateVariable } from '../prompt/template-types.js'

describe('Template Engine', () => {
  // -----------------------------------------------------------------------
  // flattenContext
  // -----------------------------------------------------------------------
  describe('flattenContext', () => {
    it('passes through string values', () => {
      expect(flattenContext({ name: 'Alice' })).toEqual({ name: 'Alice' })
    })

    it('converts numbers and booleans to strings', () => {
      const result = flattenContext({ count: 42, flag: true })
      expect(result['count']).toBe('42')
      expect(result['flag']).toBe('true')
    })

    it('joins arrays with comma+space', () => {
      expect(flattenContext({ items: ['a', 'b', 'c'] })).toMatchObject({
        items: 'a, b, c',
      })
    })

    it('JSON-stringifies objects', () => {
      const result = flattenContext({ data: { x: 1 } })
      expect(result['data']).toBe('{"x":1}')
    })

    it('maps null and undefined to empty string', () => {
      const result = flattenContext({ a: null, b: undefined })
      expect(result['a']).toBe('')
      expect(result['b']).toBe('')
    })

    it('creates snake_case aliases for camelCase keys', () => {
      const result = flattenContext({ myValue: 'hello' })
      expect(result['myValue']).toBe('hello')
      expect(result['my_value']).toBe('hello')
    })
  })

  // -----------------------------------------------------------------------
  // resolveTemplate — variable substitution
  // -----------------------------------------------------------------------
  describe('resolveTemplate', () => {
    it('resolves simple variable placeholders', () => {
      const result = resolveTemplate('Hello, {{name}}!', { name: 'World' })
      expect(result).toBe('Hello, World!')
    })

    it('resolves multiple variables', () => {
      const result = resolveTemplate('{{greeting}}, {{name}}!', {
        greeting: 'Hi',
        name: 'Bob',
      })
      expect(result).toBe('Hi, Bob!')
    })

    it('removes unresolved variables', () => {
      const result = resolveTemplate('Hello, {{name}}!', {})
      expect(result).toBe('Hello, !')
    })

    it('handles empty template', () => {
      expect(resolveTemplate('', {})).toBe('')
    })

    it('handles template with no placeholders', () => {
      expect(resolveTemplate('plain text', {})).toBe('plain text')
    })

    it('resolves snake_case aliases from camelCase context', () => {
      const result = resolveTemplate('{{user_name}}', { userName: 'Alice' })
      expect(result).toBe('Alice')
    })
  })

  // -----------------------------------------------------------------------
  // resolveTemplate — variable declarations
  // -----------------------------------------------------------------------
  describe('resolveTemplate (variable declarations)', () => {
    it('applies default values for missing variables', () => {
      const variables: TemplateVariable[] = [
        { name: 'lang', description: 'language', required: false, defaultValue: 'en' },
      ]
      const result = resolveTemplate('Language: {{lang}}', {}, { variables })
      expect(result).toBe('Language: en')
    })

    it('applies defaults for required variables without context value', () => {
      const variables: TemplateVariable[] = [
        { name: 'model', description: '', required: true, defaultValue: 'gpt-4' },
      ]
      const result = resolveTemplate('Model: {{model}}', {}, { variables })
      expect(result).toBe('Model: gpt-4')
    })

    it('throws in strict mode for required variable without default', () => {
      const variables: TemplateVariable[] = [
        { name: 'required_var', description: '', required: true },
      ]
      expect(() =>
        resolveTemplate('{{required_var}}', {}, { variables, strictMode: true }),
      ).toThrow(/Required template variable "required_var" is not provided/)
    })

    it('does not throw in non-strict mode for required variable without default', () => {
      const variables: TemplateVariable[] = [
        { name: 'required_var', description: '', required: true },
      ]
      // Should not throw — just leaves it unresolved (empty)
      const result = resolveTemplate('Value: {{required_var}}', {}, { variables })
      expect(result).toBe('Value: ')
    })
  })

  // -----------------------------------------------------------------------
  // resolveTemplate — control flow
  // -----------------------------------------------------------------------
  describe('resolveTemplate (control flow)', () => {
    it('renders #if block when variable is truthy', () => {
      const result = resolveTemplate(
        '{{#if name}}Hello, {{name}}!{{/if}}',
        { name: 'Alice' },
      )
      expect(result).toBe('Hello, Alice!')
    })

    it('hides #if block when variable is falsy', () => {
      const result = resolveTemplate(
        '{{#if name}}Hello, {{name}}!{{/if}}',
        {},
      )
      expect(result).toBe('')
    })

    it('renders else branch when #if is falsy', () => {
      const result = resolveTemplate(
        '{{#if name}}Hi {{name}}{{else}}Anonymous{{/if}}',
        {},
      )
      expect(result).toBe('Anonymous')
    })

    it('renders #unless block when variable is falsy', () => {
      const result = resolveTemplate(
        '{{#unless name}}No name provided{{/unless}}',
        {},
      )
      expect(result).toBe('No name provided')
    })

    it('hides #unless block when variable is truthy', () => {
      const result = resolveTemplate(
        '{{#unless name}}No name{{/unless}}',
        { name: 'Bob' },
      )
      expect(result).toBe('')
    })

    it('iterates with #each', () => {
      const result = resolveTemplate(
        '{{#each items}}- {{this}}\n{{/each}}',
        { items: ['a', 'b', 'c'] },
      )
      expect(result).toBe('- a\n- b\n- c\n')
    })

    it('#each produces empty string for empty list', () => {
      const result = resolveTemplate(
        '{{#each items}}item{{/each}}',
        { items: [] },
      )
      expect(result).toBe('')
    })
  })

  // -----------------------------------------------------------------------
  // resolveTemplate — partials
  // -----------------------------------------------------------------------
  describe('resolveTemplate (partials)', () => {
    it('injects a named partial', () => {
      const result = resolveTemplate(
        'Before {{> greeting}} After',
        { name: 'World' },
        { partials: { greeting: 'Hello, {{name}}!' } },
      )
      expect(result).toBe('Before Hello, World! After')
    })

    it('renders fallback comment for missing partial', () => {
      const result = resolveTemplate(
        '{{> unknown}}',
        {},
        { partials: {} },
      )
      expect(result).toContain('partial "unknown" not found')
    })
  })

  // -----------------------------------------------------------------------
  // extractVariables
  // -----------------------------------------------------------------------
  describe('extractVariables', () => {
    it('extracts simple variable names', () => {
      expect(extractVariables('{{name}} and {{age}}')).toEqual(['name', 'age'])
    })

    it('deduplicates repeated variables', () => {
      expect(extractVariables('{{x}} {{x}} {{x}}')).toEqual(['x'])
    })

    it('returns empty array for no variables', () => {
      expect(extractVariables('plain text')).toEqual([])
    })

    it('filters out control flow keywords', () => {
      const tpl = '{{#if active}}{{name}}{{else}}{{fallback}}{{/if}}{{#each items}}{{this}}{{/each}}'
      const vars = extractVariables(tpl)
      expect(vars).toContain('name')
      expect(vars).toContain('fallback')
      expect(vars).not.toContain('if')
      expect(vars).not.toContain('else')
      expect(vars).not.toContain('each')
      expect(vars).not.toContain('this')
    })

    it('excludes partial references', () => {
      expect(extractVariables('{{> header}} {{title}}')).toEqual(['title'])
    })
  })

  // -----------------------------------------------------------------------
  // validateTemplate
  // -----------------------------------------------------------------------
  describe('validateTemplate', () => {
    it('returns valid for a correct template', () => {
      const vars: TemplateVariable[] = [
        { name: 'name', description: '', required: true },
      ]
      const result = validateTemplate('Hello {{name}}', vars)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.usedVariables).toEqual(['name'])
    })

    it('reports undeclared variables', () => {
      const result = validateTemplate('{{unknown}}', [])
      expect(result.undeclaredVariables).toContain('unknown')
    })

    it('warns about required variables declared but not used', () => {
      const vars: TemplateVariable[] = [
        { name: 'unused', description: '', required: true },
      ]
      const result = validateTemplate('no vars here', vars)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('unused')
    })

    it('does not warn for required+unused variables that have a default', () => {
      const vars: TemplateVariable[] = [
        { name: 'unused', description: '', required: true, defaultValue: 'x' },
      ]
      const result = validateTemplate('no vars here', vars)
      expect(result.valid).toBe(true)
    })

    it('accepts standard variables without declaring them', () => {
      const standard: TemplateVariable[] = [
        { name: 'date', description: '', required: false },
      ]
      const result = validateTemplate('Today: {{date}}', [], standard)
      expect(result.undeclaredVariables).not.toContain('date')
    })
  })
})
