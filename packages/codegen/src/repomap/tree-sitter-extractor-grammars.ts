/**
 * Tree-sitter node-type to symbol-kind mapping per language and
 * WASM grammar file name lookup.
 *
 * Each language family gets its own map because the grammar node names
 * differ between tree-sitter parsers.
 */

import type { ExtractedSymbol } from './symbol-extractor.js'
import type { SupportedLanguage } from './tree-sitter-extractor-types.js'

// -----------------------------------------------------------------------
// Node-kind maps
// -----------------------------------------------------------------------

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

/** Resolve the kind map for a given language. */
export function getNodeKindMap(
  language: SupportedLanguage,
): Record<string, ExtractedSymbol['kind']> {
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
export const WASM_GRAMMAR_NAMES: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
}
