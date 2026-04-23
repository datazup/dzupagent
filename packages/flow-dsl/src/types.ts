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

export interface ParseDslResult {
  document: FlowDocumentV1 | null
  diagnostics: DslDiagnostic[]
}

export interface CanonicalizeDslSuccess {
  ok: true
  document: FlowDocumentV1
  flowInput: FlowDocumentV1['root']
  derivedGraph: DerivedGraph
  diagnostics: []
}

export interface CanonicalizeDslFailure {
  ok: false
  document: null
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
