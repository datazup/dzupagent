import { describe, expect, it } from 'vitest'

import { normalizeDslDocument } from '../src/normalize.js'

describe('normalizeDslDocument', () => {
  it('preserves JSON-like input defaults', () => {
    const result = normalizeDslDocument({
      dsl: 'dzupflow/v1',
      id: 'flow',
      version: 1,
      inputs: {
        payload: {
          type: 'object',
          default: {
            nested: ['a', 1, true, null],
          },
        },
      },
      steps: [
        {
          complete: {
            id: 'done',
          },
        },
      ],
    })

    expect(result.diagnostics).toEqual([])
    expect(result.document?.inputs).toEqual({
      payload: {
        type: 'object',
        default: {
          nested: ['a', 1, true, null],
        },
      },
    })
  })

  it('rejects non-FlowValue input defaults', () => {
    const result = normalizeDslDocument({
      dsl: 'dzupflow/v1',
      id: 'flow',
      version: 1,
      inputs: {
        startedAt: {
          type: 'string',
          default: new Date('2026-04-23T00:00:00.000Z'),
        },
      },
      steps: [
        {
          complete: {
            id: 'done',
          },
        },
      ],
    })

    expect(result.document?.inputs).toEqual({
      startedAt: {
        type: 'string',
      },
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_INPUT_SPEC',
          path: 'root.inputs.startedAt.default',
        }),
      ]),
    )
  })
})
