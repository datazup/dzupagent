/**
 * Tree-sitter-based symbol extractor with per-language AST parsing.
 *
 * Uses web-tree-sitter (WASM runtime) for multi-language AST analysis.
 * Falls back to regex extraction when tree-sitter is not installed.
 */

import * as path from 'node:path'
import { extractSymbols, type ExtractedSymbol } from './symbol-extractor.js'

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
// Tree-sitter node-type to symbol-kind mapping per language
// -----------------------------------------------------------------------

/**
 * Mapping from tree-sitter node type names to ExtractedSymbol kind.
 * Each language family gets its own map because the grammar node names differ.
 */
const TS_JS_NODE_KINDS: Record<string, ExtractedSymbol['kind']> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'const',
}

const PYTHON_NODE_KINDS: Record<string, ExtractedSymbol['kind']> = {
  function_definition: 'function',
  class_definition: 'class',
}

const GO_NODE_KINDS: Record<string, ExtractedSymbol['kind']> = {
  function_declaration: 'function',
  method_declaration: 'function',
  type_declaration: 'type',
}

const RUST_NODE_KINDS: Record<string, ExtractedSymbol['kind']> = {
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  impl_item: 'class',
  type_item: 'type',
}

const JAVA_NODE_KINDS: Record<string, ExtractedSymbol['kind']> = {
  method_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
}

function getNodeKindMap(language: SupportedLanguage): Record<string, ExtractedSymbol['kind']> {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return TS_JS_NODE_KINDS
    case 'python':
      return PYTHON_NODE_KINDS
    case 'go':
      return GO_NODE_KINDS
    case 'rust':
      return RUST_NODE_KINDS
    case 'java':
      return JAVA_NODE_KINDS
  }
}

// -----------------------------------------------------------------------
// WASM grammar file name mapping
// -----------------------------------------------------------------------

/** Map our language ids to the WASM file names shipped by tree-sitter-wasms */
const WASM_GRAMMAR_NAMES: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
}

// -----------------------------------------------------------------------
// Lazy singleton for the tree-sitter parser
// -----------------------------------------------------------------------

/**
 * We use opaque types internally so the module compiles without tree-sitter
 * installed. At runtime we dynamically import `web-tree-sitter`.
 */

interface TSParser {
  setLanguage(lang: TSLanguage): void
  parse(input: string): TSTree
  delete(): void
}

interface TSLanguage {
  // opaque handle
}

interface TSTree {
  rootNode: TSNode
  delete(): void
}

interface TSNode {
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

interface TreeSitterModule {
  default: {
    init(): Promise<void>
    Language: {
      load(path: string): Promise<TSLanguage>
    }
    new (): TSParser
  }
}

/** Cache for loaded languages */
const languageCache = new Map<SupportedLanguage, TSLanguage>()

/** Whether web-tree-sitter has been initialized */
let initialized = false

/** Cached parser constructor (or null if unavailable) */
let ParserCtor: (TreeSitterModule['default']) | null = null

/**
 * Try to initialize web-tree-sitter. Returns the Parser constructor or null.
 */
async function getParserCtor(): Promise<(TreeSitterModule['default']) | null> {
  if (ParserCtor !== null) return ParserCtor

  try {
    // Dynamic import -- web-tree-sitter is optional
    const mod = await import('web-tree-sitter') as unknown as TreeSitterModule
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
 * Load a tree-sitter language grammar (WASM).
 * Returns null if the grammar cannot be loaded.
 */
async function loadLanguage(
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
// AST walking
// -----------------------------------------------------------------------

/**
 * Extract the name identifier from an AST node, depending on language.
 */
function extractName(node: TSNode, nodeType: string, language: SupportedLanguage): string | null {
  // Most languages use a 'name' field
  const nameNode = node.childForFieldName('name')
  if (nameNode) return nameNode.text

  // For TypeScript/JavaScript lexical_declaration (const x = ...)
  if (
    (language === 'typescript' || language === 'javascript') &&
    nodeType === 'lexical_declaration'
  ) {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const varName = child.childForFieldName('name')
        if (varName) return varName.text
      }
    }
  }

  // For Go type_declaration, dig into the type_spec
  if (language === 'go' && nodeType === 'type_declaration') {
    for (const child of node.namedChildren) {
      if (child.type === 'type_spec') {
        const specName = child.childForFieldName('name')
        if (specName) return specName.text
      }
    }
  }

  return null
}

/**
 * Check if a node is exported, depending on language.
 */
function isExported(node: TSNode, language: SupportedLanguage): boolean {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      // Check for 'export' keyword in parent or preceding sibling
      const parent = node.parent
      if (parent && (parent.type === 'export_statement' || parent.type === 'export_declaration')) {
        return true
      }
      // Check if the node text starts with 'export'
      if (node.text.trimStart().startsWith('export')) return true
      // Check previous sibling for export_statement
      const prev = node.previousNamedSibling
      if (prev && prev.type === 'export_statement') return true
      return false
    }
    case 'python':
      // Python has no explicit export keyword; treat top-level non-underscore as exported
      return !node.childForFieldName('name')?.text.startsWith('_')
    case 'go':
      // Go: exported if name starts with uppercase
      return /^[A-Z]/.test(extractName(node, node.type, language) ?? '')
    case 'rust': {
      // Rust: check for 'pub' visibility modifier
      const firstChild = node.children[0]
      return firstChild?.type === 'visibility_modifier'
    }
    case 'java': {
      // Java: check for 'public' modifier
      for (const child of node.children) {
        if (child.type === 'modifiers' && child.text.includes('public')) return true
      }
      return false
    }
  }
}

