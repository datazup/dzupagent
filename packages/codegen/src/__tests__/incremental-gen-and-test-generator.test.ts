import { describe, it, expect } from 'vitest'
import {
  splitIntoSections,
  detectAffectedSections,
  applyIncrementalChanges,
  buildIncrementalPrompt,
  type CodeSection,
  type IncrementalChange,
} from '../generation/incremental-gen.js'
import {
  determineTestStrategy,
  extractExports,
  buildTestPath,
  generateTestSpecs,
  type TestTarget,
  type ExportInfo,
} from '../generation/test-generator.js'
import { sample, selectBest, commitBest } from '../vfs/parallel-sampling.js'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { CopyOnWriteVFS } from '../vfs/cow-vfs.js'

// ============================================================================
// splitIntoSections
// ============================================================================
describe('splitIntoSections', () => {
  it('splits a file with imports, functions, and classes', () => {
    const content = [
      "import { foo } from './foo.js'",
      '',
      'export function doStuff(x: number): number {',
      '  return x + 1',
      '}',
      '',
      'export class MyService {',
      '  run() {}',
      '}',
    ].join('\n')
    const sections = splitIntoSections(content)
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.find(s => s.type === 'import')).toBeDefined()
    expect(sections.find(s => s.type === 'function')).toBeDefined()
    expect(sections.find(s => s.type === 'class')).toBeDefined()
  })

  it('merges consecutive imports into one section', () => {
    const content = [
      "import { a } from './a.js'",
      "import { b } from './b.js'",
      "import { c } from './c.js'",
    ].join('\n')
    const sections = splitIntoSections(content)
    const imports = sections.filter(s => s.type === 'import')
    expect(imports.length).toBe(1)
    expect(imports[0]!.content).toContain('a')
    expect(imports[0]!.content).toContain('c')
  })

  it('detects interface sections', () => {
    const content = [
      'export interface Config {',
      '  name: string',
      '  value: number',
      '}',
    ].join('\n')
    const sections = splitIntoSections(content)
    expect(sections[0]!.type).toBe('interface')
    expect(sections[0]!.name).toBe('Config')
  })

  it('detects type alias sections', () => {
    const content = 'export type Result = string | number'
    const sections = splitIntoSections(content)
    expect(sections[0]!.type).toBe('type')
    expect(sections[0]!.name).toBe('Result')
  })

  it('detects const sections', () => {
    const content = 'export const MAX_RETRIES = 3'
    const sections = splitIntoSections(content)
    expect(sections[0]!.type).toBe('const')
    expect(sections[0]!.name).toBe('MAX_RETRIES')
  })

  it('detects enum sections as const type', () => {
    const content = [
      'export enum Status {',
      '  Active,',
      '  Inactive,',
      '}',
    ].join('\n')
    const sections = splitIntoSections(content)
    expect(sections[0]!.type).toBe('const')
    expect(sections[0]!.name).toBe('Status')
  })

  it('detects async function sections', () => {
    const content = [
      'export async function fetchData() {',
      '  return await fetch("url")',
      '}',
    ].join('\n')
    const sections = splitIntoSections(content)
    expect(sections[0]!.type).toBe('function')
    expect(sections[0]!.name).toBe('fetchData')
  })

  it('skips comment-only lines', () => {
    const content = [
      '// This is a comment',
      '/* block comment */',
      '* continued',
      'export const x = 1',
    ].join('\n')
    const sections = splitIntoSections(content)
    expect(sections.length).toBe(1)
    expect(sections[0]!.name).toBe('x')
  })

  it('returns empty array for empty content', () => {
    const sections = splitIntoSections('')
    expect(sections).toHaveLength(0)
  })

  it('tracks correct line numbers', () => {
    const content = [
      '',
      "import { a } from './a.js'",
      '',
      'export function doStuff() {',
      '  return 1',
      '}',
    ].join('\n')
    const sections = splitIntoSections(content)
    const fn = sections.find(s => s.type === 'function')
    expect(fn).toBeDefined()
    expect(fn!.startLine).toBe(4)
  })
})

