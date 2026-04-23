import { documentToGraph } from './document-to-graph.js'
import { parseDslToDocument } from './parse-dsl.js'

import type { CanonicalizeDslResult } from './types.js'

export function canonicalizeDsl(source: string): CanonicalizeDslResult {
  const parsed = parseDslToDocument(source)
  if (parsed.document === null || parsed.diagnostics.length > 0) {
    return {
      ok: false,
      document: null,
      flowInput: null,
      derivedGraph: null,
      diagnostics: parsed.diagnostics,
    }
  }

  return {
    ok: true,
    document: parsed.document,
    flowInput: parsed.document.root,
    derivedGraph: documentToGraph(parsed.document),
    diagnostics: [],
  }
}
