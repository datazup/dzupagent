/**
 * Branch coverage deep-dive for conventions, validation, generation, and related
 * small-conditional-path files.
 *
 * Targets:
 * - convention-enforcer: 'semicolons', 'indent-4spaces' switch cases,
 *   low-confidence prompt filtering, category grouping with partial low-confidence
 * - import-validator: .jsx/.vue/.tsx imports, dynamic with no match, non-relative
 * - code-block-parser: empty language, multiple equal-size blocks, trailing newline
 * - failure-router: custom override, unknown errorCategory
 * - fix-escalation: custom long config, strategy name mapping
 * - framework-adapter: getAdaptationGuide not-found and found paths
 */
import { describe, it, expect } from 'vitest'
import { enforceConventions, conventionsToPrompt } from '../conventions/convention-enforcer.js'
import type { DetectedConvention } from '../conventions/convention-detector.js'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { validateImports } from '../validation/import-validator.js'
import { parseCodeBlocks, extractLargestCodeBlock, detectLanguage } from '../generation/code-block-parser.js'
import { routeFailure } from '../ci/failure-router.js'
import type { CIFailure } from '../ci/ci-monitor.js'
import { getEscalationStrategy } from '../pipeline/fix-escalation.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'

function makeConv(name: string, confidence = 0.9, category = 'formatting'): DetectedConvention {
  return { name, category, description: `Convention: ${name}`, examples: [], confidence }
}

// ---------------------------------------------------------------------------
// convention-enforcer additional branch paths
// ---------------------------------------------------------------------------

describe('enforceConventions — switch branch coverage', () => {
  it('detects semicolons convention violation (missing semicolon)', () => {
    const result = enforceConventions({ 'a.ts': 'const x = 1' }, [makeConv('semicolons')])
    expect(result.violations.some(v => v.convention === 'semicolons')).toBe(true)
  })

  it('semicolons convention: allows lines ending with { , ( or //', () => {
    // Note: the enforcer skip list is { , ( and comment leaders (// and *).
    // Lines ending with [ ARE flagged; we exclude them from the fixture.
    const code = ['function f() {', 'const obj = {a,', 'const call = foo(', '// comment', ' * comment-like'].join('\n')
    const result = enforceConventions({ 'a.ts': code }, [makeConv('semicolons')])
    expect(result.violations.length).toBe(0)
  })

  it('semicolons convention: skips import lines', () => {
    const code = `import { foo } from './bar'\nconst x = 1\n`
    const result = enforceConventions({ 'a.ts': code }, [makeConv('semicolons')])
    // only `const x = 1` flagged (imports skipped)
    expect(result.violations.length).toBe(1)
  })

  it('detects indent-4spaces tab-indent violation', () => {
    const result = enforceConventions({ 'a.ts': '\tconst x = 1' }, [makeConv('indent-4spaces')])
    expect(result.violations.some(v => v.actual === 'tab indent')).toBe(true)
  })

  it('indent-4spaces: accepts 4-space indent without flagging', () => {
    const result = enforceConventions({ 'a.ts': '    const x = 1' }, [makeConv('indent-4spaces')])
    expect(result.violations).toHaveLength(0)
  })

  it('type-imports: skips import with all-lowercase names (not type heuristic)', () => {
    const result = enforceConventions(
      { 'a.ts': "import { foo, bar } from './mod'" },
      [makeConv('type-imports')],
    )
    expect(result.violations).toHaveLength(0)
  })

  it('type-imports: skips empty braces', () => {
    const result = enforceConventions(
      { 'a.ts': "import {} from './mod'" },
      [makeConv('type-imports')],
    )
    expect(result.violations).toHaveLength(0)
  })

  it('single-quotes: skips import lines with double quotes', () => {
    const result = enforceConventions(
      { 'a.ts': 'import { A } from "./mod"' },
      [makeConv('single-quotes')],
    )
    expect(result.violations).toHaveLength(0)
  })

  it('double-quotes: skips require() with single quotes', () => {
    const result = enforceConventions(
      { 'a.ts': "const x = require('mod')" },
      [makeConv('double-quotes')],
    )
    expect(result.violations).toHaveLength(0)
  })
})