// ============================================================================
// detectAffectedSections
// ============================================================================
describe('detectAffectedSections', () => {
  const sections: CodeSection[] = [
    { name: 'imports', startLine: 1, endLine: 2, content: "import...", type: 'import' },
    { name: 'calculateTotal', startLine: 4, endLine: 8, content: 'function...', type: 'function' },
    { name: 'UserService', startLine: 10, endLine: 20, content: 'class...', type: 'class' },
  ]

  it('finds sections matching change description tokens', () => {
    const affected = detectAffectedSections(sections, 'Fix the calculateTotal function')
    expect(affected.find(s => s.name === 'calculateTotal')).toBeDefined()
  })

  it('includes import section when other sections are affected', () => {
    const affected = detectAffectedSections(sections, 'Update UserService')
    expect(affected.find(s => s.type === 'import')).toBeDefined()
    expect(affected.find(s => s.name === 'UserService')).toBeDefined()
  })

  it('does not include imports alone (import section is skipped in matching)', () => {
    const affected = detectAffectedSections(sections, 'Update imports only')
    // 'imports' as section name is skipped since its type is 'import'
    expect(affected).toHaveLength(0)
  })

  it('returns empty when no sections match', () => {
    const affected = detectAffectedSections(sections, 'Do something unrelated xyz')
    expect(affected).toHaveLength(0)
  })

  it('matches partial token overlap', () => {
    const affected = detectAffectedSections(sections, 'The user service needs updating')
    // 'user' partially matches 'UserService' (case-insensitive)
    expect(affected.find(s => s.name === 'UserService')).toBeDefined()
  })
})

// ============================================================================
// applyIncrementalChanges
// ============================================================================
describe('applyIncrementalChanges', () => {
  it('replaces a section', () => {
    const original = [
      'const a = 1',
      'function doStuff() {',
      '  return 1',
      '}',
    ].join('\n')
    const changes: IncrementalChange[] = [
      { section: 'doStuff', operation: 'replace', newContent: 'function doStuff() {\n  return 2\n}' },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).toContain('return 2')
    expect(result.changes.length).toBe(1)
    expect(result.changedLines).toBeGreaterThan(0)
  })

  it('deletes a section', () => {
    const original = [
      'const a = 1',
      'function doStuff() {',
      '  return 1',
      '}',
    ].join('\n')
    const changes: IncrementalChange[] = [
      { section: 'doStuff', operation: 'delete' },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).not.toContain('doStuff')
    expect(result.changedLines).toBeGreaterThan(0)
  })

  it('adds content after a section', () => {
    const original = [
      'const a = 1',
      'function doStuff() {',
      '  return 1',
      '}',
    ].join('\n')
    const changes: IncrementalChange[] = [
      { section: 'doStuff', operation: 'add', newContent: 'function doMore() {\n  return 2\n}' },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).toContain('doMore')
    expect(result.changes.length).toBe(1)
  })

  it('adds content at specific line', () => {
    const original = 'const a = 1\nconst b = 2'
    const changes: IncrementalChange[] = [
      { section: 'newSection', operation: 'add', newContent: 'const c = 3', insertAfterLine: 1 },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).toContain('const c = 3')
  })

  it('preserves line count correctly', () => {
    const original = 'const a = 1\nconst b = 2\nconst c = 3'
    const changes: IncrementalChange[] = []
    const result = applyIncrementalChanges(original, changes)
    expect(result.preservedLines).toBe(3)
    expect(result.changedLines).toBe(0)
  })

  it('handles multiple changes sorted by position', () => {
    const original = [
      'const a = 1',
      'function foo() {',
      '  return 1',
      '}',
      'function bar() {',
      '  return 2',
      '}',
    ].join('\n')
    const changes: IncrementalChange[] = [
      { section: 'foo', operation: 'replace', newContent: 'function foo() {\n  return 10\n}' },
      { section: 'bar', operation: 'replace', newContent: 'function bar() {\n  return 20\n}' },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).toContain('return 10')
    expect(result.content).toContain('return 20')
    expect(result.changes.length).toBe(2)
  })

  it('ignores changes for non-existent sections (no match)', () => {
    const original = 'const a = 1'
    const changes: IncrementalChange[] = [
      { section: 'nonexistent', operation: 'replace', newContent: 'replaced' },
    ]
    const result = applyIncrementalChanges(original, changes)
    expect(result.content).toBe('const a = 1')
    // replace requires section match, so change is not applied
    expect(result.changes.length).toBe(0)
  })
})

