import {
  checkOutputKeyUniqueness,
  flowDocumentSchema,
} from '@dzupagent/flow-ast'

import type { DslDiagnostic, ValidateDocumentResult } from './types.js'

export function validateDocument(document: unknown): ValidateDocumentResult {
  const result = flowDocumentSchema.safeParse(document)
  if (result.success) {
    const diagnostics: DslDiagnostic[] = checkOutputKeyUniqueness(result.data.root).map(
      (diagnostic) => ({
        phase: 'validate',
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.scopePath,
      }),
    )
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
