import { describe, expect, it } from 'vitest'

import { parseDslToDocument } from '../src/parse-dsl.js'

describe('parseDslToDocument', () => {
  it('parses a minimal dzupflow document into a canonical document', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: review_and_build
version: 1
steps:
  - action:
      id: plan
      ref: tool.plan_task
      input:
        goal: "{{ input.goal }}"
  - complete:
      id: done
      result: done
`)

    expect(result.diagnostics).toEqual([])
    expect(result.document).toEqual({
      dsl: 'dzupflow/v1',
      id: 'review_and_build',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'action',
            id: 'plan',
            toolRef: 'tool.plan_task',
            input: { goal: '{{ input.goal }}' },
          },
          {
            type: 'complete',
            id: 'done',
            result: 'done',
          },
        ],
      },
    })
  })

  it('normalizes short-form inputs and defaults', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: flow
version: 1
inputs:
  goal: string
defaults:
  persona: planner
  timeout_ms: 300000
steps:
  - complete:
      id: done
`)

    expect(result.document?.inputs).toEqual({
      goal: { type: 'string', required: true },
    })
    expect(result.document?.defaults).toEqual({
      personaRef: 'planner',
      timeoutMs: 300000,
    })
  })

  it('rejects graph-style top-level nodes/edges input', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: legacy_graph
version: 1
nodes: []
edges: []
steps:
  - complete:
      id: done
`)

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          path: 'root.nodes',
        }),
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          path: 'root.edges',
        }),
      ]),
    )
  })

  it('rejects unsupported semantic fields like on_error', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: unsupported_semantics
version: 1
steps:
  - action:
      id: plan
      ref: tool.plan
      on_error:
        action: retry
      input: {}
`)

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          path: 'root.steps[0].on_error',
        }),
      ]),
    )
  })

  it('fails closed on empty structured bodies', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: empty_bodies
version: 1
steps:
  - parallel:
      id: build
      branches:
        backend: []
  - approval:
      id: gate
      question: Approve?
      on_approve: []
`)

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EMPTY_BRANCH_BODY',
          path: 'root.steps[0].branches.backend',
        }),
        expect.objectContaining({
          code: 'INVALID_NODE_SHAPE',
          path: 'root.steps[0].branches',
        }),
        expect.objectContaining({
          code: 'EMPTY_BRANCH_BODY',
          path: 'root.steps[1].on_approve',
        }),
      ]),
    )
  })

  it('rejects unsupported dzupflow version numbers', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: versioned
version: 2
steps:
  - complete:
      id: done
`)

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_ENUM_VALUE',
          path: 'root.version',
        }),
      ]),
    )
  })
})
