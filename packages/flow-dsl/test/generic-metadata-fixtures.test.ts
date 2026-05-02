import { describe, expect, it } from 'vitest'

import { canonicalizeDsl } from '../src/canonicalize-dsl.js'
import { formatDocumentToDsl } from '../src/format-dsl.js'

const GENERIC_REVIEW_FLOW = `
dsl: dzupflow/v1
id: generic-review-flow
version: 1
steps:
  - approval:
      id: review_gate
      question: "Approve the generic artifact contract?"
      review:
        gate: maintainer
        decisionNeeded: approve-contract
      artifacts:
        path: outputs/report.json
        kind: json
      resume:
        mode: manual
      mutation:
        policy: idempotent
        idempotencyKey: "{{ input.runId }}"
      on_approve:
        - action:
            id: implement
            ref: tools.implement
            requires: [plan]
            produces:
              artifacts: true
            provenance:
              sourceDocumentId: doc-001
            input:
              planId: "{{ input.planId }}"
  - complete:
      id: done
      result: done
`

describe('generic metadata fixtures', () => {
  it('canonicalizes and formats review/artifact/resume/mutation metadata deterministically', () => {
    const first = canonicalizeDsl(GENERIC_REVIEW_FLOW)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected generic review fixture to parse')

    const approval = first.document.root.nodes[0]
    expect(approval?.meta).toMatchObject({
      review: { gate: 'maintainer', decisionNeeded: 'approve-contract' },
      artifacts: { path: 'outputs/report.json', kind: 'json' },
      resume: { mode: 'manual' },
      mutation: { policy: 'idempotent', idempotencyKey: '{{ input.runId }}' },
    })

    const action = approval?.type === 'approval' ? approval.onApprove[0] : undefined
    expect(action?.meta).toMatchObject({
      requires: ['plan'],
      produces: { artifacts: true },
      provenance: { sourceDocumentId: 'doc-001' },
    })

    const formatted = formatDocumentToDsl(first.document)
    const second = canonicalizeDsl(formatted)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected formatted generic review fixture to parse')
    expect(formatDocumentToDsl(second.document)).toBe(formatted)
  })
})
