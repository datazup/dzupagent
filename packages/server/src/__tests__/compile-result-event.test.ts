import { describe, it, expect } from 'vitest'
import { buildCompileResultEvent } from '../routes/compile-result-event.js'

describe('buildCompileResultEvent', () => {
  it('normalizes a successful compile into the server terminal event shape', () => {
    expect(buildCompileResultEvent({
      compileId: 'c-1',
      target: 'pipeline',
      artifact: { nodes: [], edges: [] },
      warnings: [{ stage: 4, code: 'WARN_1', message: 'warn' }],
      reasons: [{ code: 'FOR_EACH_PRESENT', message: 'pipeline required' }],
    })).toEqual({
      type: 'flow:compile_result',
      compileId: 'c-1',
      target: 'pipeline',
      artifact: { nodes: [], edges: [] },
      warnings: [{ stage: 4, code: 'WARN_1', message: 'warn' }],
      reasons: [{ code: 'FOR_EACH_PRESENT', message: 'pipeline required' }],
    })
  })

  it('defaults omitted reasons to an empty array', () => {
    expect(buildCompileResultEvent({
      compileId: 'c-2',
      target: 'skill-chain',
      artifact: { steps: [] },
      warnings: [],
    }).reasons).toEqual([])
  })
})
