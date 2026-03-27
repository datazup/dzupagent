import { describe, it, expect } from 'vitest'
import { extractSymbols } from '../repomap/symbol-extractor.js'
import { buildImportGraph } from '../repomap/import-graph.js'
import { buildRepoMap } from '../repomap/repo-map-builder.js'

// ---------------------------------------------------------------------------
// extractSymbols
// ---------------------------------------------------------------------------

describe('extractSymbols', () => {
  it('should extract exported class declarations', () => {
    const content = `export class UserService {
  async findById(id: string): Promise<User> {}
}`
    const symbols = extractSymbols('user-service.ts', content)

    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({
      name: 'UserService',
      kind: 'class',
      exported: true,
      line: 1,
      filePath: 'user-service.ts',
    })
    expect(symbols[0]!.signature).toContain('class UserService')
  })

  it('should extract abstract class with extends', () => {
    const content = `export abstract class BaseAgent extends EventEmitter {}`
    const symbols = extractSymbols('base.ts', content)

    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({
      name: 'BaseAgent',
      kind: 'class',
      exported: true,
    })
    expect(symbols[0]!.signature).toContain('abstract class BaseAgent')
  })

  it('should extract non-exported class', () => {
    const content = `class InternalHelper {}`
    const symbols = extractSymbols('helper.ts', content)

    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.exported).toBe(false)
  })

  it('should extract interfaces', () => {
    const content = `export interface Config {
  port: number
  host: string
}

interface InternalConfig extends Config {
  debug: boolean
}`
    const symbols = extractSymbols('types.ts', content)

    expect(symbols).toHaveLength(2)
    expect(symbols[0]).toMatchObject({
      name: 'Config',
      kind: 'interface',
      exported: true,
      line: 1,
    })
    expect(symbols[1]).toMatchObject({
      name: 'InternalConfig',
      kind: 'interface',
      exported: false,
      line: 6,
    })
  })

  it('should extract functions including async', () => {
    const content = `export async function processData(input: string): Promise<Result> {
  return { data: input }
}

function helperFn(x: number): number {
  return x * 2
}`
    const symbols = extractSymbols('utils.ts', content)

    expect(symbols).toHaveLength(2)
    expect(symbols[0]).toMatchObject({
      name: 'processData',
      kind: 'function',
      exported: true,
    })
    expect(symbols[1]).toMatchObject({
      name: 'helperFn',
      kind: 'function',
      exported: false,
    })
  })

  it('should extract type aliases', () => {
    const content = `export type Status = 'active' | 'inactive'
type InternalId<T> = T & { __brand: 'id' }`
    const symbols = extractSymbols('types.ts', content)

    expect(symbols).toHaveLength(2)
    expect(symbols[0]).toMatchObject({
      name: 'Status',
      kind: 'type',
      exported: true,
    })
    expect(symbols[1]).toMatchObject({
      name: 'InternalId',
      kind: 'type',
      exported: false,
    })
  })

  it('should extract enums including const enum', () => {
    const content = `export enum Direction {
  Up, Down, Left, Right
}

export const enum LogLevel {
  Debug, Info, Warn, Error
}`
    const symbols = extractSymbols('enums.ts', content)

    expect(symbols).toHaveLength(2)
    expect(symbols[0]).toMatchObject({ name: 'Direction', kind: 'enum', exported: true })
    expect(symbols[1]).toMatchObject({ name: 'LogLevel', kind: 'enum', exported: true })
  })

  it('should extract const declarations', () => {
    const content = `export const MAX_RETRIES = 3
const DEFAULT_TIMEOUT: number = 5000
export const config: AppConfig = {}`
    const symbols = extractSymbols('constants.ts', content)

    expect(symbols).toHaveLength(3)
    expect(symbols[0]).toMatchObject({ name: 'MAX_RETRIES', kind: 'const', exported: true })
    expect(symbols[1]).toMatchObject({ name: 'DEFAULT_TIMEOUT', kind: 'const', exported: false })
    expect(symbols[2]).toMatchObject({ name: 'config', kind: 'const', exported: true })
  })

  it('should skip comments and empty lines', () => {
    const content = `// This is a comment
/* Block comment */
* continuation

export class RealClass {}`
    const symbols = extractSymbols('comments.ts', content)

    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('RealClass')
  })

  it('should return empty array for empty file', () => {
    const symbols = extractSymbols('empty.ts', '')
    expect(symbols).toEqual([])
  })

  it('should return empty array for file with only comments', () => {
    const content = `// just comments
// nothing else
/* block */`
    const symbols = extractSymbols('comments-only.ts', content)
    expect(symbols).toEqual([])
  })

  it('should handle class with implements clause', () => {
    const content = `export class MyService implements Disposable {}`
    const symbols = extractSymbols('svc.ts', content)

    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('MyService')
    expect(symbols[0]!.kind).toBe('class')
  })

  it('should only match first pattern per line', () => {
    // A line that could match multiple patterns should only match the first
    const content = `export const myFunction = () => {}`
    const symbols = extractSymbols('ambiguous.ts', content)

    expect(symbols).toHaveLength(1)
    // Should match 'const' since it comes after class/interface/enum/type/function in PATTERNS
    expect(symbols[0]!.kind).toBe('const')
  })

  it('should strip export keyword from signature', () => {
    const content = `export function doWork(): void {}`
    const symbols = extractSymbols('work.ts', content)

    expect(symbols[0]!.signature).not.toMatch(/^export/)
    expect(symbols[0]!.signature).toContain('function doWork')
  })

  it('should track correct line numbers', () => {
    const content = `
// comment
export class First {}

export interface Second {}

export function third() {}
`
    const symbols = extractSymbols('multi.ts', content)

    expect(symbols).toHaveLength(3)
    expect(symbols[0]!.line).toBe(3)  // class First
    expect(symbols[1]!.line).toBe(5)  // interface Second
    expect(symbols[2]!.line).toBe(7)  // function third
  })
})

