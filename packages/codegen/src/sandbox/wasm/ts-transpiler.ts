/**
 * TypeScript transpiler for the WASM sandbox.
 *
 * Attempts to use `esbuild-wasm` for high-fidelity transpilation.
 * Falls back to a best-effort regex-based type-stripping approach
 * when no transpiler is available.
 */

export interface TranspileResult {
  /** Transpiled JavaScript code. */
  code: string
  /** Source map (if available). */
  sourceMap?: string
  /** Diagnostic messages (warnings, errors). */
  diagnostics: string[]
}

/**
 * Attempt a dynamic import of an optional module.
 * Uses Function constructor to prevent TypeScript from resolving the module
 * at compile time. Returns `undefined` if the module is not installed.
 */
async function tryImport(moduleName: string): Promise<unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>
    return await dynamicImport(moduleName)
  } catch {
    return undefined
  }
}

/** Minimal type-safe interface for the subset of esbuild API we use. */
interface EsbuildTransformResult {
  code: string
  map: string
  warnings: Array<{
    text: string
    location: { file: string; line: number } | null
  }>
}

interface EsbuildModule {
  initialize(opts: Record<string, unknown>): Promise<void>
  transform(
    source: string,
    opts: Record<string, unknown>,
  ): Promise<EsbuildTransformResult>
}

export class WasmTypeScriptTranspiler {
  /**
   * Transpile TypeScript source to JavaScript.
   *
   * Strategy:
   * 1. Try `esbuild-wasm` (high fidelity)
   * 2. Fall back to `stripTypes()` (regex-based, best effort)
   */
  async transpile(
    source: string,
    options?: { filename?: string; target?: string },
  ): Promise<TranspileResult> {
    // Attempt esbuild-wasm first
    const mod = await tryImport('esbuild-wasm')
    if (mod) {
      try {
        const esbuild = mod as EsbuildModule

        // Initialize if needed (idempotent in newer versions)
        try {
          await esbuild.initialize({ wasmURL: undefined })
        } catch {
          // Already initialized — ignore
        }

        const result = await esbuild.transform(source, {
          loader: 'ts',
          target: options?.target ?? 'es2022',
          sourcefile: options?.filename ?? 'input.ts',
          sourcemap: true,
          format: 'esm',
        })

        return {
          code: result.code,
          sourceMap: result.map || undefined,
          diagnostics: result.warnings.map(
            (w) => `${w.text} (${w.location?.file ?? ''}:${w.location?.line ?? 0})`,
          ),
        }
      } catch {
        // esbuild-wasm initialization or transform failed — fall through
      }
    }

    const code = this.stripTypes(source)
    return {
      code,
      diagnostics: [
        'esbuild-wasm not available — used regex-based type stripping (not production-grade)',
      ],
    }
  }

  /** Check if a proper transpiler (esbuild-wasm) is available. */
  async isAvailable(): Promise<boolean> {
    const mod = await tryImport('esbuild-wasm')
    return mod !== undefined
  }

