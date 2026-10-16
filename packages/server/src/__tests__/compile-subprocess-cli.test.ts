/**
 * DZUPAGENT-CODE-H-13: the `?subprocess=true` SSE branch runs the real
 * `dzupagent-compile` binary and must reach the same dzupflow/v2 target gates
 * as the in-process JSON branch.
 *
 * The binary resolves through `@dzupagent/flow-compiler`'s installed `dist`.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createCompileRoutes } from '../routes/compile.js'

const RETRY_DSL = `
dsl: dzupflow/v2
id: retry-aware
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 3
    save:
      result: state.draft
`

function parseSse(text: string): Array<{ event: string; data: string }> {
  return text
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? ''
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? ''
      return { event, data }
    })
    .filter((frame) => frame.event.length > 0)
}

describe('POST /compile?subprocess=true — real dzupagent-compile', () => {
  it('rejects a dzupflow/v2 retry block with V2_RETRY_TARGET_UNSUPPORTED', async () => {
    const app = new Hono()
    app.route('/api/workflows', createCompileRoutes({}))

    const res = await app.request('/api/workflows/compile?subprocess=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ dsl: RETRY_DSL }),
    })
    const frames = parseSse(await res.text())

    expect(frames.map((f) => f.event)).not.toContain('flow:compile_result')
    const failures = frames
      .filter((f) => f.event === 'flow:compile_failed')
      .map((f) => JSON.parse(f.data) as { type?: string; errors?: Array<{ code?: string; nodePath?: string }> })
      .filter((f) => f.type === 'error')
    expect(failures.flatMap((f) => f.errors ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'V2_RETRY_TARGET_UNSUPPORTED', nodePath: 'root.steps[0].retry' }),
    ]))
  }, 60_000)
})
