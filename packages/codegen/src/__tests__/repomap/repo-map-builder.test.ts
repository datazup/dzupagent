import { describe, it, expect } from 'vitest'
import { buildRepoMap } from '../../repomap/repo-map-builder.js'

// ---------------------------------------------------------------------------
// buildRepoMap — comprehensive integration tests
// ---------------------------------------------------------------------------

describe('buildRepoMap — comprehensive', () => {
  // --- Empty / zero-symbol cases ---

  it('returns empty map for empty file list', () => {
    const map = buildRepoMap([])
    expect(map).toEqual({ content: '', symbolCount: 0, fileCount: 0, estimatedTokens: 0 })
  })

  it('returns zero symbols for files with only comments', () => {
    const map = buildRepoMap([
      { path: 'src/a.ts', content: '// nothing here\n/* block */' },
    ])
    expect(map.symbolCount).toBe(0)
    expect(map.fileCount).toBe(0)
  })

  it('returns zero symbols for files with only imports', () => {
    const map = buildRepoMap([
      { path: 'src/re.ts', content: `import { x } from './x'` },
    ])
    expect(map.symbolCount).toBe(0)
  })

  // --- Single file, single symbol ---

  it('single file with one exported function appears in map', () => {
    const map = buildRepoMap([
      { path: 'src/util.ts', content: 'export function slugify(s: string): string { return s }' },
    ])
    expect(map.symbolCount).toBe(1)
    expect(map.fileCount).toBe(1)
    expect(map.content).toContain('slugify')
    expect(map.content).toContain('src/util.ts')
  })

  // --- RepoMap shape ---

  it('RepoMap has correct shape: content, symbolCount, fileCount, estimatedTokens', () => {
    const map = buildRepoMap([
      { path: 'src/mod.ts', content: 'export class Mod {}' },
    ])
    expect(map).toHaveProperty('content')
    expect(map).toHaveProperty('symbolCount')
    expect(map).toHaveProperty('fileCount')
    expect(map).toHaveProperty('estimatedTokens')
    expect(typeof map.content).toBe('string')
    expect(typeof map.symbolCount).toBe('number')
    expect(typeof map.fileCount).toBe('number')
    expect(typeof map.estimatedTokens).toBe('number')
  })

  // --- Token budget enforcement ---

  it('output estimatedTokens does not exceed maxTokens', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `src/mod${i}.ts`,
      content: `export class Module${i}LongName {\n  async process${i}(data: string): Promise<void> {}\n}\nexport interface Config${i} { key${i}: string }`,
    }))
    const map = buildRepoMap(files, { maxTokens: 300 })
    expect(map.estimatedTokens).toBeLessThanOrEqual(300)
  })

  it('small budget produces fewer symbols than large budget', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/s${i}.ts`,
      content: `export class S${i} {}\nexport function f${i}() {}`,
    }))
    const small = buildRepoMap(files, { maxTokens: 100 })
    const large = buildRepoMap(files, { maxTokens: 5000 })
    expect(small.symbolCount).toBeLessThan(large.symbolCount)
  })

  it('very tiny budget (1 token) does not crash', () => {
    const map = buildRepoMap(
      [{ path: 'src/x.ts', content: 'export class X {}' }],
      { maxTokens: 1 },
    )
    expect(map.symbolCount).toBeLessThanOrEqual(1)
  })

  it('budget large enough for all symbols includes everything', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}' },
      { path: 'src/b.ts', content: 'export class B {}' },
    ]
    const map = buildRepoMap(files, { maxTokens: 100000 })
    expect(map.symbolCount).toBe(2)
    expect(map.fileCount).toBe(2)
  })

  // --- Focus files ---

  it('focus file symbols ranked higher than non-focus', () => {
    const files = [
      { path: 'src/background.ts', content: 'export class Background {}' },
      { path: 'src/focus.ts', content: 'export class Focus {}' },
    ]
    const map = buildRepoMap(files, { focusFiles: ['src/focus.ts'] })
    const focusIdx = map.content.indexOf('Focus')
    const bgIdx = map.content.indexOf('Background')
    expect(focusIdx).not.toBe(-1)
    // Focus gets +5 bonus, should appear before or at same position
    if (bgIdx !== -1) {
      expect(focusIdx).toBeLessThan(bgIdx)
    }
  })

  it('focus on multiple files boosts all of them', () => {
    const files = [
      { path: 'src/nonfocus.ts', content: 'export class NonFocus {}' },
      { path: 'src/f1.ts', content: 'export class F1 {}' },
      { path: 'src/f2.ts', content: 'export class F2 {}' },
    ]
    const map = buildRepoMap(files, {
      focusFiles: ['src/f1.ts', 'src/f2.ts'],
      maxTokens: 100000,
    })
    expect(map.content).toContain('F1')
    expect(map.content).toContain('F2')
    // Both focus files should appear before nonfocus
    const f1Idx = map.content.indexOf('f1.ts')
    const f2Idx = map.content.indexOf('f2.ts')
    const nfIdx = map.content.indexOf('nonfocus.ts')
    if (nfIdx !== -1) {
      expect(Math.min(f1Idx, f2Idx)).toBeLessThan(nfIdx)
    }
  })

  // --- Exclude patterns ---

  it('excluded files do not appear in map', () => {
    const files = [
      { path: 'src/app.ts', content: 'export class App {}' },
      { path: 'node_modules/lib/index.ts', content: 'export class Lib {}' },
    ]
    const map = buildRepoMap(files, { excludePatterns: ['node_modules'] })
    expect(map.content).toContain('App')
    expect(map.content).not.toContain('Lib')
    expect(map.fileCount).toBe(1)
  })

  it('multiple exclude patterns filter correctly', () => {
    const files = [
      { path: 'src/main.ts', content: 'export class Main {}' },
      { path: 'test/main.test.ts', content: 'export function test1() {}' },
      { path: '.cache/tmp.ts', content: 'export const TMP = 1' },
    ]
    const map = buildRepoMap(files, { excludePatterns: ['test/', '.cache/'] })
    expect(map.content).toContain('Main')
    expect(map.content).not.toContain('test1')
    expect(map.content).not.toContain('TMP')
    expect(map.fileCount).toBe(1)
  })

  it('exclude pattern as substring match works', () => {
    const files = [
      { path: 'src/generated/schema.ts', content: 'export class Schema {}' },
      { path: 'src/manual/handler.ts', content: 'export class Handler {}' },
    ]
    const map = buildRepoMap(files, { excludePatterns: ['generated'] })
    expect(map.content).not.toContain('Schema')
    expect(map.content).toContain('Handler')
  })

  // --- Ranking: kind weights ---

  it('classes ranked above functions above types', () => {
    // All in one file, same export status, no references
    const content = `export type MyType = string
export function myFunc(): void {}
export class MyClass {}`
    const map = buildRepoMap([{ path: 'src/all.ts', content }])

    const classLine = map.content.indexOf('MyClass')
    const funcLine = map.content.indexOf('myFunc')
    const typeLine = map.content.indexOf('MyType')

    expect(classLine).not.toBe(-1)
    expect(funcLine).not.toBe(-1)
    expect(typeLine).not.toBe(-1)
    // class (weight 3 + 3 export = 6) > function (2+3=5) > type (1+3=4)
    expect(classLine).toBeLessThan(funcLine)
    expect(funcLine).toBeLessThan(typeLine)
  })

  it('interfaces rank same as classes (both weight 3)', () => {
    const content = `export interface IFace {}
export class CClass {}`
    const map = buildRepoMap([{ path: 'src/eq.ts', content }])
    // Both should appear; scores are equal (3+3=6 each)
    expect(map.content).toContain('IFace')
    expect(map.content).toContain('CClass')
  })

  it('exported symbols rank above non-exported of same kind', () => {
    const content = `class Hidden {}
export class Visible {}`
    const map = buildRepoMap([{ path: 'src/vis.ts', content }])
    const visIdx = map.content.indexOf('Visible')
    const hidIdx = map.content.indexOf('Hidden')
    expect(visIdx).not.toBe(-1)
    if (hidIdx !== -1) {
      expect(visIdx).toBeLessThan(hidIdx)
    }
  })

  // --- Cross-file references boost ---

  it('referenced symbols score higher due to import count', () => {
    const files = [
      { path: 'src/core.ts', content: 'export class Core {}' },
      { path: 'src/a.ts', content: `import { Core } from './core'\nexport class A {}` },
      { path: 'src/b.ts', content: `import { Core } from './core'\nexport class B {}` },
      { path: 'src/c.ts', content: `import { Core } from './core'\nexport class C {}` },
      { path: 'src/d.ts', content: `import { Core } from './core'\nexport class D {}` },
      { path: 'src/leaf.ts', content: 'export class Leaf {}' },
    ]
    const map = buildRepoMap(files, { maxTokens: 100000 })
    // core.ts symbols get +4 reference bonus (imported by 4 files)
    // Core (3 kind + 3 export + 4 refs = 10) should rank above Leaf (3+3+0=6)
    const coreIdx = map.content.indexOf('Core')
    const leafIdx = map.content.indexOf('Leaf')
    expect(coreIdx).not.toBe(-1)
    expect(leafIdx).not.toBe(-1)
    expect(coreIdx).toBeLessThan(leafIdx)
  })

  // --- Markdown output structure ---

  it('output contains file headings as ## sections', () => {
    const map = buildRepoMap([
      { path: 'src/one.ts', content: 'export class One {}' },
      { path: 'src/two.ts', content: 'export class Two {}' },
    ])
    expect(map.content).toMatch(/^## src\/one\.ts$/m)
    expect(map.content).toMatch(/^## src\/two\.ts$/m)
  })

  it('exported symbols prefixed with "export" in output lines', () => {
    const map = buildRepoMap([
      { path: 'src/m.ts', content: 'export class Pub {}' },
    ])
    expect(map.content).toMatch(/^- export class Pub$/m)
  })

  it('non-exported symbols NOT prefixed with export in output', () => {
    const map = buildRepoMap([
      { path: 'src/m.ts', content: 'class Priv {}' },
    ])
    expect(map.content).toMatch(/^- class Priv$/m)
  })

  // --- Stable sorting ---

  it('deterministic output on repeated calls', () => {
    const files = [
      { path: 'src/a.ts', content: 'export class A {}' },
      { path: 'src/b.ts', content: 'export class B {}' },
      { path: 'src/c.ts', content: 'export class C {}' },
    ]
    const r1 = buildRepoMap(files)
    const r2 = buildRepoMap(files)
    const r3 = buildRepoMap(files)
    expect(r1.content).toBe(r2.content)
    expect(r2.content).toBe(r3.content)
  })

  // --- Default config ---

  it('uses default maxTokens of 4000 when no config provided', () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      path: `src/m${i}.ts`,
      content: `export class Mod${i}VeryLongClassName {}\nexport interface Cfg${i}VeryLongInterfaceName {}`,
    }))
    const map = buildRepoMap(files)
    expect(map.estimatedTokens).toBeLessThanOrEqual(4000)
  })

  // --- Mixed scenarios ---

  it('handles mix of files: some with symbols, some empty', () => {
    const files = [
      { path: 'src/full.ts', content: 'export class Full {}' },
      { path: 'src/empty.ts', content: '' },
      { path: 'src/comments.ts', content: '// comment\n/* block */' },
    ]
    const map = buildRepoMap(files)
    expect(map.symbolCount).toBe(1)
    expect(map.fileCount).toBe(1)
    expect(map.content).toContain('Full')
  })

  it('handles large number of files (100+) without error', () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      path: `src/pkg${i}/index.ts`,
      content: `export class Pkg${i} {}`,
    }))
    const map = buildRepoMap(files, { maxTokens: 50000 })
    expect(map.symbolCount).toBeGreaterThan(0)
    expect(map.fileCount).toBeGreaterThan(0)
  })
})
