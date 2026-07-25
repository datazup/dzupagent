export interface DslDiagnostic {
  phase: 'parse' | 'normalize' | 'validate'
  code: string
  message: string
  path: string
  span?: {
    lineStart: number
    columnStart: number
    lineEnd: number
    columnEnd: number
  }
  suggestion?: string
}
