import type { FlowDocumentV1, FlowNode } from '@dzupagent/flow-ast'

export interface SourceSpan {
  lineStart: number
  columnStart: number
  lineEnd: number
  columnEnd: number
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