// ============================================================================
// buildIncrementalPrompt
// ============================================================================
describe('buildIncrementalPrompt', () => {
  it('includes file path and change description', () => {
    const sections: CodeSection[] = [
      { name: 'imports', startLine: 1, endLine: 1, content: "import x from 'x'", type: 'import' },
      { name: 'doStuff', startLine: 3, endLine: 6, content: 'function doStuff() {}', type: 'function' },
    ]
    const prompt = buildIncrementalPrompt('src/service.ts', sections, [sections[1]!], 'Fix return type')
    expect(prompt).toContain('src/service.ts')
    expect(prompt).toContain('Fix return type')
    expect(prompt).toContain('doStuff')
  })

  it('lists unaffected sections in unchanged section', () => {
    const sections: CodeSection[] = [
      { name: 'imports', startLine: 1, endLine: 1, content: "import x", type: 'import' },
      { name: 'helperA', startLine: 3, endLine: 5, content: 'function helperA() {}', type: 'function' },
      { name: 'helperB', startLine: 7, endLine: 9, content: 'function helperB() {}', type: 'function' },
    ]
    const prompt = buildIncrementalPrompt('src/a.ts', sections, [sections[0]!], 'Fix imports')
    expect(prompt).toContain('helperA')
    expect(prompt).toContain('helperB')
    expect(prompt).toContain('Unchanged Sections')
  })

  it('shows (none) when all sections are affected', () => {
    const sections: CodeSection[] = [
      { name: 'doStuff', startLine: 1, endLine: 3, content: 'function doStuff() {}', type: 'function' },
    ]
    const prompt = buildIncrementalPrompt('src/a.ts', sections, sections, 'Rewrite everything')
    expect(prompt).toContain('(none)')
  })
})

// ============================================================================
// determineTestStrategy
// ============================================================================
describe('determineTestStrategy', () => {
  it('returns e2e for .e2e.ts files', () => {
    expect(determineTestStrategy('tests/login.e2e.ts', '')).toBe('e2e')
  })

  it('returns e2e for files in e2e directory', () => {
    expect(determineTestStrategy('tests/e2e/auth.ts', '')).toBe('e2e')
  })

  it('returns component for .vue files', () => {
    expect(determineTestStrategy('src/App.vue', '')).toBe('component')
  })

  it('returns component for .tsx files', () => {
    expect(determineTestStrategy('src/Button.tsx', '')).toBe('component')
  })

  it('returns component for .jsx files', () => {
    expect(determineTestStrategy('src/Button.jsx', '')).toBe('component')
  })

  it('returns integration for .controller.ts files', () => {
    expect(determineTestStrategy('src/users.controller.ts', '')).toBe('integration')
  })

  it('returns integration for .routes.ts files', () => {
    expect(determineTestStrategy('src/auth.routes.ts', '')).toBe('integration')
  })

  it('returns integration for files in routes directory', () => {
    expect(determineTestStrategy('src/routes/users.ts', '')).toBe('integration')
  })

  it('returns unit as default', () => {
    expect(determineTestStrategy('src/utils/helpers.ts', '')).toBe('unit')
  })
})

