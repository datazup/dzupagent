import { describe, expect, it } from 'vitest'

import { documentToGraph } from '../src/document-to-graph.js'

describe('documentToGraph', () => {
  it('projects a simple sequence into graph nodes and edges', () => {
    const graph = documentToGraph({
      dsl: 'dzupflow/v1',
      id: 'flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'action', id: 'plan', toolRef: 'tool.plan', input: {} },
          { type: 'complete', id: 'done', result: 'ok' },
        ],
      },
    })

    expect(graph.nodes.map((node) => node.id)).toContain('plan')
    expect(graph.nodes.map((node) => node.id)).toContain('done')
    expect(graph.edges.some((edge) => edge.source === 'plan' && edge.target === 'done')).toBe(true)
  })
})
