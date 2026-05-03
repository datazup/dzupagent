import { documentToGraph } from './document-to-graph.js'
import { parseDslToDocument } from './parse-dsl.js'

import type { CanonicalizeDslResult } from './types.js'

export function canonicalizeDsl(source: string): CanonicalizeDslResult {
  const parsed = parseDslToDocument(source)
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
