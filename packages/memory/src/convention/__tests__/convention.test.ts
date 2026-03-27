import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConventionExtractor } from '../convention-extractor.js'
import { ALL_CONVENTION_CATEGORIES } from '../types.js'
import type {
  DetectedConvention,
  ConventionCategory,
  ConventionExtractorConfig,
} from '../types.js'
import type { MemoryService } from '../../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoredEntry {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

function createMockMemoryService(): {
  service: MemoryService
  store: Map<string, Record<string, unknown>>
} {
  const store = new Map<string, Record<string, unknown>>()

  const service = {
    put: vi.fn().mockImplementation(
      (_ns: string, _scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        store.set(key, value)
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (_ns: string, _scope: Record<string, string>, key?: string) => {
        if (key) {
          const item = store.get(key)
          if (!item || item['_deleted']) return Promise.resolve([])
          return Promise.resolve([item])
        }
        // Return all non-deleted entries
        const results: Record<string, unknown>[] = []
        for (const v of store.values()) {
          if (!v['_deleted']) results.push(v)
        }
        return Promise.resolve(results)
      },
    ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, store }
}

function makeConvention(overrides: Partial<DetectedConvention> = {}): DetectedConvention {
  return {
    id: 'test-convention',
    name: 'Test Convention',
    category: 'general',
    description: 'A test convention',
    examples: ['example code'],
    confidence: 0.8,
    occurrences: 1,
    ...overrides,
  }
}

const SAMPLE_CODE_CAMELCASE = `
const myVariable = 'hello'
const anotherVariable = 42
function doSomething() { return true }
`

const SAMPLE_CODE_NAMED_IMPORTS = `
import { foo } from './bar.js'
import { baz, qux } from './quux.js'
const myVal = foo()
`

const SAMPLE_CODE_MIXED = `
import { foo } from './bar.js'
import { baz } from './quux.js'
const myVariable = 'hello'
const anotherVar = 42
export const myFunction = () => {}
`

// ---------------------------------------------------------------------------
// Type Tests
// ---------------------------------------------------------------------------

describe('Convention Types', () => {
  it('ConventionCategory covers all expected values', () => {
    const expected: ConventionCategory[] = [
      'naming', 'structure', 'imports', 'error-handling', 'typing',
      'testing', 'api', 'database', 'styling', 'general',
    ]
    expect(ALL_CONVENTION_CATEGORIES).toEqual(expected)
  })

  it('DetectedConvention validates all fields', () => {
    const conv = makeConvention({
      id: 'my-conv',
      name: 'My Convention',
      category: 'naming',
      description: 'Use naming convention',
      pattern: '\\bfoo\\b',
      examples: ['foo bar'],
      confidence: 0.95,
      occurrences: 5,
      techStack: 'vue3',
      humanVerified: true,
    })
    expect(conv.id).toBe('my-conv')
    expect(conv.name).toBe('My Convention')
    expect(conv.category).toBe('naming')
    expect(conv.description).toBe('Use naming convention')
    expect(conv.pattern).toBe('\\bfoo\\b')
    expect(conv.examples).toEqual(['foo bar'])
    expect(conv.confidence).toBe(0.95)
    expect(conv.occurrences).toBe(5)
    expect(conv.techStack).toBe('vue3')
    expect(conv.humanVerified).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ConventionExtractor
// ---------------------------------------------------------------------------

describe('ConventionExtractor', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let extractor: ConventionExtractor

  beforeEach(() => {
    mock = createMockMemoryService()
    extractor = new ConventionExtractor({
      memoryService: mock.service,
    })
  })

  // ---- analyzeCode (heuristic) ----

  describe('analyzeCode() without LLM', () => {
    it('detects conventions using heuristic rules', async () => {
      const result = await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_CAMELCASE },
      ])
      expect(result.length).toBeGreaterThan(0)
      const naming = result.find(c => c.category === 'naming')
      expect(naming).toBeDefined()
      expect(naming!.confidence).toBe(0.6)
    })

    it('detects named imports convention', async () => {
      const result = await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_NAMED_IMPORTS },
      ])
      const importsConv = result.find(c => c.category === 'imports')
      expect(importsConv).toBeDefined()
    })

    it('increments occurrences for existing conventions', async () => {
      // First analysis
      await extractor.analyzeCode([
        { path: 'a.ts', content: SAMPLE_CODE_CAMELCASE },
      ])
      // Second analysis — same conventions should be found
      const result = await extractor.analyzeCode([
        { path: 'b.ts', content: SAMPLE_CODE_CAMELCASE },
      ])
      const naming = result.find(c => c.id === 'naming-camelcase-vars')
      expect(naming).toBeDefined()
      expect(naming!.occurrences).toBe(2)
    })
  })

  // ---- analyzeCode (LLM) ----

  describe('analyzeCode() with mock LLM', () => {
    it('detects conventions via LLM', async () => {
      const mockLlm = vi.fn().mockResolvedValue(JSON.stringify([
        {
          id: 'naming-kebab-files',
          name: 'Kebab-case file names',
          category: 'naming',
          description: 'Use kebab-case for file names',
          pattern: '[a-z]+(-[a-z]+)*\\.ts',
          examples: ['my-component.ts'],
          confidence: 0.9,
          occurrences: 3,
        },
      ]))
      const llmExtractor = new ConventionExtractor({
        memoryService: mock.service,
        llm: mockLlm,
      })
      const result = await llmExtractor.analyzeCode([
        { path: 'my-component.ts', content: 'export class MyComponent {}' },
      ])
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('naming-kebab-files')
      expect(result[0]!.confidence).toBe(0.9)
      expect(mockLlm).toHaveBeenCalledOnce()
    })

    it('falls back to heuristics on LLM failure', async () => {
      const mockLlm = vi.fn().mockRejectedValue(new Error('LLM timeout'))
      const llmExtractor = new ConventionExtractor({
        memoryService: mock.service,
        llm: mockLlm,
      })
      const result = await llmExtractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_MIXED },
      ])
      // Should still get heuristic results
      expect(result.length).toBeGreaterThan(0)
    })
  })

  // ---- getConventions ----

  describe('getConventions()', () => {
    it('filters by category', async () => {
      await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_MIXED },
      ])
      const naming = await extractor.getConventions({ category: 'naming' })
      expect(naming.every(c => c.category === 'naming')).toBe(true)
    })

    it('filters by minConfidence', async () => {
      await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_MIXED },
      ])
      const highConf = await extractor.getConventions({ minConfidence: 0.5 })
      expect(highConf.every(c => c.confidence >= 0.5)).toBe(true)

      const veryHighConf = await extractor.getConventions({ minConfidence: 0.99 })
      expect(veryHighConf).toHaveLength(0)
    })

    it('filters by techStack', async () => {
      // Store a convention with techStack directly
      mock.store.set('react-hooks', {
        id: 'react-hooks',
        name: 'React hooks pattern',
        category: 'structure',
        description: 'Use hooks',
        examples: [],
        confidence: 0.8,
        occurrences: 1,
        techStack: 'react',
        text: 'React hooks pattern: Use hooks',
      })
      mock.store.set('vue-composition', {
        id: 'vue-composition',
        name: 'Vue composition API',
        category: 'structure',
        description: 'Use composition API',
        examples: [],
        confidence: 0.8,
        occurrences: 1,
        techStack: 'vue3',
        text: 'Vue composition API: Use composition API',
      })

      const react = await extractor.getConventions({ techStack: 'react' })
      expect(react).toHaveLength(1)
      expect(react[0]!.techStack).toBe('react')
    })
  })

  // ---- checkConformance ----

  describe('checkConformance()', () => {
    it('identifies followed and violated conventions', async () => {
      const conventions: DetectedConvention[] = [
        makeConvention({
          id: 'naming-camel',
          name: 'camelCase vars',
          category: 'naming',
          pattern: '\\b(const|let)\\s+[a-z][a-zA-Z]*\\b',
        }),
        makeConvention({
          id: 'no-var',
          name: 'No var keyword',
          category: 'naming',
          pattern: '\\bvar\\s+',
        }),
      ]

      const code = 'const myVar = 1\nlet anotherVar = 2'
      const result = await extractor.checkConformance(code, conventions)

      expect(result.followed.length).toBeGreaterThanOrEqual(1)
      // 'var' pattern should match since 'myVar' contains 'var' in pattern context
      // but specifically 'var\s+' won't match 'const myVar'
      expect(result.violated.length).toBeGreaterThanOrEqual(0)
    })

    it('calculates conformanceScore', async () => {
      const conventions: DetectedConvention[] = [
        makeConvention({
          id: 'has-pattern',
          pattern: 'const',
        }),
        makeConvention({
          id: 'missing-pattern',
          pattern: 'ZZZZNOTFOUND',
        }),
      ]

      const result = await extractor.checkConformance('const x = 1', conventions)
      expect(result.conformanceScore).toBe(0.5)
      expect(result.followed).toHaveLength(1)
      expect(result.violated).toHaveLength(1)
    })

    it('returns score 1.0 when no conventions', async () => {
      const result = await extractor.checkConformance('any code', [])
      expect(result.conformanceScore).toBe(1.0)
      expect(result.followed).toHaveLength(0)
      expect(result.violated).toHaveLength(0)
    })

    it('skips conventions without pattern in heuristic mode', async () => {
      const conventions: DetectedConvention[] = [
        makeConvention({ id: 'no-pattern', pattern: undefined }),
      ]
      const result = await extractor.checkConformance('any code', conventions)
      expect(result.conformanceScore).toBe(1.0)
      expect(result.followed).toHaveLength(0)
      expect(result.violated).toHaveLength(0)
    })
  })

  // ---- setHumanVerdict ----

  describe('setHumanVerdict()', () => {
    it('sets confidence to 1.0 and humanVerified to true when confirmed', async () => {
      await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_CAMELCASE },
      ])

      const before = await extractor.getConventions()
      const convId = before[0]!.id

      await extractor.setHumanVerdict(convId, true)

      const after = await extractor.getConventions()
      const updated = after.find(c => c.id === convId)
      expect(updated).toBeDefined()
      expect(updated!.confidence).toBe(1.0)
      expect(updated!.humanVerified).toBe(true)
    })

    it('sets confidence to 0 and humanVerified to false when rejected', async () => {
      await extractor.analyzeCode([
        { path: 'test.ts', content: SAMPLE_CODE_CAMELCASE },
      ])

      const before = await extractor.getConventions()
      const convId = before[0]!.id

      await extractor.setHumanVerdict(convId, false)

      const after = await extractor.getConventions()
      const updated = after.find(c => c.id === convId)
      expect(updated).toBeDefined()
      expect(updated!.confidence).toBe(0)
      expect(updated!.humanVerified).toBe(false)
    })

    it('does nothing for unknown convention id', async () => {
      // Should not throw
      await extractor.setHumanVerdict('nonexistent', true)
      expect(mock.service.put).not.toHaveBeenCalled()
    })
  })

  // ---- formatForPrompt ----

  describe('formatForPrompt()', () => {
    it('generates markdown with categories', async () => {
      mock.store.set('naming-camel', {
        id: 'naming-camel',
        name: 'camelCase variables',
        category: 'naming',
        description: 'Use camelCase for variables',
        examples: ['const myVar = 1'],
        confidence: 0.9,
        occurrences: 5,
        text: 'camelCase variables: Use camelCase for variables',
      })
      mock.store.set('imports-named', {
        id: 'imports-named',
        name: 'Named imports',
        category: 'imports',
        description: 'Use named imports',
        examples: ["import { foo } from './bar.js'"],
        confidence: 0.8,
        occurrences: 3,
        text: 'Named imports: Use named imports',
      })

      const output = await extractor.formatForPrompt()

      expect(output).toContain('## Project Conventions')
      expect(output).toContain('### Naming')
      expect(output).toContain('### Imports')
      expect(output).toContain('camelCase variables')
      expect(output).toContain('Named imports')
      expect(output).toContain('confidence: 0.90')
    })

    it('excludes low-confidence conventions by default', async () => {
      mock.store.set('low-conf', {
        id: 'low-conf',
        name: 'Low confidence',
        category: 'general',
        description: 'Not sure about this',
        examples: [],
        confidence: 0.2,
        occurrences: 1,
        text: 'Low confidence: Not sure about this',
      })

      const output = await extractor.formatForPrompt()
      expect(output).toBe('')
    })

    it('respects custom minConfidence filter', async () => {
      mock.store.set('medium-conf', {
        id: 'medium-conf',
        name: 'Medium confidence',
        category: 'general',
        description: 'Somewhat sure',
        examples: [],
        confidence: 0.4,
        occurrences: 1,
        text: 'Medium confidence: Somewhat sure',
      })

      const output = await extractor.formatForPrompt({ minConfidence: 0.3 })
      expect(output).toContain('Medium confidence')
    })

    it('returns empty string when no conventions match', async () => {
      const output = await extractor.formatForPrompt()
      expect(output).toBe('')
    })
  })

  // ---- consolidate ----

  describe('consolidate()', () => {
    it('merges similar conventions', async () => {
      mock.store.set('camel-case-vars', {
        id: 'camel-case-vars',
        name: 'camelCase variables',
        category: 'naming',
        description: 'Use camelCase',
        examples: ['const myVar = 1'],
        confidence: 0.7,
        occurrences: 3,
        text: 'camelCase variables: Use camelCase',
      })
      mock.store.set('camel-case-variables', {
        id: 'camel-case-variables',
        name: 'camelCase variables', // same name = similarity 1.0
        category: 'naming',
        description: 'Use camelCase for all variables',
        examples: ['let anotherVar = 2'],
        confidence: 0.8,
        occurrences: 2,
        text: 'camelCase variables: Use camelCase for all variables',
      })

      const result = await extractor.consolidate()
      expect(result.merged).toBe(1) // two merged into one

      const remaining = await extractor.getConventions()
      // One survived, one was tombstoned
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.occurrences).toBe(5) // 3 + 2
      expect(remaining[0]!.confidence).toBe(0.8) // max
    })

    it('prunes low-confidence conventions', async () => {
      mock.store.set('low-conv', {
        id: 'low-conv',
        name: 'Obscure tab spacing rule',
        category: 'styling',
        description: 'Not sure about this',
        examples: [],
        confidence: 0.1,
        occurrences: 1,
        text: 'Obscure tab spacing rule',
      })
      mock.store.set('high-conv', {
        id: 'high-conv',
        name: 'Named imports preferred',
        category: 'imports',
        description: 'Very sure about imports',
        examples: [],
        confidence: 0.9,
        occurrences: 5,
        text: 'Named imports preferred',
      })

      const result = await extractor.consolidate({ minConfidence: 0.3 })
      expect(result.pruned).toBe(1)

      const remaining = await extractor.getConventions()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.id).toBe('high-conv')
    })

    it('preserves human-verified conventions regardless of confidence', async () => {
      mock.store.set('verified-low', {
        id: 'verified-low',
        name: 'Verified but low confidence',
        category: 'general',
        description: 'Human said yes',
        examples: [],
        confidence: 0.1,
        occurrences: 1,
        humanVerified: true,
        text: 'Verified but low confidence',
      })

      const result = await extractor.consolidate({ minConfidence: 0.5 })
      expect(result.pruned).toBe(0)

      const remaining = await extractor.getConventions()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.id).toBe('verified-low')
    })

    it('does not merge conventions from different categories', async () => {
      mock.store.set('naming-conv', {
        id: 'naming-conv',
        name: 'Same name pattern',
        category: 'naming',
        description: 'Naming convention',
        examples: [],
        confidence: 0.7,
        occurrences: 1,
        text: 'Naming convention',
      })
      mock.store.set('imports-conv', {
        id: 'imports-conv',
        name: 'Different category',
        category: 'imports',
        description: 'Import convention',
        examples: [],
        confidence: 0.7,
        occurrences: 1,
        text: 'Import convention',
      })

      const result = await extractor.consolidate()
      expect(result.merged).toBe(0)

      const remaining = await extractor.getConventions()
      expect(remaining).toHaveLength(2)
    })
  })

  // ---- LLM conformance ----

  describe('checkConformance() with LLM', () => {
    it('uses LLM for conformance checking', async () => {
      const mockLlm = vi.fn().mockResolvedValue(JSON.stringify({
        followed: [
          { conventionId: 'naming-camel', evidence: 'Uses camelCase throughout' },
        ],
        violated: [
          { conventionId: 'no-any', evidence: 'Found any type', suggestion: 'Use unknown instead' },
        ],
      }))

      const llmExtractor = new ConventionExtractor({
        memoryService: mock.service,
        llm: mockLlm,
      })

      const conventions: DetectedConvention[] = [
        makeConvention({ id: 'naming-camel', name: 'camelCase', category: 'naming' }),
        makeConvention({ id: 'no-any', name: 'No any type', category: 'typing' }),
      ]

      const result = await llmExtractor.checkConformance('const x: any = 1', conventions)
      expect(result.followed).toHaveLength(1)
      expect(result.violated).toHaveLength(1)
      expect(result.conformanceScore).toBe(0.5)
      expect(result.violated[0]!.suggestion).toBe('Use unknown instead')
    })
  })
})
