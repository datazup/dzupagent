import { describe, it, expect } from 'vitest'
import { buildImportGraph } from '../../repomap/import-graph.js'

// ---------------------------------------------------------------------------
// buildImportGraph — comprehensive integration tests
// ---------------------------------------------------------------------------

describe('buildImportGraph — comprehensive', () => {
  it('creates edge from A to B when A imports from B', () => {
    const files = [
      { path: 'src/a.ts', content: `import { Helper } from './b'` },
      { path: 'src/b.ts', content: 'export class Helper {}' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.from).toContain('a.ts')
    expect(graph.edges[0]!.to).toContain('b.ts')
  })

  it('produces empty graph when no imports exist', () => {
    const files = [
      { path: 'src/a.ts', content: 'export const A = 1' },
      { path: 'src/b.ts', content: 'export const B = 2' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(0)
  })

  it('handles circular imports without error', () => {
    const files = [
      { path: 'src/x.ts', content: `import { Y } from './y'\nexport const X = 1` },
      { path: 'src/y.ts', content: `import { X } from './x'\nexport const Y = 2` },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(2)
    // Both should be importedBy each other
    const xImporters = graph.importedBy('src/x.ts')
    const yImporters = graph.importedBy('src/y.ts')
    expect(xImporters).toHaveLength(1)
    expect(yImporters).toHaveLength(1)
  })

  it('counts refCount correctly: B referenced by 3 files', () => {
    const files = [
      { path: 'src/b.ts', content: 'export const shared = 1' },
      { path: 'src/c1.ts', content: `import { shared } from './b'` },
      { path: 'src/c2.ts', content: `import { shared } from './b'` },
      { path: 'src/c3.ts', content: `import { shared } from './b'` },
    ]
    const graph = buildImportGraph(files, '/root')
    const importers = graph.importedBy('src/b.ts')
    expect(importers).toHaveLength(3)
  })

  it('produces two edges when same file imports same target twice', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import { A } from './lib'\nimport { B } from './lib'`,
      },
      { path: 'src/lib.ts', content: 'export const A = 1\nexport const B = 2' },
    ]
    const graph = buildImportGraph(files, '/root')
    // The regex produces two separate matches, so two edges
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.every((e) => e.to.includes('lib.ts'))).toBe(true)
  })

  it('resolves index.ts barrel imports', () => {
    const files = [
      { path: 'src/app.ts', content: `import { Thing } from './components'` },
      { path: 'src/components/index.ts', content: 'export class Thing {}' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.to).toContain('index.ts')
  })

  it('does not create edges for bare package imports', () => {
    const files = [
      {
        path: 'src/main.ts',
        content: `import express from 'express'\nimport { z } from 'zod'`,
      },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(0)
  })

  it('roots() returns files with zero outgoing imports', () => {
    const files = [
      { path: 'src/entry.ts', content: `import { Util } from './util'` },
      { path: 'src/util.ts', content: `import { Base } from './base'` },
      { path: 'src/base.ts', content: 'export class Base {}' },
    ]
    const graph = buildImportGraph(files, '/root')
    const roots = graph.roots()
    expect(roots).toHaveLength(1)
    expect(roots[0]).toContain('base.ts')
  })

  it('importsFrom returns targets of a file', () => {
    const files = [
      { path: 'src/a.ts', content: `import { X } from './x'\nimport { Y } from './y'` },
      { path: 'src/x.ts', content: 'export const X = 1' },
      { path: 'src/y.ts', content: 'export const Y = 2' },
    ]
    const graph = buildImportGraph(files, '/root')
    const imports = graph.importsFrom('src/a.ts')
    expect(imports).toHaveLength(2)
  })

  it('importedBy returns empty array for a file with no importers', () => {
    const files = [
      { path: 'src/lonely.ts', content: 'export const Z = 99' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.importedBy('src/lonely.ts')).toEqual([])
  })

  it('handles three-level transitive chain', () => {
    const files = [
      { path: 'src/l1.ts', content: `import { L2 } from './l2'` },
      { path: 'src/l2.ts', content: `import { L3 } from './l3'\nexport const L2 = 1` },
      { path: 'src/l3.ts', content: 'export const L3 = 1' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(2)
    // l3 is a root (no imports)
    expect(graph.roots()).toHaveLength(1)
    expect(graph.roots()[0]).toContain('l3.ts')
    // l3 is imported by l2
    expect(graph.importedBy('src/l3.ts')).toHaveLength(1)
    // l2 is imported by l1
    expect(graph.importedBy('src/l2.ts')).toHaveLength(1)
  })

  it('handles file that imports itself (self-reference)', () => {
    const files = [
      { path: 'src/self.ts', content: `import { X } from './self'\nexport const X = 1` },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.from).toBe(graph.edges[0]!.to)
  })

  it('extracts symbols list from named imports', () => {
    const files = [
      { path: 'src/main.ts', content: `import { Foo, Bar, Baz } from './lib'` },
      { path: 'src/lib.ts', content: 'export const Foo = 1\nexport const Bar = 2\nexport const Baz = 3' },
    ]
    const graph = buildImportGraph(files, '/root')
    expect(graph.edges[0]!.symbols).toEqual(['Foo', 'Bar', 'Baz'])
  })
})
