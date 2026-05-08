/**
 * Per-node helpers for tree-sitter AST extraction.
 *
 * Pure functions over the opaque `TSNode` tree -- they read names,
 * exports, signatures, docstrings, parameters, and return types
 * with language-aware logic.
 */

import type { ExtractedSymbol } from './symbol-extractor.js'
import type {
  SupportedLanguage,
  TSNode,
} from './tree-sitter-extractor-types.js'

/**
 * Extract the name identifier from an AST node, depending on language.
 */
export function extractName(
  node: TSNode,
  nodeType: string,
  language: SupportedLanguage,
): string | null {
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
export function isExported(node: TSNode, language: SupportedLanguage): boolean {
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
export function extractSignature(
  node: TSNode,
  content: string,
  kind: ExtractedSymbol['kind'],
): string {
  const startLine = node.startPosition.row
  const lines = content.split('\n')
  const firstLine = lines[startLine] ?? ''

  // Clean signature: strip trailing brace and 'export' prefix
  let sig = firstLine
    .trim()
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
export function extractDocstring(node: TSNode): string | undefined {
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
export function extractParameters(node: TSNode): string[] | undefined {
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
export function extractReturnType(node: TSNode): string | undefined {
  const returnType = node.childForFieldName('return_type') ?? node.childForFieldName('result')
  if (returnType) return returnType.text.replace(/^:\s*/, '')
  return undefined
}
