import {
  checkOutputKeyUniqueness,
  checkUnreachableAfterComplete,
  flowDocumentSchema,
} from '@dzupagent/flow-ast'

import type { DslDiagnostic, ValidateDocumentResult } from './types.js'

export function validateDocument(document: unknown): ValidateDocumentResult {
  const result = flowDocumentSchema.safeParse(document)
  if (result.success) {
    // Preserve the established output-key diagnostic order, then append the
    // reachability pass in deterministic AST traversal order. Both checks are
    // hard validation gates; collecting both gives authors one stable repair
    // list without allowing either defect through.
    const diagnostics: DslDiagnostic[] = [
      ...checkOutputKeyUniqueness(result.data.root).map((diagnostic) => ({
        phase: 'validate',
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.scopePath,
      } as const)),
      ...checkUnreachableAfterComplete(result.data.root).map((diagnostic) => ({
        phase: 'validate',
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.unreachablePath,
      } as const)),
    ]
    return { valid: diagnostics.length === 0, diagnostics }
  }

  const diagnostics: DslDiagnostic[] = result.error.issues.map((issue) => ({
    phase: 'validate',
    code: issue.code,
    message: issue.message,
    path: issue.path,
  }))
  return {
    valid: diagnostics.length === 0,
    diagnostics,
  }
}
