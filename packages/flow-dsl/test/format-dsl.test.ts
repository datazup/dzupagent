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

  it('formats spdd.agent_swarm nodes', () => {
    const output = formatDocumentToDsl({
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
              {
                role: 'review',
                personaRef: 'reviewer',
                input: { artifactRef: 'artifact-1' },
              },
            ],
            outputKey: 'swarmResult',
          },
        ],
      },
    })

    expect(output).toContain('- spdd.agent_swarm:')
    expect(output).toContain('spddRunId: run-1')
    expect(output).toContain('subTasks: [{"role":"review","personaRef":"reviewer","input":{"artifactRef":"artifact-1"}}]')
    expect(output).toContain('outputKey: swarmResult')
  })
})
