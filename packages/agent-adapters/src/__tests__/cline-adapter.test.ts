import { describe, expect, it, vi } from 'vitest'
import { ClineAdapter } from '../cline/cline-adapter.js'
import type { ClineAdapterConfig } from '../cline/cline-adapter.js'
import type { AgentEvent, AgentInput } from '../types.js'
import type { ClineBinding, ClineChildMessage, ClineParentMessage } from '../cline/cline-worker-protocol.js'
import type { ClineTransportFactory } from '../cline/cline-worker-transport.js'
import { CLINE_LIMITS } from '../cline/cline-worker-protocol.js'

const config: ClineAdapterConfig = { profileDir: '/host-profile', workingDirectory: '/project', provider: 'anthropic', model: 'explicit-model', timeoutMs: 1000 }
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events }
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve() }
function fixture(onStart?: (emit: (message: ClineChildMessage) => void, binding: ClineBinding) => void) {
  const sent: ClineParentMessage[] = []
  const shutdown = vi.fn(async () => undefined)
  let emit!: (message: unknown) => void
  let binding!: ClineBinding
  let fail!: (code: string) => void
  const factory = vi.fn<ClineTransportFactory>(async (b, onMessage, onFailure) => {
    binding = b; emit = onMessage; fail = onFailure
    onMessage({ ...b, type: 'ready' })
    return { send: async message => {
      sent.push(message)
      if (message.type === 'start') onStart?.(value => onMessage(value), b)
    }, shutdown }
  })
  return { factory, sent, shutdown, emit: (message: unknown) => emit(message), binding: () => binding, fail: (code: string) => fail(code) }
}
const complete = (binding: ClineBinding): ClineChildMessage => ({ ...binding, type: 'result', success: true, text: 'answer', reason: 'completed' })
const terminal = (events: AgentEvent[]) => events.filter(event => event.type === 'adapter:completed' || event.type === 'adapter:failed')

