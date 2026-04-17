import { describe, it, expect } from 'vitest'
import { extractSymbols } from '../../repomap/symbol-extractor.js'

// ---------------------------------------------------------------------------
// extractSymbols — comprehensive integration tests
// ---------------------------------------------------------------------------

describe('extractSymbols — comprehensive', () => {
  // --- Kind detection ---

  it('extracts exported function with return type', () => {
    const symbols = extractSymbols('f.ts', 'export function parse(input: string): AST {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({
      name: 'parse',
      kind: 'function',
      exported: true,
      line: 1,
      filePath: 'f.ts',
    })
  })

  it('extracts non-exported function', () => {
    const symbols = extractSymbols('f.ts', 'function internal(): void {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.exported).toBe(false)
    expect(symbols[0]!.kind).toBe('function')
  })

  it('extracts exported class', () => {
    const symbols = extractSymbols('c.ts', 'export class Router {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Router', kind: 'class', exported: true })
  })

  it('extracts exported interface', () => {
    const symbols = extractSymbols('i.ts', 'export interface Logger { log(msg: string): void }')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Logger', kind: 'interface', exported: true })
  })

  it('extracts exported enum', () => {
    const symbols = extractSymbols('e.ts', 'export enum Color { Red, Green, Blue }')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Color', kind: 'enum', exported: true })
  })

  it('extracts exported type alias with equals sign', () => {
    const symbols = extractSymbols('t.ts', 'export type ID = string & { __brand: "id" }')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'ID', kind: 'type', exported: true })
  })

  it('extracts exported type alias with angle bracket', () => {
    const symbols = extractSymbols('t.ts', 'export type Nullable<T> = T | null')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Nullable', kind: 'type', exported: true })
  })

  it('extracts exported const', () => {
    const symbols = extractSymbols('c.ts', 'export const API_KEY = "abc123"')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'API_KEY', kind: 'const', exported: true })
  })

  // --- Non-exported symbols ---

  it('does NOT mark non-exported symbols as exported', () => {
    const content = `class Hidden {}
interface Secret {}
function helper() {}
type Internal = string
enum Private { A }
const local = 1`
    const symbols = extractSymbols('priv.ts', content)
    expect(symbols).toHaveLength(6)
    for (const s of symbols) {
      expect(s.exported).toBe(false)
    }
  })

  // --- Empty / degenerate inputs ---

  it('returns empty for empty string', () => {
    expect(extractSymbols('e.ts', '')).toEqual([])
  })

  it('returns empty for file with only imports', () => {
    const content = `import { foo } from './foo'
import * as bar from 'bar'
import type { Baz } from './baz'`
    expect(extractSymbols('imports.ts', content)).toEqual([])
  })

  it('returns empty for file with only blank lines and whitespace', () => {
    expect(extractSymbols('blank.ts', '   \n\n  \n')).toEqual([])
  })

  // --- Generics ---

  it('handles generic class declarations', () => {
    const symbols = extractSymbols('g.ts', 'export class Repository<T extends Entity> {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('Repository')
    expect(symbols[0]!.kind).toBe('class')
  })

  it('handles generic interface with multiple type params', () => {
    const symbols = extractSymbols('g.ts', 'export interface Mapper<TIn, TOut> {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('Mapper')
    expect(symbols[0]!.kind).toBe('interface')
  })

  it('handles generic function with constraints', () => {
    const symbols = extractSymbols('g.ts', 'export function merge<T extends object>(a: T, b: Partial<T>): T {}')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]!.name).toBe('merge')
  })

  // --- Line number accuracy ---

  it('returns correct line numbers for symbols separated by blank lines', () => {
    const content = `

export class A {}


export class B {}

export class C {}`
    const symbols = extractSymbols('lines.ts', content)
    expect(symbols).toHaveLength(3)
    expect(symbols[0]!.line).toBe(3)
    expect(symbols[1]!.line).toBe(6)
    expect(symbols[2]!.line).toBe(8)
  })

  // --- Signature correctness ---

  it('signature does not include export keyword', () => {
    const symbols = extractSymbols('s.ts', 'export class Foo {}')
    expect(symbols[0]!.signature).toBe('class Foo')
  })

  it('signature does not include trailing brace', () => {
    const symbols = extractSymbols('s.ts', 'export function run() {')
    expect(symbols[0]!.signature).not.toContain('{')
  })

  it('preserves async in function signature', () => {
    const symbols = extractSymbols('s.ts', 'export async function fetch(): Promise<void> {')
    expect(symbols[0]!.signature).toContain('async function fetch')
  })

  // --- filePath propagation ---

  it('propagates filePath to every symbol', () => {
    const content = `export class X {}
export function y() {}
export const z = 1`
    const symbols = extractSymbols('my/deep/path.ts', content)
    for (const s of symbols) {
      expect(s.filePath).toBe('my/deep/path.ts')
    }
  })
})
