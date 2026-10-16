import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { defaultLogger } from '@dzupagent/core/utils'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import { streamParallel, streamRun, streamSupervisor } from '../http/http-streaming.js'
import type { HttpStreamResponse } from '../http/http-types.js'

// DZUPAGENT-ERR-H-67: a streaming failure must not forward the raw exception
// text to the SSE client or onto the event bus; it is logged once server-side.

const SECRET = 'provider said: db.internal.example:5432 /home/alice/.config'

function failingOrchestrator(): OrchestratorFacade {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield* []
      throw new Error(SECRET)
    }),
    supervisor: vi.fn().mockRejectedValue(new Error(SECRET)),
    parallel: vi.fn().mockRejectedValue(new Error(SECRET)),
    registry: { listAdapters: vi.fn().mockReturnValue(['claude']) },
  } as unknown as OrchestratorFacade
}

async function drain(response: HttpStreamResponse): Promise<string> {
  let out = ''
  for await (const chunk of response.stream) out += chunk
  return out
}

describe('adapter HTTP streaming failures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases: Array<[string, (ctx: Parameters<typeof streamRun>[0]) => HttpStreamResponse]> = [
    ['run', ctx => streamRun(ctx, { prompt: 'p', correlationId: 'corr-run' }, { prompt: 'p', stream: true })],
    ['supervisor', ctx => streamSupervisor({ ...ctx, correlationId: 'corr-supervisor' }, { goal: 'g', stream: true })],
    ['parallel', ctx => streamParallel({ ...ctx, correlationId: 'corr-parallel' }, { prompt: 'p', providers: ['claude'], stream: true })],
  ]

  it.each(cases)('%s keeps the raw message off the client frame and the bus', async (operation, start) => {
    const logged = vi.spyOn(defaultLogger, 'error').mockImplementation(() => undefined)
    const bus = createEventBus()
    const emitted: unknown[] = []
    bus.onAny(e => { emitted.push(e) })

    const sse = await drain(start({ orchestrator: failingOrchestrator(), eventBus: bus }))

    // adapter:failed is serialised as the SSE `error` frame.
    expect(sse).toContain('"type":"error"')
    expect(sse).toContain('"code":"INTERNAL_ERROR"')
    expect(sse).toContain(`Operation \\"${operation}\\" failed`)
    expect(sse).not.toContain('db.internal.example')
    expect(JSON.stringify(emitted)).not.toContain('db.internal.example')
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'agent:stream_delta',
      content: '[error] INTERNAL_ERROR',
    }))

    const rawLogs = logged.mock.calls.filter(call => JSON.stringify(call).includes('db.internal.example'))
    expect(rawLogs).toHaveLength(1)
    expect(rawLogs[0]![1]).toMatchObject({ operation, correlationId: `corr-${operation}`, error: SECRET })
  })

  it('generates a correlation id when the request carried none', async () => {
    const logged = vi.spyOn(defaultLogger, 'error').mockImplementation(() => undefined)
    await drain(streamSupervisor(
      { orchestrator: failingOrchestrator(), eventBus: undefined },
      { goal: 'g', stream: true },
    ))
    const meta = logged.mock.calls[0]![1] as { correlationId: string }
    expect(meta.correlationId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
