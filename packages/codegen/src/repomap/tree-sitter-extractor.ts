/**
 * Tree-sitter-based symbol extractor with per-language AST parsing.
 *
 * Uses web-tree-sitter (WASM runtime) for multi-language AST analysis.
 * Falls back to regex extraction when tree-sitter is not installed.
 *
 * This file is a thin coordinator that wires together the focused
 * sibling modules:
 *  - `tree-sitter-extractor-types`    public + opaque internal types
 *  - `tree-sitter-extractor-grammars` per-language node-kind + WASM maps
 *  - `tree-sitter-extractor-loader`   parser/grammar loading + detection
 *  - `tree-sitter-extractor-walker`   AST traversal + symbol shaping
 */

import { extractSymbols } from './symbol-extractor.js'
import { getNodeKindMap } from './tree-sitter-extractor-grammars.js'
import {
  detectLanguage,
  getParserCtor,
  loadLanguage,
} from './tree-sitter-extractor-loader.js'
import type {
  ASTSymbol,
  SupportedLanguage,
} from './tree-sitter-extractor-types.js'
import { walkTree } from './tree-sitter-extractor-walker.js'

// -----------------------------------------------------------------------
// Re-exports (preserve public API for existing callers)
// -----------------------------------------------------------------------

export type {
  ASTSymbol,
  SupportedLanguage,
} from './tree-sitter-extractor-types.js'
export { EXTENSION_MAP } from './tree-sitter-extractor-types.js'
export {
  _resetTreeSitterCache,
  detectLanguage,
  isTreeSitterAvailable,
} from './tree-sitter-extractor-loader.js'

// -----------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------

/**
 * Extract symbols from source code using tree-sitter AST parsing.
 *
 * Falls back to regex extraction if:
 * - web-tree-sitter is not installed
 * - No grammar exists for the file's language
 * - Parsing fails for any reason
 *
 * @param filePath - Used to determine language from extension
 * @param content - Source code to parse
 * @returns Array of extracted symbols (ASTSymbol when tree-sitter succeeds, ExtractedSymbol on fallback)
 */
export async function extractSymbolsAST(
  filePath: string,
  content: string,
): Promise<ASTSymbol[]> {
  const language = detectLanguage(filePath)
  if (!language) {
    // Unsupported language -- fall back to regex for TS-like files
    return regexFallback(filePath, content)
  }

  try {
    const Parser = await getParserCtor()
    if (!Parser) {
      return regexFallback(filePath, content, language)
    }

    const lang = await loadLanguage(language, Parser)
    if (!lang) {
      return regexFallback(filePath, content, language)
    }

    const parser = new Parser()
    try {
      parser.setLanguage(lang)
      const tree = parser.parse(content)
      try {
        const kindMap = getNodeKindMap(language)
        const symbols = walkTree(tree.rootNode, language, filePath, content, kindMap)

        // Deduplicate: sometimes export wrappers cause double-counting
        const seen = new Set<string>()
        const deduped: ASTSymbol[] = []
        for (const sym of symbols) {
          const key = `${sym.name}:${sym.line}:${sym.kind}`
          if (!seen.has(key)) {
            seen.add(key)
            deduped.push(sym)
          }
        }

        return deduped
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  } catch {
    // Any error -- fall back gracefully
    return regexFallback(filePath, content, language)
  }
}

/**
 * Fallback: convert regex ExtractedSymbol results to ASTSymbol shape.
 */
function regexFallback(
  filePath: string,
  content: string,
  language?: SupportedLanguage,
): ASTSymbol[] {
  // Regex extractor only works on TS-like files
  const lang = language ?? 'typescript'
  if (lang !== 'typescript' && lang !== 'javascript') {
    // For non-TS/JS, return empty -- regex patterns only handle TS
    return []
  }

  const regexSymbols = extractSymbols(filePath, content)
  return regexSymbols.map((sym) => ({
    ...sym,
    endLine: sym.line, // regex cannot determine end line
    column: 0,
    endColumn: 0,
    language: lang,
  }))
}
