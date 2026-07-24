import type { FlowDocumentV1, FlowNode } from '@dzupagent/flow-ast'

export interface SourceSpan {
  lineStart: number
  columnStart: number
  lineEnd: number
  columnEnd: number
}

/** Absolute UTF-16 source range with one-based line/column positions. */
export interface DslSourceSpan extends SourceSpan {
  start: number
  end: number
}

/** One authored YAML/JSON value projected onto its canonical AST path. */
export interface DslSourceMapEntry {
  canonicalPath: string
  authoredPath: string
  keySpan?: DslSourceSpan
  valueSpan?: DslSourceSpan
  /**
   * Absolute source offset for each UTF-16 boundary in the decoded scalar.
   * Present only when the authored value is a string and exact composition is
   * possible.
   */
  contentOffsets?: readonly number[]
  derived?: boolean
}

export interface DslSourceMap {
  schema: 'dzupagent.dslSourceMap/v1'
  sourceDigest: `sha256:${string}`
  lineStarts: readonly number[]
  entries: Readonly<Record<string, DslSourceMapEntry | undefined>>
}

export interface DslDiagnostic {
  phase: 'parse' | 'normalize' | 'validate'
  code: string
  message: string
  path: string
  span?: SourceSpan
  suggestion?: string
}

export interface NormalizeDslSuccess {
  ok: true
  document: FlowDocumentV1
  partialDocument: null
  diagnostics: []
}

export interface NormalizeDslFailure {
  ok: false
  document: null
  partialDocument: FlowDocumentV1 | null
  diagnostics: DslDiagnostic[]
}

export type NormalizeDslResult = NormalizeDslSuccess | NormalizeDslFailure

export interface ParseDslSuccess {
  ok: true
  document: FlowDocumentV1
  partialDocument: null
  diagnostics: []
}

export interface ParseDslFailure {
  ok: false
  document: null
  partialDocument: FlowDocumentV1 | null
  diagnostics: DslDiagnostic[]
}

export type ParseDslResult = ParseDslSuccess | ParseDslFailure

export interface CanonicalizeDslSuccess {
  ok: true
  document: FlowDocumentV1
  flowInput: FlowDocumentV1['root']
  derivedGraph: DerivedGraph
  partialDocument: null
  diagnostics: []
}

export interface CanonicalizeDslFailure {
  ok: false
  document: null
  partialDocument: FlowDocumentV1 | null
  flowInput: null
  derivedGraph: null
  diagnostics: DslDiagnostic[]
}

export type CanonicalizeDslResult = CanonicalizeDslSuccess | CanonicalizeDslFailure

export interface ValidateDocumentResult {
  valid: boolean
  diagnostics: DslDiagnostic[]
}

export interface DerivedGraphNode {
  id: string
  type: FlowNode['type']
  label: string
}

export interface DerivedGraphEdge {
  id: string
  source: string
  target: string
  label?: string
}

export interface DerivedGraph {
  nodes: DerivedGraphNode[]
  edges: DerivedGraphEdge[]
}
