/**
 * Tree-sitter extractor: public + internal type definitions.
 *
 * Internal `TS*` interfaces are opaque shapes that mirror the
 * `web-tree-sitter` runtime API so the module compiles without the
 * optional dependency installed.
 */

import type { ExtractedSymbol } from './symbol-extractor.js'

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

/** Languages for which we ship tree-sitter query patterns */
export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'

/** Maps file extensions to tree-sitter language identifiers */
export const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
}

/**
 * Extended symbol information from AST parsing.
 * Superset of ExtractedSymbol -- backward-compatible.
 */
export interface ASTSymbol extends ExtractedSymbol {
  /** End line of the symbol definition (1-indexed) */
  endLine: number
  /** Column start (0-indexed) */
  column: number
  /** Column end (0-indexed) */
  endColumn: number
  /** Parent symbol name (for nested classes/methods) */
  parent?: string
  /** Language the symbol was extracted from */
  language: SupportedLanguage
  /** JSDoc / docstring if present */
  docstring?: string
  /** Parameters for functions/methods */
  parameters?: string[]
  /** Return type annotation if present */
  returnType?: string
}

// -----------------------------------------------------------------------
// Internal opaque types mirroring `web-tree-sitter`
// -----------------------------------------------------------------------

export interface TSParser {
  setLanguage(lang: TSLanguage): void
  parse(input: string): TSTree
  delete(): void
}

export interface TSLanguage {
  // opaque handle
}

export interface TSTree {
  rootNode: TSNode
  delete(): void
}

export interface TSNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  childCount: number
  children: TSNode[]
  namedChildren: TSNode[]
  childForFieldName(name: string): TSNode | null
  previousNamedSibling: TSNode | null
  parent: TSNode | null
}

export interface TreeSitterModule {
  default: {
    init(): Promise<void>
    Language: {
      load(path: string): Promise<TSLanguage>
    }
    new (): TSParser
  }
}
