import { documentToGraph } from './document-to-graph.js'
import {
  parseDslToDocument,
  type ParseDslToDocumentOptions,
} from './parse-dsl.js'

import type { CanonicalizeDslResult } from './types.js'

export function canonicalizeDsl(
  source: string,
  options: ParseDslToDocumentOptions = {},
): CanonicalizeDslResult {
  const parsed = parseDslToDocument(source, options)
  if (!parsed.ok) {
    return {
      ok: false,
      document: null,
      partialDocument: parsed.partialDocument,
      flowInput: null,
      derivedGraph: null,
      diagnostics: parsed.diagnostics,
    }
  }

  return {
    ok: true,
    document: parsed.document,
    partialDocument: null,
    flowInput: parsed.document.root,
    derivedGraph: documentToGraph(parsed.document),
    diagnostics: [],
  }
}
