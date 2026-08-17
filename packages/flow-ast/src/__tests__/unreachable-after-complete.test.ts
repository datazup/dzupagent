import { describe, it, expect } from 'vitest'
import type { FlowNode } from '../index.js'
import {
  UNREACHABLE_AFTER_COMPLETE_CODE,
  UNREACHABLE_AFTER_COMPLETE_SEVERITY,
  checkUnreachableAfterComplete,
} from '../unreachable-after-complete.js'

const action = (id: string): FlowNode => ({
  type: 'action',
  id,
  toolRef: 'test.run',
  input: {},
})

const complete = (id: string): FlowNode => ({ type: 'complete', id })

describe('checkUnreachableAfterComplete', () => {
  it('accepts a flow whose complete is the last node in its scope', () => {
    const root: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [action('a1'), complete('done')],
    }
    expect(checkUnreachableAfterComplete(root)).toEqual([])
  })

  it('flags a sibling after complete at the root scope with ids and count', () => {
    const root: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [complete('done'), action('a1'), action('a2')],
    }
    const diags = checkUnreachableAfterComplete(root)
    expect(diags).toEqual([
      {
        code: UNREACHABLE_AFTER_COMPLETE_CODE,
        severity: UNREACHABLE_AFTER_COMPLETE_SEVERITY,
        message: expect.stringContaining('"a1"'),
        completeId: 'done',
        completePath: 'root.nodes[0]',
        unreachableId: 'a1',
        unreachablePath: 'root.nodes[1]',
        unreachableType: 'action',
        scopePath: 'root',
        unreachableCount: 2,
      },
    ])
    expect(diags[0]!.severity).toBe('error')
  })

  it('flags unreachable siblings inside a branch then-arm without flagging the else-arm', () => {
    const root: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [
        {
          type: 'branch',
          id: 'b1',
          condition: '{{ state.go }}',
          then: [complete('early_exit'), action('dead')],
          else: [action('alive'), complete('late_exit')],
        },
      ],
    }
    const diags = checkUnreachableAfterComplete(root)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({
      completeId: 'early_exit',
      completePath: 'root.nodes[0].then[0]',
      unreachableId: 'dead',
      unreachablePath: 'root.nodes[0].then[1]',
      unreachableType: 'action',
      scopePath: 'root.branch[id=b1].then',
      unreachableCount: 1,
    })
  })

  it('treats parallel branches and try/catch arms as independent scopes', () => {
    const root: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [
        {
          type: 'parallel',
          id: 'p1',
          branches: [
            [complete('b0_done'), action('b0_dead')],
            [action('b1_ok')],
          ],
        },
        {
          type: 'try_catch',
          id: 't1',
          body: [action('try_ok')],
          catch: [complete('catch_done'), action('catch_dead')],
        },
      ],
    }
    const diags = checkUnreachableAfterComplete(root)
    expect(diags.map((d) => d.scopePath).sort()).toEqual([
      'root.parallel[id=p1].branches[0]',
      'root.try_catch[id=t1].catch',
    ])
  })

  it('does not treat a terminal approval reject-arm complete as unreachable siblings elsewhere', () => {
    const root: FlowNode = {
      type: 'sequence',
      id: 'root',
      nodes: [
        {
          type: 'approval',
          id: 'gate',
          prompt: 'ship it?',
          onReject: [complete('rejected')],
        } as unknown as FlowNode,
        action('after_gate'),
        complete('done'),
      ],
    }
    // The complete lives inside the onReject scope; the root-scope
    // continuation after the approval is legitimate.
    expect(checkUnreachableAfterComplete(root)).toEqual([])
  })
})
