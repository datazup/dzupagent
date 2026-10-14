import { describe, it, expect } from 'vitest'
import {
  composeAdvancedFragments,
  type ComposableFragment,
} from '../prompt/fragment-composer.js'

// With no model id the composer uses the heuristic estimator: ceil(chars / 4).
// Each 40-char body is exactly 10 tokens; the join separator is 7 chars.
const SEP = '\n\n---\n\n'
const body = (ch: string): string => ch.repeat(40)
const estimate = (text: string): number => (text ? Math.ceil(text.length / 4) : 0)

function frag(id: string, priority: number, extra: Partial<ComposableFragment> = {}): ComposableFragment {
  return { id, content: body(id.toLowerCase()), priority, ...extra }
}

describe('composeAdvancedFragments dependency closure', () => {
  it('does not include a fragment without its dependency when the budget fits only the dependent', () => {
    const result = composeAdvancedFragments(
      [frag('A', 10, { dependencies: ['B'] }), frag('B', 0)],
      { maxTokens: 12 },
    )

    // A is dropped; B alone still fits the budget and is kept on its own.
    expect(result.included).not.toContain('A')
    expect(result.included).toEqual(['B'])
    expect(result.excluded).toEqual(['A'])
    expect(result.content).toBe(body('b'))
    expect(result.warnings.some((w) => w.includes('"A"'))).toBe(true)
  })

  it('keeps a dependent and its dependency together when both fit with the separator', () => {
    // A + SEP + B = 87 chars = 22 tokens.
    const result = composeAdvancedFragments(
      [frag('A', 10, { dependencies: ['B'] }), frag('B', 0)],
      { maxTokens: 22 },
    )

    expect(result.included).toEqual(['A', 'B'])
    expect(result.content).toBe(`${body('a')}${SEP}${body('b')}`)
    expect(estimate(result.content)).toBe(22)
  })

  it('pulls a lower-priority dependency in with its dependent before an unrelated fragment', () => {
    const result = composeAdvancedFragments(
      [frag('A', 10, { dependencies: ['B'] }), frag('B', 0), frag('C', 5)],
      { maxTokens: 22 },
    )

    expect(result.included).toEqual(['A', 'B'])
    expect(result.excluded).toEqual(['C'])
    expect(estimate(result.content)).toBeLessThanOrEqual(22)
  })

  it('drops a dependent when a higher-priority conflicting fragment evicts its dependency', () => {
    const result = composeAdvancedFragments([
      frag('A', 10, { dependencies: ['B'] }),
      frag('B', 0, { conflicts: ['C'] }),
      frag('C', 20, { conflicts: ['B'] }),
    ])

    expect(result.included).toEqual(['C'])
    expect(result.excluded).toEqual(expect.arrayContaining(['A', 'B']))
    expect(result.warnings.some((w) => w.includes('"A"') && w.includes('"B"'))).toBe(true)
  })

  it('excludes a fragment whose dependency is not in the set, without throwing', () => {
    let result: ReturnType<typeof composeAdvancedFragments> | undefined
    expect(() => {
      result = composeAdvancedFragments([frag('A', 10, { dependencies: ['ghost'] }), frag('C', 0)])
    }).not.toThrow()

    expect(result!.included).toEqual(['C'])
    expect(result!.excluded).toContain('A')
    expect(result!.warnings.some((w) => w.includes('"A"') && w.includes('"ghost"'))).toBe(true)
  })

  it('excludes fragments on a dependency cycle and their dependents, without throwing', () => {
    let result: ReturnType<typeof composeAdvancedFragments> | undefined
    expect(() => {
      result = composeAdvancedFragments([
        frag('A', 10, { dependencies: ['B'] }),
        frag('B', 5, { dependencies: ['A'] }),
        frag('D', 20, { dependencies: ['A'] }),
        frag('E', 0),
      ])
    }).not.toThrow()

    expect(result!.included).toEqual(['E'])
    expect(result!.excluded).toEqual(expect.arrayContaining(['A', 'B', 'D']))
    expect(result!.warnings.some((w) => /circular/i.test(w))).toBe(true)
    expect(result!.warnings.some((w) => w.includes('"D"'))).toBe(true)
  })
})

describe('composeAdvancedFragments joined-content budget', () => {
  it('counts the join separators against maxTokens with the same estimator', () => {
    // Sum of parts is 20 tokens, but X + SEP + Y = 87 chars = 22 tokens.
    const fragments = [frag('X', 10), frag('Y', 5)]

    const tight = composeAdvancedFragments(fragments, { maxTokens: 20 })
    expect(tight.included).toEqual(['X'])
    expect(tight.excluded).toEqual(['Y'])
    expect(tight.content).toBe(body('x'))
    expect(estimate(tight.content)).toBe(10)
    expect(tight.warnings.some((w) => w.includes('"Y"'))).toBe(true)

    const exact = composeAdvancedFragments(fragments, { maxTokens: 22 })
    expect(exact.included).toEqual(['X', 'Y'])
    expect(exact.content).toBe(`${body('x')}${SEP}${body('y')}`)
    expect(estimate(exact.content)).toBe(22)
    expect(exact.warnings).toEqual([])
  })
})

describe('composeAdvancedFragments unchanged behaviour without dependency problems', () => {
  it('trims independent fragments by priority and skips the oversized one', () => {
    const result = composeAdvancedFragments(
      [
        { id: 'low', content: body('l'), priority: 1 },
        { id: 'big', content: 'g'.repeat(400), priority: 5 },
        { id: 'high', content: body('h'), priority: 9 },
      ],
      { maxTokens: 30 },
    )

    expect(result).toEqual({
      content: `${body('h')}${SEP}${body('l')}`,
      included: ['high', 'low'],
      excluded: ['big'],
      warnings: ['Fragment "big" excluded: exceeds token budget.'],
    })
  })

  it('auto-includes a condition-excluded dependency and orders by priority', () => {
    const result = composeAdvancedFragments(
      [
        frag('A', 10, { dependencies: ['B'] }),
        frag('B', 0, { condition: () => false }),
        frag('C', 0, { condition: () => false }),
      ],
    )

    expect(result).toEqual({
      content: `${body('a')}${SEP}${body('b')}`,
      included: ['A', 'B'],
      excluded: ['C'],
      warnings: ['Dependency "B" of "A" excluded by condition. Including anyway.'],
    })
  })

  it('keeps the higher-priority side of a conflict', () => {
    const result = composeAdvancedFragments([
      frag('P', 1, { conflicts: ['Q'] }),
      frag('Q', 3, { conflicts: ['P'] }),
    ])

    expect(result).toEqual({
      content: body('q'),
      included: ['Q'],
      excluded: ['P'],
      warnings: ['Excluded "P" (conflicts with "Q", lower priority).'],
    })
  })
})
