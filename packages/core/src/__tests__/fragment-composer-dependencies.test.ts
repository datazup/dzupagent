import { describe, it, expect } from 'vitest'
import {
  composeAdvancedFragments,
  type ComposableFragment,
} from '../prompt/fragment-composer.js'
import { defaultTokenizerRegistry } from '../llm/tokenizer-registry.js'
import type { Tokenizer } from '../llm/tokenizer.js'

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

// A tokenizer whose count is not monotone in the text: any text containing
// "ZIP" is "compressed" to ceil(chars / 8). Real BPE tokenizers can likewise
// count a longer joined text cheaper than a shorter one.
const ZIP_MODEL = 'test-prompt01-followup-zip'
const zipTokenizer: Tokenizer = {
  model: ZIP_MODEL,
  countTokens: (text) => Math.ceil(text.length / (text.includes('ZIP') ? 8 : 4)),
  encode: (text) => new Array<number>(zipTokenizer.countTokens(text)).fill(0),
  countMessages: () => 0,
}
defaultTokenizerRegistry.register(new RegExp(`^${ZIP_MODEL}$`), zipTokenizer)

describe('composeAdvancedFragments warnings match the final excluded list', () => {
  it('drops the budget warning of a fragment later pulled in as a dependency', () => {
    // W fits (10). X: parts sum 20 <= 21, but W + SEP + X = 87 chars = 22 > 21,
    // so X is excluded for budget. Y (1 token, depends on X) then admits X:
    // parts sum 21 <= 21, and the joined text contains "ZIP" = ceil(97 / 8) = 13.
    const result = composeAdvancedFragments(
      [frag('W', 20), frag('X', 10), { id: 'Y', content: 'ZIP', priority: 0, dependencies: ['X'] }],
      { maxTokens: 21, model: ZIP_MODEL },
    )

    expect(result.included).toEqual(['W', 'X', 'Y'])
    expect(result.excluded).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe('composeAdvancedFragments conflict partner of a dropped fragment', () => {
  // F evicts its conflict partner P, then loses its own dependency D to E,
  // so the closure pass drops F. P no longer conflicts with anything kept.
  const fragments = (): ComposableFragment[] => [
    frag('F', 10, { dependencies: ['D'], conflicts: ['P'] }),
    frag('P', 5, { conflicts: ['F'] }),
    frag('D', 0, { conflicts: ['E'] }),
    frag('E', 20, { conflicts: ['D'] }),
  ]

  it('restores the evicted partner once its evictor is dropped', () => {
    const result = composeAdvancedFragments(fragments())

    expect(result).toEqual({
      content: `${body('e')}${SEP}${body('p')}`,
      included: ['E', 'P'],
      excluded: ['F', 'D'],
      warnings: [
        'Excluded "D" (conflicts with "E", lower priority).',
        'Fragment "F" excluded: dependency "D" is not included.',
      ],
    })
  })

  it('restores a dependent of the restored partner as well', () => {
    const result = composeAdvancedFragments([...fragments(), frag('Q', 1, { dependencies: ['P'] })])

    expect(result.included).toEqual(['E', 'P', 'Q'])
    expect(result.excluded).toEqual(['F', 'D'])
    expect(result.warnings.some((w) => w.includes('"P"') || w.includes('"Q"'))).toBe(false)
  })

  it('does not restore a partner that still conflicts with a kept fragment', () => {
    const result = composeAdvancedFragments([
      ...fragments(),
      frag('R', 30, { conflicts: ['P'] }),
    ].map((f) => (f.id === 'P' ? { ...f, conflicts: ['F', 'R'] } : f)))

    expect(result.included).toEqual(['R', 'E'])
    expect(result.excluded).toEqual(expect.arrayContaining(['F', 'P', 'D']))
  })

  it('still subjects a restored partner to the token budget', () => {
    const result = composeAdvancedFragments(fragments(), { maxTokens: 12 })

    expect(result.included).toEqual(['E'])
    expect(result.excluded).toEqual(['P', 'F', 'D'])
    expect(result.warnings).toContain('Fragment "P" excluded: exceeds token budget.')
  })
})