// ============================================================================
// extractExports
// ============================================================================
describe('extractExports', () => {
  it('extracts exported functions', () => {
    const content = 'export function doStuff(x: number): string { return "" }'
    const exports = extractExports(content)
    expect(exports.length).toBe(1)
    expect(exports[0]!.name).toBe('doStuff')
    expect(exports[0]!.kind).toBe('function')
    expect(exports[0]!.signature).toContain('doStuff')
  })

  it('extracts exported async functions', () => {
    const content = 'export async function fetchData(url: string): Promise<void> {}'
    const exports = extractExports(content)
    expect(exports[0]!.name).toBe('fetchData')
    expect(exports[0]!.kind).toBe('function')
  })

  it('extracts exported classes', () => {
    const content = 'export class UserService {}'
    const exports = extractExports(content)
    expect(exports[0]!.kind).toBe('class')
    expect(exports[0]!.name).toBe('UserService')
  })

  it('extracts exported interfaces', () => {
    const content = 'export interface Config { name: string }'
    const exports = extractExports(content)
    expect(exports[0]!.kind).toBe('interface')
    expect(exports[0]!.name).toBe('Config')
  })

  it('extracts exported types', () => {
    const content = 'export type Result = string | number'
    const exports = extractExports(content)
    expect(exports[0]!.kind).toBe('type')
  })

  it('extracts exported consts', () => {
    const content = 'export const MAX = 100'
    const exports = extractExports(content)
    expect(exports[0]!.kind).toBe('const')
    expect(exports[0]!.name).toBe('MAX')
  })

  it('extracts exported enums as const kind', () => {
    const content = 'export enum Status { Active, Inactive }'
    const exports = extractExports(content)
    expect(exports[0]!.kind).toBe('const')
    expect(exports[0]!.name).toBe('Status')
  })

  it('extracts multiple exports', () => {
    const content = [
      'export function a() {}',
      'export class B {}',
      'export const C = 1',
    ].join('\n')
    const exports = extractExports(content)
    expect(exports.length).toBe(3)
  })

  it('returns empty for non-exported code', () => {
    const content = 'function helper() {}\nconst x = 1'
    const exports = extractExports(content)
    expect(exports).toHaveLength(0)
  })

  it('captures function signature with params', () => {
    const content = 'export function add(a: number, b: number): number { return a + b }'
    const exports = extractExports(content)
    expect(exports[0]!.signature).toContain('(a: number, b: number)')
  })
})

// ============================================================================
// buildTestPath
// ============================================================================
describe('buildTestPath', () => {
  it('converts src path to test path', () => {
    const result = buildTestPath('src/auth/service.ts')
    expect(result).toBe('src/__tests__/auth/service.test.ts')
  })

  it('uses custom test directory', () => {
    const result = buildTestPath('src/utils/helpers.ts', { testDir: 'tests' })
    expect(result).toBe('tests/utils/helpers.test.ts')
  })

  it('uses custom test pattern', () => {
    const result = buildTestPath('src/auth/service.ts', { testPattern: '*.spec.ts' })
    expect(result).toBe('src/__tests__/auth/service.spec.ts')
  })

  it('handles non-src paths', () => {
    const result = buildTestPath('lib/utils.ts')
    expect(result).toBe('src/__tests__/lib/utils.test.ts')
  })
})

