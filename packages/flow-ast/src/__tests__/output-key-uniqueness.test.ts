import { describe, expect, it } from 'vitest'

import type { FlowNode } from '../index.js'
import {
  OUTPUT_KEY_UNIQUENESS_CODE,
  OUTPUT_KEY_UNIQUENESS_SEVERITY,
  checkOutputKeyUniqueness,
} from '../output-key-uniqueness.js'

function agentNode(id: string, key: string): FlowNode {
  return {
    type: 'agent',
    id,
    agentId: id,
    instructions: 'do the thing',
    output: { key, schema: { type: 'object' } },
  }
}

function promptNode(id: string, outputKey?: string): FlowNode {
  return {
    type: 'prompt',
    id,
    userPrompt: 'summarize the input',
    ...(outputKey === undefined ? {} : { outputKey }),
  }
}

function root(...nodes: FlowNode[]): FlowNode {
  return { type: 'sequence', id: 'root', nodes }
}

describe('checkOutputKeyUniqueness', () => {
  it('returns hard errors for duplicate output keys in one sequence', () => {
    const diagnostics = checkOutputKeyUniqueness(
      root(agentNode('a', 'result'), agentNode('b', 'result')),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: OUTPUT_KEY_UNIQUENESS_CODE,
        severity: OUTPUT_KEY_UNIQUENESS_SEVERITY,
        key: 'result',
        relatedIds: ['a', 'b'],
        scopePath: 'root.nodes[1]',
      }),
    ])
    expect(OUTPUT_KEY_UNIQUENESS_SEVERITY).toBe('error')
  })

  it('detects collisions across different output field conventions', () => {
    const outputNodes: Array<[string, FlowNode]> = [
      ['prompt.outputKey', promptNode('prompt', 'result')],
      ['prompt default', promptNode('result')],
      ['classify.outputKey', {
        type: 'classify', id: 'classify', prompt: 'classify', choices: ['a'], outputKey: 'result',
      }],
      ['worker.outputKey', {
        type: 'worker.dispatch', id: 'worker', dispatchId: 'worker', provider: 'codex',
        instructions: 'work', outputKey: 'result',
      }],
      ['adapter.output', {
        type: 'adapter.run', id: 'adapter', provider: 'codex', instructions: 'work', output: 'result',
      }],
      ['knowledge.output', {
        type: 'knowledge.query', id: 'knowledge', filter: {}, output: 'result',
      }],
      ['memory.outputVar', {
        type: 'memory', id: 'memory', operation: 'read', tier: 'session', outputVar: 'result',
      }],
      ['http.outputVar', {
        type: 'http', id: 'http', url: 'https://example.invalid', outputVar: 'result',
      }],
      ['subflow.outputVar', {
        type: 'subflow', id: 'subflow', flowRef: 'child', outputVar: 'result',
      }],
      ['spdd.outputKey', {
        type: 'spdd.import_sources', id: 'spdd', spddRunId: 'run', sourceRefs: [], outputKey: 'result',
      }],
    ]

    for (const [label, node] of outputNodes) {
      expect(
        checkOutputKeyUniqueness(root(agentNode('agent', 'result'), node)),
        label,
      ).toEqual([
        expect.objectContaining({ key: 'result', severity: 'error' }),
      ])
    }
  })

  it('allows output reuse only across explicit mutually exclusive alternatives', () => {
    const flow = root(
      {
        type: 'branch',
        id: 'branch',
        condition: 'state.ready',
        then: [agentNode('then', 'result')],
        else: [promptNode('else', 'result')],
      },
      {
        type: 'approval',
        id: 'approval',
        question: 'Proceed?',
        onApprove: [agentNode('approve', 'decision')],
        onReject: [promptNode('reject', 'decision')],
      },
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([])
  })

  it('propagates alternative outputs to later same-path declarations', () => {
    const flow = root(
      {
        type: 'branch',
        id: 'branch',
        condition: 'state.ready',
        then: [agentNode('then', 'result')],
        else: [promptNode('else', 'result')],
      },
      agentNode('after', 'result'),
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['after', 'then'], key: 'result' }),
      expect.objectContaining({ relatedIds: ['after', 'else'], key: 'result' }),
    ])
  })

  it('rejects collisions across parallel branches because both execute', () => {
    const flow = root({
      type: 'parallel',
      id: 'parallel',
      branches: [[agentNode('left', 'result')], [promptNode('right', 'result')]],
    })

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['left', 'right'], key: 'result' }),
    ])
  })

  it('does not create a fresh collision scope for nested sequences or wrappers', () => {
    const flow = root(
      agentNode('before', 'result'),
      {
        type: 'persona',
        id: 'persona',
        personaId: 'reviewer',
        body: [{
          type: 'sequence',
          id: 'nested',
          nodes: [promptNode('inside', 'result')],
        }],
      },
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['before', 'inside'], key: 'result' }),
    ])
  })

  it('allows the same final output across successful try and recovery paths', () => {
    const flow = root({
      type: 'try_catch',
      id: 'try',
      body: [agentNode('body', 'result')],
      catch: [promptNode('catch', 'result')],
    })

    expect(checkOutputKeyUniqueness(flow)).toEqual([])
  })

  it('propagates both try/catch alternatives to a later declaration', () => {
    const flow = root(
      {
        type: 'try_catch',
        id: 'try',
        body: [agentNode('body', 'result')],
        catch: [promptNode('catch', 'result')],
      },
      agentNode('after', 'result'),
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['after', 'body'], key: 'result' }),
      expect.objectContaining({ relatedIds: ['after', 'catch'], key: 'result' }),
    ])
  })

  it('treats the try/catch error destination as a catch-path output', () => {
    const flow = root(
      agentNode('before', 'failure'),
      {
        type: 'try_catch',
        id: 'try',
        errorVar: 'failure',
        body: [agentNode('body', 'result')],
        catch: [promptNode('fallback', 'result')],
      },
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['before', 'try'], key: 'failure' }),
    ])
  })

  it('includes for_each aggregate destinations in the collision domain', () => {
    const flow = root(
      agentNode('before', 'results'),
      {
        type: 'for_each',
        id: 'items',
        source: '{{ inputs.items }}',
        as: 'item',
        body: [promptNode('render', 'rendered')],
        collect: { from: 'rendered', into: 'results' },
      },
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['before', 'items'], key: 'results' }),
    ])
  })

  it('keeps for_each iteration-local outputs separate from outer state', () => {
    const flow = root(
      agentNode('before', 'rendered'),
      {
        type: 'for_each',
        id: 'items',
        source: '{{ inputs.items }}',
        as: 'item',
        body: [
          promptNode('render', 'rendered'),
          agentNode('rewrite', 'rendered'),
        ],
        collect: { from: 'rendered', into: 'results' },
      },
    )

    expect(checkOutputKeyUniqueness(flow)).toEqual([
      expect.objectContaining({ relatedIds: ['render', 'rewrite'], key: 'rendered' }),
    ])
  })

  it('does not retain state across independent validations', () => {
    expect(
      checkOutputKeyUniqueness(root(agentNode('a', 'result'), agentNode('b', 'result'))),
    ).toHaveLength(1)
    expect(
      checkOutputKeyUniqueness(root(agentNode('c', 'result'), agentNode('d', 'review'))),
    ).toEqual([])
  })
})