  /**
   * Best-effort regex-based type stripping.
   *
   * Handles common TypeScript patterns:
   * - `interface` and `type` declarations (top-level only)
   * - Parameter type annotations (`: Type`)
   * - Return type annotations
   * - Generic brackets (`<Type>`) in declarations
   * - `as` casts
   * - Access modifiers (`public`, `private`, `protected`, `readonly`)
   * - `declare` statements
   * - `enum` declarations
   * - Non-null assertions (`!.`)
   *
   * This is NOT a production-grade transpiler. It will break on:
   * - Complex generic expressions with nested brackets
   * - String literals containing type-like syntax
   * - Decorators
   * - Namespace declarations
   */
  stripTypes(source: string): string {
    let result = source

    // Remove `declare` statements (entire line)
    result = result.replace(/^declare\s+.*$/gm, '')

    // Remove standalone `interface` blocks
    result = removeBlockDeclaration(result, 'interface')

    // Remove standalone `type` alias declarations
    result = removeTypeAliases(result)

    // Remove `enum` blocks
    result = removeBlockDeclaration(result, 'enum')

    // Remove generic type parameters from function/class declarations
    // e.g., function foo<T extends Bar>(x: T) -> function foo(x)
    result = result.replace(
      /(function\s+\w+|class\s+\w+)\s*<[^>]*>/g,
      '$1',
    )

    // Remove `implements` clauses
    result = result.replace(/\s+implements\s+[\w.,\s<>]+(?=\s*\{)/g, '')

    // Remove `extends` with generic args on classes (keep simple extends)
    // e.g., class Foo extends Bar<Baz> -> class Foo extends Bar
    result = result.replace(/(extends\s+\w+)<[^>]*>/g, '$1')

    // Remove access modifiers on class members/constructor params
    result = result.replace(
      /\b(public|private|protected|readonly)\s+/g,
      '',
    )

    // Remove `as Type` casts (simple cases)
    result = result.replace(/\s+as\s+\w[\w.<>,\s|&\[\]]*(?=[;,)\]\s}])/g, '')

    // Remove parameter type annotations: (name: Type) -> (name)
    result = result.replace(
      /(\w+)\s*\??\s*:\s*[\w<>\[\]|&.,\s'"{}()=>]+(?=[,)\]])/g,
      (_match, name: string) => name,
    )

    // Remove return type annotations: ): Type { -> ) {
    result = result.replace(
      /\)\s*:\s*[\w<>\[\]|&.,\s'"{}()=>]+(?=\s*\{)/g,
      ')',
    )

    // Remove return type annotations for arrow functions: ): Type => -> ) =>
    result = result.replace(
      /\)\s*:\s*[\w<>\[\]|&.,\s'"{}()=>]+(?=\s*=>)/g,
      ')',
    )

    // Remove non-null assertions: foo!.bar -> foo.bar
    result = result.replace(/(\w+)!\./g, '$1.')

    // Remove import type statements
    result = result.replace(/^import\s+type\s+.*$/gm, '')

    // Remove `type` keyword from import { type Foo } -> import { Foo }
    // but also handles `import { type Foo, Bar }` -> `import { Foo, Bar }`
    result = result.replace(
      /\bimport\s*\{([^}]*)\}/g,
      (_match, inner: string) => {
        const cleaned = inner.replace(/\btype\s+/g, '')
        return `import {${cleaned}}`
      },
    )

    // Remove `export type` declarations that weren't caught above
    result = result.replace(/^export\s+type\s+\w+\s*=\s*[^;]+;?\s*$/gm, '')
    result = result.replace(/^export\s+interface\s+\w+[^{]*\{[^}]*\}\s*$/gm, '')

    // Clean up empty lines (collapse multiple blank lines to one)
    result = result.replace(/\n{3,}/g, '\n\n')

    return result.trim() + '\n'
  }
}

// ---------------------------------------------------------------------------
// Helpers for removing block declarations
// ---------------------------------------------------------------------------

/** Remove top-level block declarations like `interface Foo { ... }` or `enum Bar { ... }`. */
function removeBlockDeclaration(source: string, keyword: string): string {
  // Match `[export] keyword Name [<...>] [extends ...] { ... }`
  const pattern = new RegExp(
    `(?:^|\\n)(?:export\\s+)?${keyword}\\s+\\w+[^{]*\\{`,
    'g',
  )

  let result = source
  let match: RegExpExecArray | null

  // Process from end to start to preserve indices
  const matches: Array<{ index: number; length: number }> = []

  while ((match = pattern.exec(result)) !== null) {
    const startIdx = match.index
    const braceStart = startIdx + match[0].indexOf('{')
    const endIdx = findMatchingBrace(result, braceStart)
    if (endIdx !== -1) {
      matches.push({ index: startIdx, length: endIdx - startIdx + 1 })
    }
  }

  // Remove matches from end to start
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!
    result = result.slice(0, m.index) + result.slice(m.index + m.length)
  }

  return result
}

/** Remove `type Alias = ...;` declarations. */
function removeTypeAliases(source: string): string {
  // Handles single-line type aliases: type Foo = string | number;
  let result = source.replace(
    /(?:^|\n)(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=[^;{]*;/g,
    '',
  )

  // Handles multi-line type aliases with object types: type Foo = { ... };
  const pattern = /(?:^|\n)(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=\s*\{/g
  let match: RegExpExecArray | null

  const matches: Array<{ index: number; length: number }> = []
  while ((match = pattern.exec(result)) !== null) {
    const startIdx = match.index
    const braceStart = startIdx + match[0].indexOf('{')
    const endIdx = findMatchingBrace(result, braceStart)
    if (endIdx !== -1) {
      // Include trailing semicolon if present
      const afterBrace = endIdx + 1
      const trailingSemicolon =
        afterBrace < result.length && result[afterBrace] === ';' ? 1 : 0
      matches.push({
        index: startIdx,
        length: endIdx - startIdx + 1 + trailingSemicolon,
      })
    }
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!
    result = result.slice(0, m.index) + result.slice(m.index + m.length)
  }

  return result
}

/** Find the matching closing brace for an opening brace at `index`. */
function findMatchingBrace(source: string, index: number): number {
  if (source[index] !== '{') return -1

  let depth = 1
  for (let i = index + 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
