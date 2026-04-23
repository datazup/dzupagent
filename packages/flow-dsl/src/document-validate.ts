import { flowDocumentSchema } from '@dzupagent/flow-ast'

import type { DslDiagnostic, ValidateDocumentResult } from './types.js'

export function validateDocument(document: unknown): ValidateDocumentResult {
  const result = flowDocumentSchema.safeParse(document)
  if (result.success) {
    return { valid: true, diagnostics: [] }
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