// ============================================================================
// generateTestSpecs
// ============================================================================
describe('generateTestSpecs', () => {
  it('generates specs for a single target', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/utils/math.ts',
      content: 'export function add(a: number, b: number): number { return a + b }',
      exports: [{ name: 'add', kind: 'function', signature: 'add(a: number, b: number)' }],
    }]
    const specs = generateTestSpecs(targets)
    expect(specs.length).toBe(1)
    expect(specs[0]!.strategy).toBe('unit')
    expect(specs[0]!.testCases.length).toBeGreaterThan(0)
    expect(specs[0]!.prompt).toContain('add')
  })

  it('generates happy-path and error-handling cases for functions', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/utils/math.ts',
      content: 'export function add(a: number): number { return a }',
      exports: [{ name: 'add', kind: 'function' }],
    }]
    const specs = generateTestSpecs(targets)
    const cases = specs[0]!.testCases
    expect(cases.some(c => c.category === 'happy-path')).toBe(true)
    expect(cases.some(c => c.category === 'error-handling')).toBe(true)
  })

  it('generates edge-case test for optional params', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/utils/math.ts',
      content: 'export function add(a: number, b?: number): number { return a + (b ?? 0) }',
      exports: [{ name: 'add', kind: 'function', signature: 'add(a: number, b?: number)' }],
    }]
    const specs = generateTestSpecs(targets)
    const cases = specs[0]!.testCases
    expect(cases.some(c => c.category === 'edge-case')).toBe(true)
  })

  it('generates class-specific test cases', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/services/user.ts',
      content: 'export class UserService { run() {} }',
      exports: [{ name: 'UserService', kind: 'class' }],
    }]
    const specs = generateTestSpecs(targets)
    const cases = specs[0]!.testCases
    expect(cases.some(c => c.description.includes('constructed'))).toBe(true)
    expect(cases.some(c => c.description.includes('methods'))).toBe(true)
  })

  it('generates const shape test cases', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/config.ts',
      content: 'export const DEFAULT_CONFIG = { timeout: 5000 }',
      exports: [{ name: 'DEFAULT_CONFIG', kind: 'const' }],
    }]
    const specs = generateTestSpecs(targets)
    const cases = specs[0]!.testCases
    expect(cases.some(c => c.description.includes('expected shape'))).toBe(true)
  })

  it('adds integration-specific cases for controller files', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/users.controller.ts',
      content: 'export function handler() {}',
      exports: [{ name: 'handler', kind: 'function' }],
    }]
    const specs = generateTestSpecs(targets)
    const cases = specs[0]!.testCases
    expect(cases.some(c => c.category === 'integration')).toBe(true)
  })

  it('includes source code in prompt', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/utils.ts',
      content: 'export function hello(): string { return "hi" }',
      exports: [{ name: 'hello', kind: 'function' }],
    }]
    const specs = generateTestSpecs(targets)
    expect(specs[0]!.prompt).toContain('hello')
    expect(specs[0]!.prompt).toContain('```typescript')
  })

  it('includes TDD mode instruction when enabled', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/utils.ts',
      content: '',
      exports: [],
    }]
    const specs = generateTestSpecs(targets, { tddMode: true })
    expect(specs[0]!.prompt).toContain('TDD mode')
  })

  it('generates specs for multiple targets', () => {
    const targets: TestTarget[] = [
      { filePath: 'src/a.ts', content: 'export const A = 1', exports: [{ name: 'A', kind: 'const' }] },
      { filePath: 'src/b.ts', content: 'export const B = 2', exports: [{ name: 'B', kind: 'const' }] },
    ]
    const specs = generateTestSpecs(targets)
    expect(specs.length).toBe(2)
  })

  it('skips test case generation for interface exports', () => {
    const targets: TestTarget[] = [{
      filePath: 'src/types.ts',
      content: 'export interface Config { name: string }',
      exports: [{ name: 'Config', kind: 'interface' }],
    }]
    const specs = generateTestSpecs(targets)
    // interfaces/types don't produce runtime test cases
    expect(specs[0]!.testCases).toHaveLength(0)
  })
})

