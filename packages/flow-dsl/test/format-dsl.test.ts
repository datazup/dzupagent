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

  it('formats classify.defaultChoice as an explicit default branch', () => {
    const output = formatDocumentToDsl({
      dsl: 'dzupflow/v1',
      id: 'classify-flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'classify',
            id: 'pick_tier',
            prompt: 'Which implementation tier?',
            choices: ['frontend', 'backend', 'infra'],
            outputKey: 'tier',
            defaultChoice: 'infra',
          },
        ],
      },
    })

    expect(output).toContain('- classify:')
    expect(output).toContain('output: tier')
    expect(output).toContain('default: infra')
  })
})