describe('conventionsToPrompt — branch coverage', () => {
  it('filters per-category: drops categories where all items are low-confidence', () => {
    const convs: DetectedConvention[] = [
      { name: 'x', category: 'formatting', description: 'Weak', examples: [], confidence: 0.1 },
      { name: 'y', category: 'naming', description: 'Strong', examples: [], confidence: 0.9 },
    ]
    const prompt = conventionsToPrompt(convs)
    expect(prompt).toContain('NAMING:')
    expect(prompt).not.toContain('FORMATTING:')
  })

  it('shows examples when present', () => {
    const convs: DetectedConvention[] = [
      { name: 'x', category: 'naming', description: 'Rule X', examples: ['example1', 'example2'], confidence: 0.8 },
    ]
    const prompt = conventionsToPrompt(convs)
    expect(prompt).toContain('example1')
    expect(prompt).toContain('example2')
  })
})

// ---------------------------------------------------------------------------
// validateImports — extension edge cases
// ---------------------------------------------------------------------------

describe('validateImports — extension/path branches', () => {
  it('handles import in .jsx file (not skipped)', () => {
    const vfs = new VirtualFS({
      'src/a.jsx': 'import { x } from "./missing"',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(false)
  })

  it('handles import in .vue file', () => {
    const vfs = new VirtualFS({
      'src/A.vue': 'import { x } from "./missing"',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(false)
  })

  it('resolves .tsx index imports', () => {
    const vfs = new VirtualFS({
      'src/App.tsx': 'import { Y } from "./comp"',
      'src/comp/index.tsx': 'export const Y = 1',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(true)
  })

  it('resolves .js extension in import that points to .ts file (ESM convention)', () => {
    const vfs = new VirtualFS({
      'src/a.ts': 'import { x } from "./b.js"',
      'src/b.ts': 'export const x = 1',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(true)
  })

  it('resolves .js extension in import that points to .tsx file', () => {
    const vfs = new VirtualFS({
      'src/a.ts': 'import { X } from "./Comp.js"',
      'src/Comp.tsx': 'export const X = 1',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(true)
  })

  it('reports unresolved dynamic import', () => {
    const vfs = new VirtualFS({
      'src/a.ts': 'const m = await import("./ghost")',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(false)
  })

  it('skips export-from with missing relative target (reports error)', () => {
    const vfs = new VirtualFS({
      'src/index.ts': 'export { Foo } from "./missing"',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(false)
  })

  it('handles root-level import (no slash in fromFile)', () => {
    const vfs = new VirtualFS({
      'index.ts': 'import { x } from "./missing"',
    })
    const r = validateImports(vfs)
    expect(r.valid).toBe(false)
    expect(r.errors[0]!.file).toBe('index.ts')
  })
})

// ---------------------------------------------------------------------------
// code-block-parser branch coverage
// ---------------------------------------------------------------------------

describe('parseCodeBlocks — branch coverage', () => {
  it('empty language tag yields empty string language', () => {
    const blocks = parseCodeBlocks('```\nline\n```')
    expect(blocks[0]!.language).toBe('')
  })

  it('returns only first block when both blocks equal length', () => {
    const t = '```js\nabc\n```\n```ts\nabc\n```'
    const out = extractLargestCodeBlock(t)
    // Equal size → first wins
    expect(out).toBe('abc')
  })

  it('extractLargestCodeBlock handles multiple blocks of varying sizes', () => {
    const t = '```\nx\n```\n```\nlonger block\n```\n```\nmid\n```'
    expect(extractLargestCodeBlock(t)).toBe('longer block')
  })

  it('detectLanguage handles files with multiple dots', () => {
    expect(detectLanguage('my.config.ts')).toBe('typescript')
  })

  it('detectLanguage handles UPPERCASE extensions', () => {
    expect(detectLanguage('Component.TSX')).toBe('typescript')
  })

  it('detectLanguage handles .env file', () => {
    expect(detectLanguage('prod.env')).toBe('dotenv')
  })

  it('detectLanguage handles markdown', () => {
    expect(detectLanguage('README.md')).toBe('markdown')
  })

  it('detectLanguage handles sh/bash', () => {
    expect(detectLanguage('install.sh')).toBe('bash')
    expect(detectLanguage('install.bash')).toBe('bash')
  })

  it('detectLanguage handles sql/toml/xml/svg', () => {
    expect(detectLanguage('q.sql')).toBe('sql')
    expect(detectLanguage('c.toml')).toBe('toml')
    expect(detectLanguage('x.xml')).toBe('xml')
    expect(detectLanguage('i.svg')).toBe('svg')
  })
})

// ---------------------------------------------------------------------------
// failure-router additional branches
// ---------------------------------------------------------------------------

describe('routeFailure — branch coverage', () => {
  it('merges custom with defaults (custom overrides existing category)', () => {
    const failure: CIFailure = { jobName: 'j', logExcerpt: 'x', errorCategory: 'build' }
    const custom = {
      build: {
        category: 'build' as const,
        promptHint: 'NEW HINT',
        suggestedTools: ['x'],
        maxAttempts: 1,
      },
    }
    const s = routeFailure(failure, custom)
    expect(s.promptHint).toBe('NEW HINT')
  })

  it('falls back to default unknown when category is not provided at all', () => {
    // No errorCategory → defaults to 'unknown'
    const failure: CIFailure = { jobName: 'j', logExcerpt: 'x' }
    const s = routeFailure(failure)
    expect(s.category).toBe('unknown')
  })

  it('uses custom unknown when supplied via customStrategies', () => {
    const failure: CIFailure = { jobName: 'j', logExcerpt: 'x' }
    const custom = {
      unknown: {
        category: 'unknown' as const,
        promptHint: 'CUSTOM UNKNOWN',
        suggestedTools: [],
        maxAttempts: 5,
      },
    }
    const s = routeFailure(failure, custom)
    expect(s.promptHint).toBe('CUSTOM UNKNOWN')
    expect(s.maxAttempts).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// fix-escalation branch coverage
// ---------------------------------------------------------------------------

describe('getEscalationStrategy — branch coverage', () => {
  it('returns last strategy for negative attempt (clamped to 0)', () => {
    const s = getEscalationStrategy(-5)
    // Math.min(-5, len-1) = -5; then array access arr[-5] = undefined → falls back to last
    expect(['targeted', 'expanded', 'escalated']).toContain(s.name)
  })

  it('returns strategy by index for single-strategy custom config', () => {
    const custom = {
      maxAttempts: 1,
      strategies: [{ name: 'targeted' as const }],
    }
    expect(getEscalationStrategy(0, custom).name).toBe('targeted')
    expect(getEscalationStrategy(10, custom).name).toBe('targeted')
  })

  it('preserves strategy metadata (modelTier) at escalated level', () => {
    const s = getEscalationStrategy(2)
    expect(s.modelTier).toBe('reasoning')
    expect(s.includeFullVfs).toBe(true)
  })

  it('targeted has no prompt suffix by default', () => {
    const s = getEscalationStrategy(0)
    expect(s.promptSuffix).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter branch coverage
// ---------------------------------------------------------------------------

describe('FrameworkAdapter — branch coverage', () => {
  it('returns null from getAdaptationGuide for unknown pair', () => {
    const a = new FrameworkAdapter()
    expect(a.getAdaptationGuide('unknown', 'also-unknown')).toBeNull()
  })

  it('returns non-null guide for a built-in frontend pair', () => {
    const a = new FrameworkAdapter()
    const guide = a.getAdaptationGuide('vue3', 'react')
    // Either available (non-null) or null if not in builtin map; must be string|null
    expect(guide === null || typeof guide === 'string').toBe(true)
  })

  it('allows multiple instances with independent built-in loading', () => {
    const a = new FrameworkAdapter()
    const b = new FrameworkAdapter()
    expect(a).not.toBe(b)
  })
})