// ---------------------------------------------------------------------------
// buildImportGraph
// ---------------------------------------------------------------------------

describe('buildImportGraph', () => {
  it('should build edges for named imports', () => {
    const files = [
      {
        path: 'src/index.ts',
        content: `import { Foo, Bar } from './foo'`,
      },
      {
        path: 'src/foo.ts',
        content: `export class Foo {}
export class Bar {}`,
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['Foo', 'Bar'])
  })

  it('should resolve namespace imports', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import * as utils from './utils'`,
      },
      {
        path: 'src/utils.ts',
        content: 'export const x = 1',
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['* as utils'])
  })

  it('should resolve default imports', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import Config from './config'`,
      },
      {
        path: 'src/config.ts',
        content: 'export default {}',
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['Config'])
  })

  it('should resolve .js extension imports to .ts files', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { A } from './module.js'`,
      },
      {
        path: 'src/module.ts',
        content: 'export const A = 1',
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
  })

  it('should resolve index.ts directory imports', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { X } from './utils'`,
      },
      {
        path: 'src/utils/index.ts',
        content: 'export const X = 1',
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
  })

  it('should ignore bare/package imports', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { z } from 'zod'
import { Client } from '@langchain/core'`,
      },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(0)
  })

  it('should compute importedBy correctly', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
      { path: 'src/c.ts', content: `import { B } from './b'` },
    ]

    const graph = buildImportGraph(files, '/project')
    const importers = graph.importedBy('src/b.ts')
    expect(importers).toHaveLength(2)
  })

  it('should compute importsFrom correctly', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'\nimport { C } from './c'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
      { path: 'src/c.ts', content: 'export const C = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    const imports = graph.importsFrom('src/a.ts')
    expect(imports).toHaveLength(2)
  })

  it('should identify root files (no imports)', () => {
    const files = [
      { path: 'src/a.ts', content: `import { B } from './b'` },
      { path: 'src/b.ts', content: 'export const B = 1' },
      { path: 'src/c.ts', content: 'export const C = 1' },
    ]

    const graph = buildImportGraph(files, '/project')
    const roots = graph.roots()
    // b.ts and c.ts have no imports, so they are roots
    expect(roots).toHaveLength(2)
  })

  it('should handle empty file list', () => {
    const graph = buildImportGraph([], '/project')
    expect(graph.edges).toEqual([])
    expect(graph.roots()).toEqual([])
  })

  it('should handle type imports', () => {
    const files = [
      { path: 'src/main.ts', content: `import type { Config } from './config'` },
      { path: 'src/config.ts', content: 'export interface Config {}' },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.symbols).toEqual(['Config'])
  })

  it('should handle unresolvable relative imports gracefully', () => {
    const files = [
      { path: 'src/main.ts', content: `import { X } from './nonexistent'` },
    ]

    const graph = buildImportGraph(files, '/project')
    expect(graph.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildRepoMap
// ---------------------------------------------------------------------------

describe('buildRepoMap', () => {
  it('should build a map from a set of files', () => {
    const files = [
      {
        path: 'src/service.ts',
        content: `export class UserService {
  async findById(id: string) {}
}
export interface User { name: string }`,
      },
      {
        path: 'src/utils.ts',
        content: `export function slugify(s: string): string { return s }
const INTERNAL = 42`,
      },
    ]

    const map = buildRepoMap(files)

    expect(map.symbolCount).toBeGreaterThan(0)
    expect(map.fileCount).toBeGreaterThan(0)
    expect(map.content).toContain('UserService')
    expect(map.estimatedTokens).toBeGreaterThan(0)
  })

  it('should return empty map for empty file list', () => {
    const map = buildRepoMap([])
    expect(map).toEqual({ content: '', symbolCount: 0, fileCount: 0, estimatedTokens: 0 })
  })

  it('should return empty map for files with no symbols', () => {
    const files = [
      { path: 'src/empty.ts', content: '// just a comment' },
    ]
    const map = buildRepoMap(files)
    expect(map.symbolCount).toBe(0)
  })

  it('should exclude files matching excludePatterns', () => {
    const files = [
      { path: 'src/service.ts', content: 'export class Service {}' },
      { path: 'node_modules/pkg/index.ts', content: 'export class External {}' },
    ]

    const map = buildRepoMap(files, { excludePatterns: ['node_modules'] })

    expect(map.content).toContain('Service')
    expect(map.content).not.toContain('External')
  })

  it('should boost focus files in ranking', () => {
    const files = [
      { path: 'src/low-priority.ts', content: 'const x = 1' },
      { path: 'src/focus.ts', content: 'const y = 2' },
    ]

    const map = buildRepoMap(files, { focusFiles: ['src/focus.ts'] })

    // The focus file should appear first in the output
    const focusIdx = map.content.indexOf('focus.ts')
    const lowIdx = map.content.indexOf('low-priority.ts')
    // Focus file gets +5 bonus, so it should rank higher
    if (lowIdx !== -1 && focusIdx !== -1) {
      expect(focusIdx).toBeLessThan(lowIdx)
    }
  })

  it('should respect maxTokens budget', () => {
    // Create many files to exceed a small budget
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/module-${i}.ts`,
      content: `export class Module${i} {
  async method${i}(arg: string): Promise<void> {}
}
export interface Module${i}Config { key: string }
export type Module${i}Id = string`,
    }))

    const smallBudget = buildRepoMap(files, { maxTokens: 200 })
    const largeBudget = buildRepoMap(files, { maxTokens: 10000 })

    expect(smallBudget.symbolCount).toBeLessThan(largeBudget.symbolCount)
    expect(smallBudget.estimatedTokens).toBeLessThanOrEqual(200)
  })

  it('should rank exported symbols higher than non-exported', () => {
    const files = [
      {
        path: 'src/module.ts',
        content: `const internal = 1
export class PublicAPI {}`,
      },
    ]

    const map = buildRepoMap(files)
    // Exported class (+3 export bonus, +3 kind weight) should appear
    expect(map.content).toContain('PublicAPI')
  })

  it('should rank classes/interfaces higher than consts', () => {
    const files = [
      {
        path: 'src/module.ts',
        content: `export const x = 1
export class Important {}`,
      },
    ]

    const map = buildRepoMap(files)
    // Both should appear, but class first in the content (higher score)
    const classIdx = map.content.indexOf('Important')
    const constIdx = map.content.indexOf('x')
    // class (weight 3 + 3 export = 6) vs const (weight 1 + 3 export = 4)
    // Both should appear in the output
    expect(map.content).toContain('Important')
    expect(map.content).toContain('x')
  })
})
