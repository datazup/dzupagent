import { describe, expect, it } from 'vitest'

import { parseDslToDocument } from '../src/parse-dsl.js'

describe('dzupflow validation', () => {
  it('fails when a canonical node id is missing', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: flow
version: 1
steps:
  - complete:
      result: ok
`)

    expect(result.diagnostics.some((diagnostic) => diagnostic.path.endsWith('.id'))).toBe(true)
  })

  it('fails on duplicate node ids', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: flow
version: 1
steps:
  - action:
      id: duplicate
      ref: tool.a
      input: {}
  - complete:
      id: duplicate
`)

    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'DUPLICATE_NODE_ID')).toBe(true)
  })
})
