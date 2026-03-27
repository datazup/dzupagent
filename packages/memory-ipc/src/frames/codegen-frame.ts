/**
 * Arrow schema and builder for code generation pipeline frames.
 *
 * Captures generated file metadata including LOC, import/export counts,
 * test status, lint errors, and complexity scores for pipeline analytics.
 */

import {
  Schema,
  Field,
  Utf8,
  Float64,
  Int32,
  Int64,
  Bool,
  Dictionary,
  type Table,
  tableFromArrays,
} from 'apache-arrow'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Arrow schema for codegen pipeline frames. */
export const CODEGEN_FRAME_SCHEMA = new Schema([
  new Field('file_path', new Utf8(), false),
  new Field('language', new Dictionary(new Utf8(), new Int32()), false),
  new Field('content_hash', new Utf8(), false),
  new Field('loc', new Int32(), false),
  new Field('import_count', new Int32(), false),
  new Field('export_count', new Int32(), false),
  new Field('export_symbols', new Utf8(), true),
  new Field('has_tests', new Bool(), false),
  new Field('test_pass', new Bool(), true),
  new Field('lint_errors', new Int32(), true),
  new Field('complexity_score', new Float64(), true),
  new Field('token_cost', new Int32(), false),
  new Field('generated_by', new Dictionary(new Utf8(), new Int32()), true),
  new Field('generated_at', new Int64(), false),
])

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A single generated file entry. */
export interface CodegenFileEntry {
  path: string
  content: string
  language: string
  exports?: string[]
  imports?: string[]
  generatedBy?: string
  hasTests?: boolean
  testPass?: boolean
  lintErrors?: number
  complexityScore?: number
}

// ---------------------------------------------------------------------------
// FNV-1a hash
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Compute FNV-1a hash of a string, returned as an 8-char hex string.
 */
function fnv1a(input: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * FNV_PRIME) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Token cost estimation
// ---------------------------------------------------------------------------

const DEFAULT_CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds Arrow tables from generated file metadata.
 *
 * LOC is computed from content line count. Content hash uses FNV-1a.
 * Import/export counts are derived from the provided arrays.
 */
export class CodegenFrameBuilder {
  /**
   * Build a Table from an array of generated files.
   */
  static fromGeneratedFiles(
    files: ReadonlyArray<CodegenFileEntry>,
    charsPerToken?: number,
  ): Table {
    const cpt = charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
    const now = BigInt(Date.now())

    const file_path: string[] = []
    const language: string[] = []
    const content_hash: string[] = []
    const loc: number[] = []
    const import_count: number[] = []
    const export_count: number[] = []
    const export_symbols: (string | null)[] = []
    const has_tests: boolean[] = []
    const test_pass: (boolean | null)[] = []
    const lint_errors: (number | null)[] = []
    const complexity_score: (number | null)[] = []
    const token_cost: number[] = []
    const generated_by: (string | null)[] = []
    const generated_at: bigint[] = []

    for (const f of files) {
      file_path.push(f.path)
      language.push(f.language)
      content_hash.push(fnv1a(f.content))
      loc.push(f.content.split('\n').length)
      import_count.push(f.imports?.length ?? 0)
      export_count.push(f.exports?.length ?? 0)
      export_symbols.push(f.exports ? JSON.stringify(f.exports) : null)
      has_tests.push(f.hasTests ?? false)
      test_pass.push(f.testPass ?? null)
      lint_errors.push(f.lintErrors ?? null)
      complexity_score.push(f.complexityScore ?? null)
      token_cost.push(Math.ceil(f.content.length / cpt))
      generated_by.push(f.generatedBy ?? null)
      generated_at.push(now)
    }

    return tableFromArrays({
      file_path,
      language,
      content_hash,
      loc,
      import_count,
      export_count,
      export_symbols,
      has_tests,
      test_pass,
      lint_errors,
      complexity_score,
      token_cost,
      generated_by,
      generated_at,
    })
  }
}

// Export fnv1a for testing
export { fnv1a as _fnv1aForTesting }