// ============================================================================
// parallel-sampling: sample(), selectBest(), commitBest()
// ============================================================================
describe('parallel-sampling', () => {
  describe('sample()', () => {
    it('runs N parallel samples and returns results', async () => {
      const vfs = new VirtualFS({ 'a.ts': 'const a = 1' })
      const results = await sample(vfs, 3, async (fork, idx) => {
        fork.write('a.ts', `const a = ${idx}`)
        return idx
      })
      expect(results.length).toBe(3)
      expect(results.map(r => r.result)).toEqual([0, 1, 2])
    })

    it('captures errors without crashing', async () => {
      const vfs = new VirtualFS({ 'a.ts': 'x' })
      const results = await sample(vfs, 2, async (_fork, idx) => {
        if (idx === 0) throw new Error('boom')
        return idx
      })
      expect(results[0]!.error).toBe('boom')
      expect(results[1]!.error).toBeUndefined()
      expect(results[1]!.result).toBe(1)
    })

    it('tracks duration for each sample', async () => {
      const vfs = new VirtualFS()
      const results = await sample(vfs, 1, async () => 'done')
      expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('rejects count < 1', async () => {
      const vfs = new VirtualFS()
      await expect(sample(vfs, 0, async () => 'x')).rejects.toThrow('between 1 and 10')
    })

    it('rejects count > 10', async () => {
      const vfs = new VirtualFS()
      await expect(sample(vfs, 11, async () => 'x')).rejects.toThrow('between 1 and 10')
    })

    it('provides isolated forks for each sample', async () => {
      const vfs = new VirtualFS({ 'shared.ts': 'original' })
      const results = await sample(vfs, 3, async (fork, idx) => {
        fork.write('shared.ts', `version-${idx}`)
        return fork.read('shared.ts')
      })
      // Each fork writes independently
      expect(results[0]!.result).toBe('version-0')
      expect(results[1]!.result).toBe('version-1')
      expect(results[2]!.result).toBe('version-2')
      // Original VFS unchanged
      expect(vfs.read('shared.ts')).toBe('original')
    })

    it('captures non-Error throws as strings', async () => {
      const vfs = new VirtualFS()
      const results = await sample(vfs, 1, async () => {
        throw 'string error'
      })
      expect(results[0]!.error).toBe('string error')
    })
  })

  describe('selectBest()', () => {
    it('selects the highest-scoring result', () => {
      const results = [
        { forkIndex: 0, result: 10, index: 0, durationMs: 1 },
        { forkIndex: 1, result: 30, index: 1, durationMs: 1 },
        { forkIndex: 2, result: 20, index: 2, durationMs: 1 },
      ]
      const best = selectBest(results, (r) => r)
      expect(best!.result).toBe(30)
    })

    it('returns null when all samples errored', () => {
      const results = [
        { forkIndex: 0, result: 0 as number, index: 0, durationMs: 1, error: 'fail' },
      ]
      const best = selectBest(results, (r) => r)
      expect(best).toBeNull()
    })

    it('skips errored samples', () => {
      const results = [
        { forkIndex: 0, result: 100, index: 0, durationMs: 1, error: 'fail' },
        { forkIndex: 1, result: 50, index: 1, durationMs: 1 },
      ]
      const best = selectBest(results, (r) => r)
      expect(best!.result).toBe(50)
      expect(best!.forkIndex).toBe(1)
    })

    it('handles single successful result', () => {
      const results = [
        { forkIndex: 0, result: 42, index: 0, durationMs: 1 },
      ]
      const best = selectBest(results, (r) => r)
      expect(best!.result).toBe(42)
    })
  })

  describe('commitBest()', () => {
    it('merges the winning fork back to parent', () => {
      const vfs = new VirtualFS({ 'a.ts': 'original' })
      const fork = new CopyOnWriteVFS(vfs, 'winner')
      fork.write('a.ts', 'updated')

      const winner = { forkIndex: 0, result: 'ok', index: 0, durationMs: 1 }
      commitBest(winner, [fork])
      expect(vfs.read('a.ts')).toBe('updated')
    })

    it('throws when fork index is out of range', () => {
      const winner = { forkIndex: 5, result: 'ok', index: 0, durationMs: 1 }
      expect(() => commitBest(winner, [])).toThrow('No fork found')
    })
  })
})
