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

  it('projects spdd.agent_swarm as a leaf node with a stable label', () => {
    const graph = documentToGraph({
      dsl: 'dzupflow/v1alpha-agent',
      id: 'spdd-flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'spdd.agent_swarm',
            id: 'swarm',
            spddRunId: 'run-1',
            subTasks: [
              { role: 'review', input: { artifactRef: 'artifact-1' } },
            ],
            outputKey: 'swarmResult',
          },
        ],
      },
    })

    expect(graph.nodes).toContainEqual({
      id: 'swarm',
      type: 'spdd.agent_swarm',
      label: 'spdd.agent_swarm:run-1',
    })
    expect(graph.edges).toEqual([])
  })
})