describe('standalone Cline adapter', () => {
  it('creates one worker per execute with explicit config and no credential data', async () => {
    const h = fixture((emit, b) => emit(complete(b)))
    const adapter = new ClineAdapter(config, h.factory)
    const first = await collect(adapter.execute({ prompt: 'one', maxTurns: 2, correlationId: 'corr' }))
    const second = await collect(adapter.execute({ prompt: 'two', workingDirectory: '/other' }))
    expect(h.factory).toHaveBeenCalledTimes(2)
    const starts = h.sent.filter(item => item.type === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[0]).toMatchObject({ profileDir: '/host-profile', cwd: '/project', provider: 'anthropic', model: 'explicit-model',
      prompt: 'one', systemPrompt: '', enableTools: true, maxIterations: 2, version: 1 })
    expect(starts[1]).toMatchObject({ cwd: '/other', prompt: 'two' })
    expect(starts[0]!.runId).not.toBe(starts[1]!.runId)
    expect(starts[0]!.sessionId).not.toBe(starts[1]!.sessionId)
    expect(first.map(event => event.type)).toEqual(['adapter:started', 'adapter:completed'])
    expect(first.every(event => event.correlationId === 'corr')).toBe(true)
    expect(terminal(first)[0]).not.toHaveProperty('usage')
    expect(terminal(second)).toHaveLength(1)
    expect(h.shutdown).toHaveBeenCalledTimes(2)
  })

  it('maps stream/usage, ignores post-terminal data, and emits only one terminal', async () => {
    const h = fixture((emit, b) => {
      emit({ ...b, type: 'event', event: { kind: 'text', text: 'streamed' } })
      emit({ ...b, type: 'result', success: true, text: 'answer', reason: 'completed', usage: { inputTokens: 2, outputTokens: 3 } })
      emit({ ...b, type: 'result', success: false, text: '', reason: 'error' })
    })
    const events = await collect(new ClineAdapter(config, h.factory).execute({ prompt: 'test' }))
    expect(events.map(event => event.type)).toEqual(['adapter:started', 'adapter:stream_delta', 'adapter:completed'])
    expect(terminal(events)).toMatchObject([{ usage: { inputTokens: 2, outputTokens: 3 } }])
  })

  it.each([
    { apiKey: 'fixture-only' }, { env: {} }, { envFilter: { disableFilter: true } }, { sandboxMode: 'read-only' },
    { providerOptions: {} }, { reasoning: 'high' }, { interactionPolicy: { mode: 'auto-approve' } },
    { interactionPolicy: { mode: 'ai-autonomous' } },
  ])('rejects unenforceable config before effects: %j', unsupported => {
    const h = fixture()
    expect(() => new ClineAdapter({ ...config, ...unsupported } as ClineAdapterConfig, h.factory)).toThrow(/CLINE_/)
    expect(h.factory).not.toHaveBeenCalled()
  })

  it.each([
    { resumeSessionId: 'old' }, { maxBudgetUsd: 0 }, { outputSchema: {} }, { policyContext: { activePolicy: { networkAccess: false } } },
    { options: { tools: [] } }, { maxTurns: NaN }, { maxTurns: -1 }, { workingDirectory: 'relative' },
  ])('rejects unsupported inputs without spawn: %j', unsupported => {
    const h = fixture()
    const adapter = new ClineAdapter(config, h.factory)
    expect(() => adapter.execute({ prompt: 'test', ...unsupported } as AgentInput)).toThrow(/CLINE_/)
    expect(h.factory).not.toHaveBeenCalled()
  })

  it('rejects native resume without creating a worker', async () => {
    const h = fixture()
    const adapter = new ClineAdapter(config, h.factory)
    await expect(adapter.resumeSession().next()).rejects.toThrow('CLINE_RESUME_UNSUPPORTED')
    expect(h.factory).not.toHaveBeenCalled()
    expect(adapter.getCapabilities()).toMatchObject({ supportsResume: false, supportsFork: false, supportsCostUsage: false })
  })

  it('preserves configuration after a rejected configure operation', () => {
    const h = fixture((emit, b) => emit(complete(b)))
    const adapter = new ClineAdapter(config, h.factory)
    expect(() => adapter.configure({ env: { NODE_OPTIONS: 'fixture' } })).toThrow()
    expect(() => adapter.execute({ prompt: 'test' })).not.toThrow()
    expect(h.factory).not.toHaveBeenCalled()
  })

  it('denies unknown responses and routes only exact pending permission IDs', async () => {
    const h = fixture((emit, b) => emit({ ...b, type: 'approval_request', requestId: 'request', toolName: 'read_file', toolCallId: 'call', action: '{"path":"file-a"}' }))
    const adapter = new ClineAdapter(config, h.factory)
    const stream = adapter.execute({ prompt: 'test' })
    await stream.next()
    const permission = (await stream.next()).value
    expect(permission).toMatchObject({ type: 'adapter:interaction_required', kind: 'permission' })
    expect(permission && 'question' in permission ? permission.question : '').toContain('file-a')
    if (!permission || permission.type !== 'adapter:interaction_required') throw new Error('missing permission')
    expect(adapter.respondInteraction('other', 'yes')).toBe(false)
    expect(adapter.respondInteraction(permission.interactionId, 'yes')).toBe(true)
    expect(adapter.respondInteraction(permission.interactionId, 'yes')).toBe(false)
    expect(h.sent).toContainEqual({ ...h.binding(), type: 'approval_response', requestId: 'request', approved: true })
    h.emit(complete(h.binding()))
    const rest = await collect(stream)
    expect(terminal(rest)).toHaveLength(1)
    expect(rest.filter(event => event.type === 'adapter:interaction_resolved')).toEqual([
      expect.objectContaining({ interactionId: permission.interactionId, answer: 'yes', resolvedBy: 'caller' }),
    ])
  })

  it('auto-denies by policy and never prompts the caller', async () => {
    const h = fixture((emit, b) => {
      emit({ ...b, type: 'approval_request', requestId: 'r', toolName: 'read_file', toolCallId: 'call', action: '{}' })
      emit(complete(b))
    })
    const events = await collect(new ClineAdapter({ ...config, interactionPolicy: { mode: 'auto-deny' } }, h.factory).execute({ prompt: 'test' }))
    expect(h.sent).toContainEqual({ ...h.binding(), type: 'approval_response', requestId: 'r', approved: false })
    expect(events.some(event => event.type === 'adapter:interaction_required')).toBe(false)
    expect(events.filter(event => event.type === 'adapter:interaction_resolved')).toEqual([
      expect.objectContaining({ answer: 'no', resolvedBy: 'auto-deny' }),
    ])
  })

  it('distinguishes same-name tool actions and resolves each once', async () => {
    const h = fixture((emit, b) => {
      emit({ ...b, type: 'approval_request', requestId: 'first', toolName: 'run_command', toolCallId: 'call-a', action: '{"command":"pwd"}' })
      emit({ ...b, type: 'approval_request', requestId: 'second', toolName: 'run_command', toolCallId: 'call-b', action: '{"command":"rm file-a"}' })
    })
    const adapter = new ClineAdapter(config, h.factory)
    const stream = adapter.execute({ prompt: 'test', correlationId: 'correlation' })
    await stream.next()
    const first = (await stream.next()).value
    if (!first || first.type !== 'adapter:interaction_required') throw new Error('missing first permission')
    expect(first.question).toContain('call-a'); expect(first.question).toContain('pwd')
    adapter.respondInteraction(first.interactionId, 'yes')
    expect((await stream.next()).value).toMatchObject({ type: 'adapter:interaction_resolved', resolvedBy: 'caller', correlationId: 'correlation' })
    const second = (await stream.next()).value
    if (!second || second.type !== 'adapter:interaction_required') throw new Error('missing second permission')
    expect(second.question).toContain('call-b'); expect(second.question).toContain('rm file-a')
    adapter.respondInteraction(second.interactionId, 'no')
    h.emit(complete(h.binding()))
    const rest = await collect(stream)
    expect(rest.filter(event => event.type === 'adapter:interaction_resolved')).toEqual([
      expect.objectContaining({ interactionId: second.interactionId, answer: 'no', correlationId: 'correlation' }),
    ])
  })

  it('wakes pending next on return, sends cancellation and shuts down once', async () => {
    const h = fixture()
    const stream = new ClineAdapter(config, h.factory).execute({ prompt: 'test' })
    await stream.next()
    const pending = stream.next()
    await flush()
    const returned = stream.return()
    await pending
    await returned
    expect(h.sent).toContainEqual({ ...h.binding(), type: 'cancel' })
    expect(h.shutdown).toHaveBeenCalledOnce()
  })

  it('interrupt cancels paused executions without requiring another next', async () => {
    const h = fixture()
    const adapter = new ClineAdapter(config, h.factory)
    const stream = adapter.execute({ prompt: 'test' })
    await stream.next()
    adapter.interrupt()
    await flush()
    expect(h.shutdown).toHaveBeenCalledOnce()
    expect(terminal(await collect(stream))).toMatchObject([{ code: 'CLINE_CANCELLED' }])
  })

  it('aborted input never spawns', async () => {
    const h = fixture()
    const controller = new AbortController()
    controller.abort()
    const events = await collect(new ClineAdapter(config, h.factory).execute({ prompt: 'test', signal: controller.signal }))
    expect(h.factory).not.toHaveBeenCalled()
    expect(terminal(events)).toMatchObject([{ code: 'CLINE_CANCELLED' }])
  })

  it('times out a pending read and observes a late factory result', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (value: Awaited<ReturnType<ClineTransportFactory>>) => void
      const shutdown = vi.fn(async () => undefined)
      const factory: ClineTransportFactory = () => new Promise(done => { resolve = done })
      const events = collect(new ClineAdapter({ ...config, timeoutMs: 20 }, factory).execute({ prompt: 'test' }))
      await vi.advanceTimersByTimeAsync(21)
      expect(terminal(await events)).toMatchObject([{ code: 'CLINE_TIMEOUT' }])
      resolve({ send: async () => undefined, shutdown })
      await flush()
      expect(shutdown).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it.each(['CLINE_WORKER_EXITED', 'CLINE_WORKER_DISCONNECTED', 'CLINE_WORKER_START_FAILED'])('fails once on %s', async code => {
    const h = fixture()
    const stream = new ClineAdapter(config, h.factory).execute({ prompt: 'test' })
    await stream.next()
    h.fail(code)
    expect(terminal(await collect(stream))).toMatchObject([{ code }])
    expect(h.shutdown).toHaveBeenCalledOnce()
  })

  it('rejects a wrong-session IPC event rather than leaking it', async () => {
    const h = fixture((emit, b) => emit({ ...b, sessionId: 'other', type: 'event', event: { kind: 'text', text: 'foreign' } }))
    expect(terminal(await collect(new ClineAdapter(config, h.factory).execute({ prompt: 'test' })))).toMatchObject([{ code: 'CLINE_IPC_INVALID' }])
  })

  it('enforces output frame and queue bounds', async () => {
    const h = fixture((emit, b) => {
      for (let n = 0; n <= CLINE_LIMITS.queue; n++) emit({ ...b, type: 'event', event: { kind: 'text', text: 'x' } })
    })
    expect(terminal(await collect(new ClineAdapter(config, h.factory).execute({ prompt: 'test' })))).toMatchObject([{ code: 'CLINE_OUTPUT_LIMIT' }])
    const oversized = fixture((emit, b) => emit({ ...b, type: 'event', event: { kind: 'text', text: 'x'.repeat(CLINE_LIMITS.frameBytes) } }))
    expect(terminal(await collect(new ClineAdapter(config, oversized.factory).execute({ prompt: 'test' })))).toMatchObject([{ code: 'CLINE_IPC_INVALID' }])
  })

  it('cancellation wins while a successful result waits for process shutdown', async () => {
    const h = fixture((emit, b) => emit(complete(b)))
    let release!: () => void
    h.shutdown.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const controller = new AbortController()
    const stream = new ClineAdapter(config, h.factory).execute({ prompt: 'test', signal: controller.signal })
    await stream.next()
    const pending = stream.next()
    await flush()
    controller.abort()
    release()
    expect((await pending).value).toMatchObject({ type: 'adapter:failed', code: 'CLINE_CANCELLED' })
    await stream.return()
  })

  it('bounds total output even when the consumer drains every individual frame', async () => {
    const h = fixture()
    const stream = new ClineAdapter(config, h.factory).execute({ prompt: 'test' })
    await stream.next()
    let last: AgentEvent | void = undefined
    for (let n = 0; n < 90; n++) {
      h.emit({ ...h.binding(), type: 'event', event: { kind: 'text', text: 'x'.repeat(100_000) } })
      last = (await stream.next()).value
      if (last?.type === 'adapter:failed') break
    }
    expect(last!).toMatchObject({ type: 'adapter:failed', code: 'CLINE_OUTPUT_LIMIT' })
    await stream.return()
  })

  it('keeps concurrent worker session bindings independent', async () => {
    const sessions: Array<{ binding: ClineBinding; emit(message: unknown): void }> = []
    const factory: ClineTransportFactory = async (binding, emit) => {
      sessions.push({ binding, emit })
      emit({ ...binding, type: 'ready' })
      return { send: async () => undefined, shutdown: async () => undefined }
    }
    const adapter = new ClineAdapter(config, factory)
    const first = adapter.execute({ prompt: 'one' })
    const second = adapter.execute({ prompt: 'two' })
    await first.next()
    await second.next()
    expect(sessions[0]!.binding.sessionId).not.toBe(sessions[1]!.binding.sessionId)
    sessions[0]!.emit(complete(sessions[1]!.binding))
    sessions[1]!.emit(complete(sessions[1]!.binding))
    expect(terminal(await collect(first))).toMatchObject([{ code: 'CLINE_IPC_INVALID' }])
    expect(terminal(await collect(second))).toMatchObject([{ type: 'adapter:completed' }])
  })
})
