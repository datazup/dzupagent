import { describe, it, expect } from 'vitest'
import { WorkflowStepResolver } from '../workflow/template-resolver.js'
import type { TemplateContext } from '../workflow/template-resolver.js'

describe('WorkflowStepResolver', () => {
  const resolver = new WorkflowStepResolver()

  // -------------------------------------------------------------------------
  // resolve()
  // -------------------------------------------------------------------------

  describe('resolve()', () => {
    it('resolves {{prev}} to the previous result', () => {
      const ctx: TemplateContext = { prev: 'hello world', state: {} }
      expect(resolver.resolve('Previous: {{prev}}', ctx)).toBe('Previous: hello world')
    })

    it('resolves {{prev}} to empty string when prev is undefined', () => {
      const ctx: TemplateContext = { state: {} }
      expect(resolver.resolve('Previous: {{prev}}', ctx)).toBe('Previous: ')
    })

    it('resolves {{state.key}} to a state value', () => {
      const ctx: TemplateContext = { state: { name: 'Alice' } }
      expect(resolver.resolve('Hello {{state.name}}', ctx)).toBe('Hello Alice')
    })

    it('resolves {{state.nested.path}} via dotted path', () => {
      const ctx: TemplateContext = {
        state: { user: { profile: { name: 'Bob' } } },
      }
      expect(resolver.resolve('User: {{state.user.profile.name}}', ctx)).toBe('User: Bob')
    })

    it('handles missing state keys gracefully (returns empty string)', () => {
      const ctx: TemplateContext = { state: {} }
      expect(resolver.resolve('Val: {{state.missing}}', ctx)).toBe('Val: ')
    })

    it('serializes non-string state values as JSON', () => {
      const ctx: TemplateContext = { state: { data: { x: 1 } } }
      expect(resolver.resolve('Data: {{state.data}}', ctx)).toBe('Data: {"x":1}')
    })

    it('resolves multiple references in the same template', () => {
      const ctx: TemplateContext = {
        prev: 'prev-val',
        state: { a: 'alpha', b: 'beta' },
      }
      const result = resolver.resolve('{{prev}} / {{state.a}} / {{state.b}}', ctx)
      expect(result).toBe('prev-val / alpha / beta')
    })

    it('leaves strings without templates unchanged', () => {
      const ctx: TemplateContext = { state: {} }
      expect(resolver.resolve('no templates here', ctx)).toBe('no templates here')
    })
  })

  // -------------------------------------------------------------------------
  // extractReferences()
  // -------------------------------------------------------------------------

  describe('extractReferences()', () => {
    it('finds all {{...}} patterns', () => {
      const refs = resolver.extractReferences('{{prev}} and {{state.foo}} then {{state.bar.baz}}')
      expect(refs).toHaveLength(3)
      expect(refs[0]!.raw).toBe('{{prev}}')
      expect(refs[0]!.path).toEqual(['prev'])
      expect(refs[1]!.raw).toBe('{{state.foo}}')
      expect(refs[1]!.path).toEqual(['state', 'foo'])
      expect(refs[2]!.raw).toBe('{{state.bar.baz}}')
      expect(refs[2]!.path).toEqual(['state', 'bar', 'baz'])
    })

    it('returns empty array when no templates are present', () => {
      expect(resolver.extractReferences('plain text')).toEqual([])
    })

    it('includes correct start and end indices', () => {
      const refs = resolver.extractReferences('X{{prev}}Y')
      expect(refs).toHaveLength(1)
      expect(refs[0]!.startIndex).toBe(1)
      expect(refs[0]!.endIndex).toBe(9)
    })
  })

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  describe('validate()', () => {
    it('returns empty array when all references are resolvable', () => {
      const unresolvable = resolver.validate(
        '{{prev}} {{state.research}}',
        ['research'],
      )
      expect(unresolvable).toEqual([])
    })

    it('catches unresolvable state references', () => {
      const unresolvable = resolver.validate(
        '{{state.missing}}',
        ['available'],
      )
      expect(unresolvable).toHaveLength(1)
      expect(unresolvable[0]!.raw).toBe('{{state.missing}}')
    })

    it('always treats {{prev}} as resolvable', () => {
      const unresolvable = resolver.validate('{{prev}}', [])
      expect(unresolvable).toEqual([])
    })

    it('handles multiple unresolvable references', () => {
      const unresolvable = resolver.validate(
        '{{state.a}} {{state.b}} {{state.c}}',
        ['b'],
      )
      expect(unresolvable).toHaveLength(2)
      expect(unresolvable.map((r) => r.raw)).toEqual([
        '{{state.a}}',
        '{{state.c}}',
      ])
    })
  })
})
