import { describe, expect, it } from 'vitest'

import { formatDocumentToDsl } from '../src/format-dsl.js'

describe('formatDocumentToDsl', () => {
  it('formats a canonical document deterministically', () => {
    const output = formatDocumentToDsl({
      dsl: 'dzupflow/v1',
      id: 'flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'complete', id: 'done', result: 'ok' },
        ],
      },
    })

    expect(output).toContain('dsl: dzupflow/v1')
    expect(output).toContain('id: flow')
    expect(output).toContain('steps:')
    expect(output).toContain('- complete:')
    expect(output).toContain('id: done')
  })
})