/**
 * Extract the signature line from an AST node.
 */
function extractSignature(node: TSNode, content: string, kind: ExtractedSymbol['kind']): string {
  const startLine = node.startPosition.row
  const lines = content.split('\n')
  const firstLine = lines[startLine] ?? ''

  // Clean signature: strip trailing brace and 'export' prefix
  let sig = firstLine.trim()
    .replace(/\s*\{?\s*$/, '')
    .replace(/^export\s+(?:default\s)?/, '')
    .trim()

  // For classes/interfaces/enums, don't include the body
  if (kind === 'class' || kind === 'interface' || kind === 'enum') {
    sig = sig.replace(/\s*\{.*$/, '').trim()
  }

  return sig
}

/**
 * Extract docstring/JSDoc from the node's preceding comment.
 */
function extractDocstring(node: TSNode): string | undefined {
  const prev = node.previousNamedSibling
  if (!prev) return undefined

  if (prev.type === 'comment') {
    const text = prev.text.trim()
    // JSDoc style
    if (text.startsWith('/**')) return text
    // Python docstring style
    if (text.startsWith('"""') || text.startsWith("'''")) return text
    // Single-line doc comment
    if (text.startsWith('///') || text.startsWith('//!')) return text
  }

  return undefined
}

/**
 * Extract function parameters from a node.
 */
function extractParameters(node: TSNode): string[] | undefined {
  const params = node.childForFieldName('parameters')
  if (!params) return undefined

  const result: string[] = []
  for (const child of params.namedChildren) {
    const paramName = child.childForFieldName('name') ?? child.childForFieldName('pattern')
    if (paramName) {
      result.push(paramName.text)
    }
  }

  return result.length > 0 ? result : undefined
}

/**
 * Extract return type annotation from a node.
 */
function extractReturnType(node: TSNode): string | undefined {
  const returnType = node.childForFieldName('return_type') ?? node.childForFieldName('result')
  if (returnType) return returnType.text.replace(/^:\s*/, '')
  return undefined
}

/**
 * Walk the AST tree and collect symbols.
 */
function walkTree(
  node: TSNode,
  language: SupportedLanguage,
  filePath: string,
  content: string,
  kindMap: Record<string, ExtractedSymbol['kind']>,
  parentName?: string,
): ASTSymbol[] {
  const symbols: ASTSymbol[] = []

  // Check if this node is a symbol we care about
  const kind = kindMap[node.type]
  if (kind !== undefined) {
    const name = extractName(node, node.type, language)
    if (name) {
      // For lexical_declaration in TS/JS, only capture if it has a meaningful value
      // (arrow function, function expression, object, class expression)
      if (node.type === 'lexical_declaration') {
        const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator')
        const value = declarator?.childForFieldName('value')
        if (!value) {
          // Skip simple variable declarations without initializers
        } else {
          const valuableTypes = new Set([
            'arrow_function',
            'function_expression',
            'function',
            'class',
            'object',
            'call_expression',
          ])
          // Only include as 'const' if it's not an arrow/function (those are already caught)
          const isFunction = value.type === 'arrow_function' || value.type === 'function_expression'
          const resolvedKind: ExtractedSymbol['kind'] = isFunction ? 'function' : 'const'

          if (valuableTypes.has(value.type) || resolvedKind === 'const') {
            const sym: ASTSymbol = {
              name,
              kind: resolvedKind,
              signature: extractSignature(node, content, resolvedKind),
              exported: isExported(node, language),
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              column: node.startPosition.column,
              endColumn: node.endPosition.column,
              language,
              filePath,
            }
            if (parentName !== undefined) sym.parent = parentName
            const ds = extractDocstring(node)
            if (ds !== undefined) sym.docstring = ds
            if (isFunction) {
              const params = extractParameters(value)
              if (params !== undefined) sym.parameters = params
              const rt = extractReturnType(value)
              if (rt !== undefined) sym.returnType = rt
            }
            symbols.push(sym)
          }
        }
      } else {
        const sym: ASTSymbol = {
          name,
          kind,
          signature: extractSignature(node, content, kind),
          exported: isExported(node, language),
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          column: node.startPosition.column,
          endColumn: node.endPosition.column,
          language,
          filePath,
        }
        if (parentName !== undefined) sym.parent = parentName
        const ds = extractDocstring(node)
        if (ds !== undefined) sym.docstring = ds
        const params = extractParameters(node)
        if (params !== undefined) sym.parameters = params
        const rt = extractReturnType(node)
        if (rt !== undefined) sym.returnType = rt
        symbols.push(sym)
      }

      // For classes, recurse into children with this name as parent
      if (kind === 'class' || kind === 'interface') {
        for (const child of node.namedChildren) {
          symbols.push(
            ...walkTree(child, language, filePath, content, kindMap, name),
          )
        }
        return symbols
      }
    }
  }

  // Recurse into children (if not already handled above)
  // For export_statement wrappers, pass through to the child
  if (node.type === 'export_statement' || node.type === 'export_declaration') {
    for (const child of node.namedChildren) {
      symbols.push(
        ...walkTree(child, language, filePath, content, kindMap, parentName),
      )
    }
  } else {
    for (const child of node.namedChildren) {
      symbols.push(
        ...walkTree(child, language, filePath, content, kindMap, parentName),
      )
    }
  }

  return symbols
}

// -----------------------------------------------------------------------
// Public API
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

/**
 * Reset internal caches. Useful for testing.
 */
export function _resetTreeSitterCache(): void {
  languageCache.clear()
  initialized = false
  ParserCtor = null
}
