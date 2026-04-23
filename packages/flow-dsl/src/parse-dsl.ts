import type { FlowDocumentV1 } from '@dzupagent/flow-ast'

import { DSL_ERROR } from './errors.js'
import { parseYamlSubset } from './mini-yaml.js'
import { normalizeDslDocument } from './normalize.js'
import { validateDocument } from './document-validate.js'
import type { ParseDslResult } from './types.js'

export function parseDslToDocument(source: string): ParseDslResult {
  const yaml = parseYamlSubset(source)
  if (!yaml.ok) {
    return {
      document: null,
      diagnostics: yaml.errors.map((error) => ({
        phase: 'parse' as const,
        code: error.code,
        message: error.message,
        path: 'root',
        span: {
          lineStart: error.line,
          columnStart: error.column,
          lineEnd: error.line,
          columnEnd: error.column,
        },
      })),
    }
  }

  const { document, diagnostics } = normalizeDslDocument(yaml.value)
  if (document === null) {
    return { document: null, diagnostics }
  }

  if (document.dsl !== 'dzupflow/v1') {
    diagnostics.push({
      phase: 'normalize',
      code: DSL_ERROR.INVALID_DSL_VERSION,
      message: 'dsl must equal "dzupflow/v1"',
      path: 'root.dsl',
    })
  }

  const validation = validateDocument(document)
  return {
    document: validation.valid ? (document as FlowDocumentV1) : document,
    diagnostics: [...diagnostics, ...validation.diagnostics],
  }
}
