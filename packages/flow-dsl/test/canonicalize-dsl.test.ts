import { describe, expect, it } from 'vitest'

import { canonicalizeDsl } from '../src/canonicalize-dsl.js'

describe('canonicalizeDsl', () => {
  it('returns document, flow input, and derived graph from a valid dzupflow document', () => {
    const result = canonicalizeDsl(`
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

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected canonicalization to succeed')
    }

    expect(result.document.root).toEqual(result.flowInput)
    expect(result.derivedGraph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['plan', 'done']),
    )
    expect(result.derivedGraph.edges.some((edge) => edge.source === 'plan' && edge.target === 'done')).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('fails closed and does not derive graph output for invalid dsl', () => {
    const result = canonicalizeDsl(`
dsl: dzupflow/v1
id: invalid
version: 1
steps:
  - action:
      id: plan
      ref: tool.plan
      on_error:
        action: retry
`)

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected canonicalization to fail')
    }

    expect(result.document).toBeNull()
    expect(result.flowInput).toBeNull()
    expect(result.derivedGraph).toBeNull()
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          path: 'root.steps[0].on_error',
        }),
      ]),
    )
  })
})
