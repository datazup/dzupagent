/**
 * Repo Map — condensed, token-budgeted structural view of a codebase.
 */

export { extractSymbols } from './symbol-extractor.js'
export type { ExtractedSymbol } from './symbol-extractor.js'

export { extractSymbolsAST, isTreeSitterAvailable, detectLanguage, EXTENSION_MAP } from './tree-sitter-extractor.js'
export type { ASTSymbol, SupportedLanguage } from './tree-sitter-extractor.js'

export { buildImportGraph } from './import-graph.js'
export type { ImportEdge, ImportGraph } from './import-graph.js'

export { buildRepoMap } from './repo-map-builder.js'
export type { RepoMapConfig, RepoMap } from './repo-map-builder.js'
