import { validateFlowDocumentShape } from '@dzupagent/flow-ast'
import { canonicalizeDsl } from '@dzupagent/flow-dsl'

import type { CompilationDiagnostic } from './types.js'

export function prepareFlowInputFromDocument(
  document: unknown,
): { ok: true; flowInput: object } | { ok: false; errors: CompilationDiagnostic[] } {
  if (typeof document !== 'object' || document === null) {
    return {
      ok: false,
      errors: [makeDiagnostic(1, 'INVALID_REQUEST', 'document must be a workflow document object')],
    }
  }

  const issues = validateFlowDocumentShape(document).map((issue) => ({
    stage: 2 as const,
    code: issue.code,
    message: issue.message,
    nodePath: issue.nodePath,
  }))
  if (issues.length > 0) {
    return { ok: false, errors: issues }
  }

  return {
    ok: true,
    flowInput: (document as { root: object }).root,
  }
}

export function prepareFlowInputFromDsl(
  source: unknown,
): { ok: true; flowInput: object } | { ok: false; errors: CompilationDiagnostic[] } {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return {
      ok: false,
      errors: [makeDiagnostic(1, 'INVALID_REQUEST', 'dsl must be a non-empty string')],
    }
  }

  const canonicalized = canonicalizeDsl(source)
  if (!canonicalized.ok) {
    return {
      ok: false,
      errors: canonicalized.diagnostics.map((diagnostic) => ({
        stage: diagnostic.phase === 'parse' ? 1 : 2,
        code: diagnostic.code,
        message: diagnostic.message,
        nodePath: diagnostic.path,
        ...(diagnostic.suggestion ? { suggestion: diagnostic.suggestion } : {}),
      })),
    }
  }

  return {
    ok: true,
    flowInput: canonicalized.flowInput,
  }
}

function makeDiagnostic(
  stage: 1 | 2,
  code: string,
  message: string,
): CompilationDiagnostic {
  return {
    stage,
    code,
    message,
    nodePath: 'root',
  }
}
