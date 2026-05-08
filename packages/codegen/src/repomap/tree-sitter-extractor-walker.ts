/**
 * Tree-sitter AST walking. Recursively traverses the opaque `TSNode`
 * tree and emits `ASTSymbol`s using the per-node helpers.
 */

import type { ExtractedSymbol } from './symbol-extractor.js'
import {
  extractDocstring,
  extractName,
  extractParameters,
  extractReturnType,
  extractSignature,
  isExported,
} from './tree-sitter-extractor-node-helpers.js'
import type {
  ASTSymbol,
  SupportedLanguage,
  TSNode,
} from './tree-sitter-extractor-types.js'

/**
 * Walk the AST tree and collect symbols.
 */
export function walkTree(
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
        if (value) {
          const valuableTypes = new Set([
            'arrow_function',
            'function_expression',
            'function',
            'class',
            'object',
            'call_expression',
          ])
          // Only include as 'const' if it's not an arrow/function (those are already caught)
          const isFunction =
            value.type === 'arrow_function' || value.type === 'function_expression'
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
          symbols.push(...walkTree(child, language, filePath, content, kindMap, name))
        }
        return symbols
      }
    }
  }

  // Recurse into children (if not already handled above)
  // For export_statement wrappers, pass through to the child
  for (const child of node.namedChildren) {
    symbols.push(...walkTree(child, language, filePath, content, kindMap, parentName))
  }

  return symbols
}
