/**
 * Tree-sitter parser/grammar loading and language detection.
 *
 * Owns the lazy singleton state for the optional `web-tree-sitter`
 * runtime and the grammar WASM files.
 */

import * as path from 'node:path'
import { WASM_GRAMMAR_NAMES } from './tree-sitter-extractor-grammars.js'
import {
  EXTENSION_MAP,
  type SupportedLanguage,
  type TSLanguage,
  type TreeSitterModule,
} from './tree-sitter-extractor-types.js'

// -----------------------------------------------------------------------
// Internal singleton state
// -----------------------------------------------------------------------

/** Cache for loaded languages */
const languageCache = new Map<SupportedLanguage, TSLanguage>()

/** Whether web-tree-sitter has been initialized */
let initialized = false

/** Cached parser constructor (or null if unavailable) */
let ParserCtor: TreeSitterModule['default'] | null = null

// -----------------------------------------------------------------------
// Parser construction
// -----------------------------------------------------------------------

/**
 * Try to initialize web-tree-sitter. Returns the Parser constructor or null.
 */
export async function getParserCtor(): Promise<TreeSitterModule['default'] | null> {
  if (ParserCtor !== null) return ParserCtor

  try {
    // Dynamic import -- web-tree-sitter is optional
    const mod = (await import('web-tree-sitter')) as unknown as TreeSitterModule
    const Parser = mod.default
    if (!initialized) {
      await Parser.init()
      initialized = true
    }
    ParserCtor = Parser
    return Parser
  } catch {
    // web-tree-sitter not installed
    return null
  }
}

/**
 * Resolve the directory of an npm package.
 */
async function resolvePackagePath(packageName: string): Promise<string> {
  // Use createRequire to resolve package.json, then extract the directory
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve(`${packageName}/package.json`)
  return path.dirname(pkgJsonPath)
}

/**
 * Load a tree-sitter language grammar (WASM).
 * Returns null if the grammar cannot be loaded.
 */
export async function loadLanguage(
  language: SupportedLanguage,
  Parser: TreeSitterModule['default'],
): Promise<TSLanguage | null> {
  const cached = languageCache.get(language)
  if (cached) return cached

  try {
    // Try to resolve the WASM file from tree-sitter-wasms package
    const wasmName = WASM_GRAMMAR_NAMES[language]
    let wasmPath: string

    try {
      // tree-sitter-wasms ships .wasm files at its package root
      const wasmsPkgPath = await resolvePackagePath('tree-sitter-wasms')
      wasmPath = path.join(wasmsPkgPath, `${wasmName}.wasm`)
    } catch {
      // Fallback: try to find the grammar in common locations
      return null
    }

    const lang = await Parser.Language.load(wasmPath)
    languageCache.set(language, lang)
    return lang
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------
// Language detection
// -----------------------------------------------------------------------

/**
 * Detect language from file extension.
 * Returns undefined for unsupported extensions.
 */
export function detectLanguage(filePath: string): SupportedLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_MAP[ext]
}

// -----------------------------------------------------------------------
// Availability + cache reset
// -----------------------------------------------------------------------

/**
 * Check if tree-sitter is available and a grammar exists for the given language.
 */
export async function isTreeSitterAvailable(language?: SupportedLanguage): Promise<boolean> {
  const Parser = await getParserCtor()
  if (!Parser) return false
  if (!language) return true

  const lang = await loadLanguage(language, Parser)
  return lang !== null
}

/**
 * Reset internal caches. Useful for testing.
 */
export function _resetTreeSitterCache(): void {
  languageCache.clear()
  initialized = false
  ParserCtor = null
}
