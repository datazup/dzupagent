import { describe, it, expect } from 'vitest'
import { enforceConventions, conventionsToPrompt } from '../conventions/convention-enforcer.js'
import type { DetectedConvention } from '../conventions/convention-detector.js'

// ---------------------------------------------------------------------------
// Helper: create a convention
// ---------------------------------------------------------------------------

function makeConvention(name: string, confidence = 0.9): DetectedConvention {
  return {
    name,
    category: 'formatting',
    description: `Convention: ${name}`,
    examples: [],
    confidence,
  }
}

// ---------------------------------------------------------------------------
// enforceConventions
// ---------------------------------------------------------------------------

describe('enforceConventions', () => {
  it('returns empty violations and score 100 for no conventions', () => {
    const result = enforceConventions({ 'file.ts': 'const x = 1' }, [])
    expect(result.violations).toHaveLength(0)
    expect(result.score).toBe(100)
  })

  it('detects single-quote violations (double quotes used)', () => {
    const conv = makeConvention('single-quotes')
    const files = { 'file.ts': 'const x = "hello"' }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]!.convention).toBe('single-quotes')
  })

  it('does not flag single quotes when single-quotes convention is set', () => {
    const conv = makeConvention('single-quotes')
    const files = { 'file.ts': "const x = 'hello'" }
    const result = enforceConventions(files, [conv])
    expect(result.violations).toHaveLength(0)
  })

  it('detects double-quote violations (single quotes used)', () => {
    const conv = makeConvention('double-quotes')
    const files = { 'file.ts': "const x = 'hello'" }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it('detects no-semicolons violations', () => {
    const conv = makeConvention('no-semicolons')
    const files = { 'file.ts': 'const x = 1;' }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]!.expected).toBe('no semicolon')
  })

  it('allows for-loops with no-semicolons convention', () => {
    const conv = makeConvention('no-semicolons')
    const files = { 'file.ts': 'for (let i = 0; i < 10; i++) {}' }
    const result = enforceConventions(files, [conv])
    expect(result.violations).toHaveLength(0)
  })

  it('detects indent-2spaces violations (tab indent)', () => {
    const conv = makeConvention('indent-2spaces')
    const files = { 'file.ts': '\tconst x = 1' }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]!.expected).toBe('2-space indent')
  })

  it('detects indent-2spaces violations (4-space indent)', () => {
    const conv = makeConvention('indent-2spaces')
    const files = { 'file.ts': '    const x = 1' }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it('detects indent-tabs violations (space indent)', () => {
    const conv = makeConvention('indent-tabs')
    const files = { 'file.ts': '  const x = 1' }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it('detects type-imports violations', () => {
    const conv = makeConvention('type-imports')
    const files = { 'file.ts': "import { MyType } from './types'" }
    const result = enforceConventions(files, [conv])
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]!.expected).toContain('import type')
  })

  it('does not flag import type as a violation', () => {
    const conv = makeConvention('type-imports')
    const files = { 'file.ts': "import type { MyType } from './types'" }
    const result = enforceConventions(files, [conv])
    expect(result.violations).toHaveLength(0)
  })

  it('skips unknown convention names', () => {
    const conv = makeConvention('unknown-convention')
    const files = { 'file.ts': 'const x = 1' }
    const result = enforceConventions(files, [conv])
    expect(result.violations).toHaveLength(0)
  })

  it('computes a score reflecting violations', () => {
    const conv = makeConvention('no-semicolons')
    const lines = Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`)
    const files = { 'file.ts': lines.join('\n') }
    const result = enforceConventions(files, [conv])
    expect(result.score).toBeLessThan(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('handles empty files', () => {
    const conv = makeConvention('no-semicolons')
    const result = enforceConventions({}, [conv])
    expect(result.violations).toHaveLength(0)
    expect(result.score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// conventionsToPrompt
// ---------------------------------------------------------------------------

describe('conventionsToPrompt', () => {
  it('returns empty string for no conventions', () => {
    expect(conventionsToPrompt([])).toBe('')
  })

  it('returns empty string when all conventions have low confidence', () => {
    const convs: DetectedConvention[] = [
      { name: 'x', category: 'formatting', description: 'Test', examples: [], confidence: 0.1 },
    ]
    expect(conventionsToPrompt(convs)).toBe('')
  })

  it('includes category headers and descriptions for high-confidence conventions', () => {
    const convs: DetectedConvention[] = [
      { name: 'indent-2spaces', category: 'formatting', description: 'Use 2-space indentation', examples: ['  const'], confidence: 0.9 },
    ]
    const prompt = conventionsToPrompt(convs)
    expect(prompt).toContain('FORMATTING:')
    expect(prompt).toContain('Use 2-space indentation')
    expect(prompt).toContain('const')
  })

  it('groups conventions by category', () => {
    const convs: DetectedConvention[] = [
      { name: 'a', category: 'formatting', description: 'A', examples: [], confidence: 0.8 },
      { name: 'b', category: 'naming', description: 'B', examples: [], confidence: 0.8 },
    ]
    const prompt = conventionsToPrompt(convs)
    expect(prompt).toContain('FORMATTING:')
    expect(prompt).toContain('NAMING:')
  })
})
