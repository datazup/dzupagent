import { describe, it, expect } from 'vitest'
import { buildImportGraph, type ImportEdge } from '../repomap/import-graph.js'
import { extractSymbols } from '../repomap/symbol-extractor.js'
import { buildRepoMap } from '../repomap/repo-map-builder.js'

// ---------------------------------------------------------------------------
// buildImportGraph — extended coverage
// ---------------------------------------------------------------------------

describe('buildImportGraph — extended', () => {
  it('should handle multiple imports from the same file', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { A } from './utils'
import { B } from './utils'`,
      },
      { path: 'src/utils.ts', content: 'export const A = 1\nexport const B = 2' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.every((e) => e.to.includes('utils.ts'))).toBe(true)
  })

  it('should handle circular imports', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: `import { A } from './a'` },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(2)
    expect(graph.importedBy('src/a.ts')).toHaveLength(1)
    expect(graph.importedBy('src/b.ts')).toHaveLength(1)
  })

  it('should return empty importedBy for file with no importers', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.importedBy('src/a.ts')).toEqual([])
  })

  it('should return empty importsFrom for file with no imports', () => {
    const files = [
      { path: 'src/leaf.ts', content: 'export const X = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.importsFrom('src/leaf.ts')).toEqual([])
  })

  it('should handle .mjs extension resolution', () => {
    const files = [
      { path: 'src/main.ts', content: `import { X } from './lib.mjs'` },
      { path: 'src/lib.ts', content: 'export const X = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
  })

  it('should handle deeply nested relative imports', () => {
    const files = [
      { path: 'src/deep/nested/file.ts', content: `import { X } from '../../utils'` },
      { path: 'src/utils.ts', content: 'export const X = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
  })

  it('should extract multiple named symbols from a single import', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { Alpha, Beta, Gamma } from './types'`,
      },
      {
        path: 'src/types.ts',
        content: 'export type Alpha = string\nexport type Beta = number\nexport type Gamma = boolean',
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('should handle mixed import styles in a single file', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import Default from './mod-a'
import { Named } from './mod-b'
import * as All from './mod-c'
import type { TypeOnly } from './mod-d'`,
      },
      { path: 'src/mod-a.ts', content: 'export default 1' },
      { path: 'src/mod-b.ts', content: 'export const Named = 1' },
      { path: 'src/mod-c.ts', content: 'export const x = 1' },
      { path: 'src/mod-d.ts', content: 'export interface TypeOnly {}' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(4)

    const symbols = graph.edges.map((e) => e.symbols).flat()
    expect(symbols).toContain('Default')
    expect(symbols).toContain('Named')
    expect(symbols).toContain('* as All')
    expect(symbols).toContain('TypeOnly')
  })

  it('roots should include files that have no outgoing imports', () => {
    const files = [
      { path: 'src/index.ts', content: `import { A } from './a'\nimport { B } from './b'` },
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    const roots = graph.roots()
    // b.ts has no imports, so it is a root
    expect(roots).toHaveLength(1)
    expect(roots[0]).toContain('b.ts')
  })

  it('should handle single-file project', () => {
    const files = [
      { path: 'src/app.ts', content: 'export function main() {}' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(0)
    expect(graph.roots()).toHaveLength(1)
    expect(graph.importedBy('src/app.ts')).toEqual([])
    expect(graph.importsFrom('src/app.ts')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// extractSymbols — extended edge cases
// ---------------------------------------------------------------------------

describe('extractSymbols — extended', () => {
  it('should handle class with both extends and implements', () => {
    const content = `export class MyService extends BaseService implements Disposable {}`
    const symbols = extractSymbols('svc.ts', content)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.kind).toBe('class')
    expect(symbols[0]!.name).toBe('MyService')
  })

  it('should handle interface with multiple extends', () => {
    const content = `export interface Combined extends A, B, C {}`
    const symbols = extractSymbols('combined.ts', content)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.kind).toBe('interface')
  })

  it('should handle generic function signatures', () => {
    const content = `export function transform<T, U>(input: T): U {}`
    const symbols = extractSymbols('transform.ts', content)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.kind).toBe('function')
    expect(symbols[0]!.name).toBe('transform')
  })

  it('should handle generic type alias', () => {
    const content = `export type Result<T> = { data: T; error: null } | { data: null; error: Error }`
    const symbols = extractSymbols('result.ts', content)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.kind).toBe('type')
    expect(symbols[0]!.name).toBe('Result')
  })

  it('should handle const with complex type annotation', () => {
    const content = `export const handlers: Record<string, (req: Request) => Response> = {}`
    const symbols = extractSymbols('handlers.ts', content)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.kind).toBe('const')
    expect(symbols[0]!.name).toBe('handlers')
  })

  it('should handle multiple symbols in one file preserving order', () => {
    const content = `export interface Config {}
export class Service {}
export function init() {}
export type ID = string
export const VERSION = '1.0'
export enum Status { Active, Inactive }`
    const symbols = extractSymbols('all.ts', content)
    expect(symbols).toHaveLength(6)
    expect(symbols.map((s) => s.kind)).toEqual([
      'interface', 'class', 'function', 'type', 'const', 'enum',
    ])
  })

  it('should handle indented code (e.g., inside namespace blocks)', () => {
    const content = `  export class IndentedClass {}`
    const symbols = extractSymbols('indented.ts', content)
    // trimStart is applied, so indented lines should still match
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('IndentedClass')
  })

  it('should handle file with no exportable symbols (only imports)', () => {
    const content = `import { Something } from './something'
// just re-export
`
    const symbols = extractSymbols('reexport.ts', content)
    expect(symbols).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildRepoMap — extended
// ---------------------------------------------------------------------------

describe('buildRepoMap — extended', () => {
  it('should include files referenced by other files higher in ranking', () => {
    const files = [
      {
        path: 'src/types.ts',
        content: `export interface User { name: string }
export interface Order { id: number }`,
      },
      {
        path: 'src/service-a.ts',
        content: `import { User } from './types'
export class ServiceA {}`,
      },
      {
        path: 'src/service-b.ts',
        content: `import { User, Order } from './types'
export class ServiceB {}`,
      },
    ]

    const map = buildRepoMap(files)
    // types.ts is imported by 2 files, so its symbols get a reference bonus
    expect(map.content).toContain('User')
    expect(map.content).toContain('Order')
  })

  it('should handle files with only non-exported symbols', () => {
    const files = [
      { path: 'src/internal.ts', content: 'const secret = 42\nfunction helper() {}' },
    ]

    const map = buildRepoMap(files)
    // Non-exported symbols should still be included (lower priority)
    expect(map.symbolCount).toBeGreaterThan(0)
  })

  it('should handle multiple exclude patterns', () => {
    const files = [
      { path: 'src/app.ts', content: 'export class App {}' },
      { path: 'test/app.test.ts', content: 'export function testApp() {}' },
      { path: 'dist/app.js', content: 'export class App {}' },
    ]

    const map = buildRepoMap(files, { excludePatterns: ['test/', 'dist/'] })
    expect(map.content).toContain('App')
    expect(map.fileCount).toBe(1)
  })

  it('should produce valid markdown output structure', () => {
    const files = [
      { path: 'src/mod.ts', content: 'export class Module {}\nexport function init() {}' },
    ]

    const map = buildRepoMap(files)
    // Should contain a heading for the file
    expect(map.content).toMatch(/^## /)
    // Should contain dash-prefixed symbol lines
    expect(map.content).toMatch(/^- /m)
  })

  it('should handle very small token budget gracefully', () => {
    const files = [
      { path: 'src/big.ts', content: 'export class VeryLargeClassName {}' },
    ]

    // Budget of 1 token is essentially nothing
    const map = buildRepoMap(files, { maxTokens: 1 })
    // Should produce empty or minimal output without crashing
    expect(map.symbolCount).toBeLessThanOrEqual(1)
  })

  it('should sort symbols stably when scores are equal', () => {
    const files = [
      {
        path: 'src/a.ts',
        content: 'export class A {}',
      },
      {
        path: 'src/b.ts',
        content: 'export class B {}',
      },
    ]

    const map1 = buildRepoMap(files)
    const map2 = buildRepoMap(files)
    expect(map1.content).toBe(map2.content)
  })

  it('should include estimated token count', () => {
    const files = [
      { path: 'src/mod.ts', content: 'export class Foo {}' },
    ]

    const map = buildRepoMap(files)
    expect(map.estimatedTokens).toBeGreaterThan(0)
    // Token estimate is chars / 4, so it should be reasonable
    expect(map.estimatedTokens).toBeLessThanOrEqual(map.content.length)
  })
})
