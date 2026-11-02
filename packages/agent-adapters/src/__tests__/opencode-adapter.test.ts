import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentInput } from '../types.js'
import { OpenCodeAdapter, type OpenCodeAdapterConfig } from '../opencode/opencode-adapter.js'
import { OpenCodeEvents, usage } from '../opencode/opencode-events.js'
import { OpenCodeQueue, OpenCodeSessions, attachedEndpoint, subscribeEvents } from '../opencode/opencode-session.js'
import type { OpenCodeClient, OpenCodeEvent, OpenCodeMessage, OpenCodePart, OpenCodePromptResult, OpenCodeResult, OpenCodeSdk } from '../opencode/opencode-sdk-types.js'

const endpoint = 'http://127.0.0.1:4096'
const cwd = '/work/project'
const input = { prompt: 'hello' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type PromptOptions = Parameters<OpenCodeClient['session']['prompt']>[0]
function fixture(config: OpenCodeAdapterConfig = {}) {
  const streams: Array<{ emit: (event: OpenCodeEvent) => void; raw: (text: string) => void; end: () => void; cancel: ReturnType<typeof vi.fn> }> = []
  const prompts: Array<{ options: PromptOptions; pending: ReturnType<typeof deferred<OpenCodeResult<OpenCodePromptResult>>> }> = []
  const encoder = new TextEncoder()
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const raw = (text: string) => controller.enqueue(encoder.encode(text))
        streams.push({ emit: event => raw(`data: ${JSON.stringify(event)}\n\n`), raw, end: () => controller.close(), cancel })
        raw('data: {"type":"server.connected","properties":{}}\n\n')
      }, cancel,
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  let session = 0
  const client: OpenCodeClient = {
    tool: { ids: vi.fn(async () => ({ data: ['read', 'bash', 'write'] })) },
    session: {
      create: vi.fn(async () => ({ data: { id: `ses_${++session}`, directory: cwd } })),
      prompt: vi.fn((options: PromptOptions) => {
        const pending = deferred<OpenCodeResult<OpenCodePromptResult>>()
        prompts.push({ options, pending }); return pending.promise
      }),
      abort: vi.fn(async () => ({ data: true })),
    },
    // A native SDK SSE call would escape the injected transport in some SDK
    // versions. The adapter owns one no-retry bounded /event connection.
    event: { subscribe: vi.fn(async () => { throw new Error('Do not use SDK SSE transport') }) },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
  }
  const factory = vi.fn<OpenCodeSdk['createOpencodeClient']>(() => client)
  const loader = vi.fn(async () => ({ createOpencodeClient: factory }))
  const adapter = new OpenCodeAdapter({ baseUrl: endpoint, cwd, cleanupTimeoutMs: 20, ...config }, { loadSdk: loader, fetch: fetcher })
  const result = (index: number, patch: Partial<OpenCodePromptResult> = {}): OpenCodePromptResult => {
    const options = prompts[index]!.options
    const id = `assistant_${index}`
    return {
      info: { id, sessionID: options.path.id, role: 'assistant', parentID: options.body.messageID, time: { created: Date.now() }, tokens: { input: 7, output: 3 }, cost: 9 },
      parts: [{ id: 'text', sessionID: options.path.id, messageID: id, type: 'text', text: 'authoritative' }], ...patch,
    }
  }
  return { adapter, client, loader, factory, fetcher, prompts, streams, result,
    finish(index = 0, patch: Partial<OpenCodePromptResult> = {}) { prompts[index]!.pending.resolve({ data: result(index, patch) }) },
    message(index = 0, patch: Partial<OpenCodeMessage> = {}) { streams[index]!.emit({ type: 'message.updated', properties: { info: { ...result(index).info, ...patch } } }) },
    permission(index = 0, patch: Record<string, unknown> = {}) {
      streams[index]!.emit({ type: 'permission.updated', properties: { id: 'perm_1', sessionID: prompts[index]!.options.path.id, messageID: `assistant_${index}`, type: 'read', title: 'Read file?', time: { created: Date.now() }, ...patch } })
    },
  }
}
async function collect(iterator: AsyncIterable<AgentEvent>) { const out: AgentEvent[] = []; for await (const event of iterator) out.push(event); return out }
async function until(iterator: AsyncIterator<AgentEvent>, type: AgentEvent['type']) {
  for (let i = 0; i < 30; i++) { const next = await iterator.next(); if (next.done) throw new Error(`Missing ${type}`); if (next.value.type === type) return next.value }
  throw new Error(`Too many events before ${type}`)
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('OpenCode attached client admission', () => {
  it.each(['http://localhost:4096', 'https://127.0.0.1', 'http://192.0.2.1', 'http://127.0.0.1?x=1', 'http://127.0.0.1?', 'http://127.0.0.1#', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://0177.0.0.1'])('rejects unsafe endpoint %s before loading or effects', async baseUrl => {
    const f = fixture({ baseUrl }); const events = await collect(f.adapter.execute(input))
    expect(events).toHaveLength(1); expect(events[0]?.type).toBe('adapter:failed')
    expect(f.loader).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('accepts explicit numeric IPv4 and IPv6 loopback only', () => {
    expect(attachedEndpoint('http://127.2.3.4:12/')).toBe('http://127.2.3.4:12')
    expect(attachedEndpoint('http://[::1]:4096')).toBe('http://[::1]:4096')
    expect(attachedEndpoint('http://[0:0:0:0:0:0:0:1]')).toBe('http://[::1]')
  })
  it.each<OpenCodeAdapterConfig>([{ mode: 'owned' }, { cwd: undefined }, { cwd: 'relative' }, { sandboxMode: 'read-only' }, { env: {} }, { apiKey: 'unused' }, { providerOptions: {} }, { reasoning: 'high' }, { timeoutMs: NaN }])('denies unsupported config before effects: %j', async config => {
    const f = fixture(config); expect((await collect(f.adapter.execute(input)))[0]?.type).toBe('adapter:failed'); expect(f.loader).not.toHaveBeenCalled()
  })
  it.each<Partial<AgentInput>>([
    { maxTurns: 0 }, { maxBudgetUsd: 0 }, { outputSchema: {} }, { options: { networkAccess: false } },
    { policyContext: { activePolicy: { networkAccess: false } } }, { policyContext: { activePolicy: { sandboxMode: 'read-only' } } },
    { policyContext: { activePolicy: { maxBudgetUsd: 1 } } }, { policyContext: { activePolicy: { maxTurns: 1 } } },
    { options: { interactionPolicy: { mode: 'ai-autonomous' } } }, { options: { interactionPolicy: { mode: 'ask-caller', askCaller: { timeoutFallback: 'auto-approve' } } } },
    { executionControlRequirement: { schema: 'dzupagent/adapter-execution-control-requirement/v1', tools: { mode: 'none' } } },
  ])('denies unsupported per-turn controls before effects: %j', async patch => {
    const f = fixture(); await collect(f.adapter.execute({ ...input, ...patch })); expect(f.loader).not.toHaveBeenCalled()
  })
  it('reports optional dependency failure without a provider call', async () => {
    const loader = vi.fn(async () => { throw new Error('ADAPTER_SDK_NOT_INSTALLED') })
    const adapter = new OpenCodeAdapter({ baseUrl: endpoint, cwd }, { loadSdk: loader })
    const events = await collect(adapter.execute(input))
    expect(events[0]).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_SDK_NOT_INSTALLED' })
    expect(await adapter.healthCheck()).toMatchObject({ healthy: false, sdkInstalled: false })
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('requires an owned session at exactly the same endpoint and cwd before loading', async () => {
    const f = fixture(); await collect(f.adapter.resumeSession('foreign', input)); expect(f.loader).not.toHaveBeenCalled()
  })
})

describe('OpenCode request and authoritative response', () => {
  it('passes faithful SDK arguments, disables every unselected inventory tool and never uses SDK SSE or lifecycle APIs', async () => {
    const f = fixture({ allowedTools: ['read', 'bash'], model: 'provider/model' })
    expect(f.loader).not.toHaveBeenCalled()
    const run = f.adapter.execute({ ...input, systemPrompt: 'system', options: { blockedTools: ['bash'] } })
    expect((await run.next()).value).toMatchObject({ type: 'adapter:started', sessionId: 'ses_1' })
    expect(f.factory).toHaveBeenCalledWith({ baseUrl: endpoint, directory: cwd, fetch: expect.any(Function) })
    expect(f.client.tool.ids).toHaveBeenCalledWith({ query: { directory: cwd }, signal: expect.any(AbortSignal), throwOnError: true })
    expect(f.prompts[0]!.options).toMatchObject({ path: { id: 'ses_1' }, query: { directory: cwd }, body: {
      parts: [{ type: 'text', text: 'hello' }], tools: { read: true, bash: false, write: false }, system: 'system', model: { providerID: 'provider', modelID: 'model' }, messageID: expect.stringMatching(/^msg_/) } })
    expect(new URL((f.fetcher.mock.calls[0]![0] as Request).url).searchParams.get('directory')).toBe(cwd)
    f.finish(); const rest = await collect(run)
    expect(rest.filter(e => e.type === 'adapter:completed')).toHaveLength(1)
    expect(rest.at(-1)).toMatchObject({ type: 'adapter:completed', result: 'authoritative', usage: { inputTokens: 7, outputTokens: 3 } })
    expect(rest.at(-1)).not.toHaveProperty('usage.costCents')
    expect(f.client.session.abort).not.toHaveBeenCalled()
    expect(f.client.event.subscribe).not.toHaveBeenCalled()
    expect(f.streams[0]!.cancel).toHaveBeenCalledTimes(1)
  })
  it('defaults to zero selected tools and rejects unknown inventory IDs before creating a session', async () => {
    const f = fixture({ allowedTools: ['missing'] }); const events = await collect(f.adapter.execute(input))
    expect(events.at(-1)?.type).toBe('adapter:failed'); expect(f.client.session.create).not.toHaveBeenCalled()
    const g = fixture(); const run = g.adapter.execute(input); await run.next()
    expect(g.prompts[0]!.options.body.tools).toEqual({ read: false, bash: false, write: false }); g.finish(); await collect(run)
  })
  it('deduplicates streamed tools and final parts; streamed text and usage cannot override prompt response', async () => {
    const f = fixture({ allowedTools: ['read'] }); const run = f.adapter.execute(input); await run.next(); f.message()
    const part: OpenCodePart = { id: 'tool', messageID: 'assistant_0', sessionID: 'ses_1', type: 'tool', callID: 'call', tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'ok', time: { start: 1, end: 3 } } }
    f.streams[0]!.emit({ type: 'message.part.updated', properties: { part } })
    f.streams[0]!.emit({ type: 'message.part.updated', properties: { part } })
    const live = [await run.next(), await run.next()]
    expect(live.map(x => x.value?.type)).toEqual(['adapter:tool_call', 'adapter:tool_result'])
    f.streams[0]!.emit({ type: 'message.part.updated', properties: { part: { ...part, type: 'text', text: 'wrong' } } })
    const text = f.result(0).parts[0]!
    f.finish(0, { parts: [part, part, text, text] }); const rest = await collect(run)
    expect(rest.filter(e => e.type === 'adapter:tool_call' || e.type === 'adapter:tool_result')).toHaveLength(0)
    expect(rest.filter(e => e.type === 'adapter:stream_delta')).toEqual([expect.objectContaining({ content: 'authoritative' })])
  })
  it.each(['session', 'parent', 'error', 'part'])('fails mismatched or failed prompt response (%s) once without replay', async fault => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next(); const result = f.result(0)
    if (fault === 'session') result.info.sessionID = 'foreign'
    if (fault === 'parent') result.info.parentID = 'old'
    if (fault === 'error') result.info.error = { name: 'APIError', data: { message: 'private data' } }
    if (fault === 'part') result.parts[0]!.sessionID = 'foreign'
    f.prompts[0]!.pending.resolve({ data: result }); const rest = await collect(run)
    expect(rest.filter(e => e.type === 'adapter:failed')).toHaveLength(1); expect(rest.filter(e => e.type === 'adapter:completed')).toHaveLength(0)
    expect(JSON.stringify(rest)).not.toContain('private data'); expect(f.client.session.prompt).toHaveBeenCalledTimes(1); expect(f.client.session.abort).toHaveBeenCalledTimes(1)
  })
  it('does not leak upstream transport errors and never replays a prompt', async () => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next(); f.prompts[0]!.pending.reject(new Error('private credential'))
    const events = await collect(run); expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', error: 'OpenCode prompt failed' }); expect(f.client.session.prompt).toHaveBeenCalledTimes(1)
  })
  it('handles an SDK error envelope without dispatching a prompt', async () => {
    const f = fixture(); vi.mocked(f.client.tool.ids).mockResolvedValue({ error: { message: 'private details' } })
    const events = await collect(f.adapter.execute(input))
    expect(events).toEqual([expect.objectContaining({ type: 'adapter:failed', error: 'OpenCode request failed' })])
    expect(f.client.session.create).not.toHaveBeenCalled(); expect(f.client.session.prompt).not.toHaveBeenCalled()
  })
  it('aborts a newly created session at a mismatched cwd without dispatching', async () => {
    const f = fixture(); vi.mocked(f.client.session.create).mockResolvedValue({ data: { id: 'ses_other_cwd', directory: '/wrong' } })
    const events = await collect(f.adapter.execute(input))
    expect(events.at(-1)?.type).toBe('adapter:failed'); expect(f.client.session.prompt).not.toHaveBeenCalled()
    expect(f.client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'ses_other_cwd' } }))
  })
  it.each([undefined, { input: -1, output: 1 }, { input: NaN, output: 1 }, { input: 1, output: Infinity }, { input: 1.5, output: 1 }])('keeps unknown or invalid usage unknown: %j', tokens => {
    expect(usage({ id: 'a', sessionID: 's', role: 'assistant', time: { created: 0 }, tokens, cost: 10 })).toBeUndefined()
  })
})

describe('OpenCode permissions and cancellation', () => {
  it.each([['yes', 'once'], ['no', 'reject'], ['always', 'reject']])('answers %s with %s, only once', async (answer, response) => {
    const f = fixture({ allowedTools: ['read'] }); const run = f.adapter.execute(input); await run.next(); f.message(); f.permission()
    const required = await until(run, 'adapter:interaction_required')
    if (required.type !== 'adapter:interaction_required') throw new Error('missing interaction')
    expect(f.adapter.respondInteraction(required.interactionId, answer)).toBe(true)
    expect(f.adapter.respondInteraction(required.interactionId, 'yes')).toBe(false)
    expect((await run.next()).value?.type).toBe('adapter:interaction_resolved')
    f.permission(); f.finish(); await collect(run)
    expect(f.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    expect(f.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'ses_1', permissionID: 'perm_1' }, body: { response } }))
  })
  it('auto-denies tools outside the explicit allowlist even under auto-approve', async () => {
    const f = fixture({ interactionPolicy: { mode: 'auto-approve' } }); const run = f.adapter.execute(input); await run.next(); f.message(); f.permission()
    expect(await until(run, 'adapter:interaction_resolved')).toMatchObject({ answer: 'reject' }); f.finish(); await collect(run)
  })
  it('rejects cross-session, stale-parent and stale-time permission events', async () => {
    const f = fixture({ allowedTools: ['read'] }); const run = f.adapter.execute(input); await run.next()
    f.message(0, { parentID: 'old' }); f.permission()
    f.message(); f.permission(0, { sessionID: 'foreign' }); f.permission(0, { time: { created: 0 } })
    f.finish(); const rest = await collect(run)
    expect(rest.some(e => e.type === 'adapter:interaction_required')).toBe(false); expect(f.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
  })
  it('cancellation beats a caller approval and uses an independent cleanup signal', async () => {
    const f = fixture({ allowedTools: ['read'] }); const signal = new AbortController(); const run = f.adapter.execute({ ...input, signal: signal.signal }); await run.next(); f.message(); f.permission()
    const required = await until(run, 'adapter:interaction_required'); if (required.type !== 'adapter:interaction_required') throw new Error('missing interaction')
    expect(f.adapter.respondInteraction(required.interactionId, 'yes')).toBe(true); signal.abort()
    const rest = await collect(run); expect(rest.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_CANCELLED' })
    expect(f.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'reject' } }))
    expect(f.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'once' } }))
    const abortSignal = vi.mocked(f.client.session.abort).mock.calls[0]![0].signal
    expect(abortSignal).not.toBe(f.prompts[0]!.options.signal); expect(abortSignal.aborted).toBe(false)
  })
  it('return interrupts a pending next and closes SSE plus the session', async () => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next()
    const pending = run.next(); const closing = run.return()
    expect((await pending).value).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_CANCELLED' }); expect((await closing).done).toBe(true)
    expect(f.client.session.abort).toHaveBeenCalledTimes(1); expect(f.streams[0]!.cancel).toHaveBeenCalledTimes(1)
  })
  it('interrupt cancels active turns without waiting for an upstream prompt', async () => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next(); f.adapter.interrupt(); const rest = await collect(run)
    expect(rest.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_CANCELLED' }); expect(f.client.session.abort).toHaveBeenCalledTimes(1)
  })
  it('a pre-aborted run has no effects', async () => {
    const f = fixture(); const signal = new AbortController(); signal.abort(); await collect(f.adapter.execute({ ...input, signal: signal.signal })); expect(f.loader).not.toHaveBeenCalled()
  })
  it('aborts a creation that settles after cancellation without replay', async () => {
    const f = fixture(); const creation = deferred<OpenCodeResult<{ id: string; directory: string }>>()
    const called = deferred<void>()
    vi.mocked(f.client.session.create).mockImplementation(() => { called.resolve(); return creation.promise })
    const controller = new AbortController(); const running = collect(f.adapter.execute({ ...input, signal: controller.signal }))
    await called.promise; controller.abort(); expect((await running).at(-1)?.type).toBe('adapter:failed')
    creation.resolve({ data: { id: 'ses_late', directory: cwd } })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(f.client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'ses_late' } }))
    expect(f.client.session.create).toHaveBeenCalledTimes(1); expect(f.client.session.prompt).not.toHaveBeenCalled()
  })
  it('times out a hung prompt and bounds a hung cleanup independently', async () => {
    vi.useFakeTimers(); const f = fixture({ timeoutMs: 50, cleanupTimeoutMs: 10 })
    vi.mocked(f.client.session.abort).mockImplementation(() => new Promise(() => undefined))
    const run = f.adapter.execute(input); await run.next(); const rest = collect(run)
    await vi.advanceTimersByTimeAsync(61); expect((await rest).at(-1)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_CANCELLED' })
    expect(f.client.session.abort).toHaveBeenCalledTimes(1)
  })
  it('permission timeout always rejects', async () => {
    vi.useFakeTimers(); const f = fixture({ allowedTools: ['read'], interactionPolicy: { mode: 'ask-caller', askCaller: { timeoutMs: 10 } } })
    const run = f.adapter.execute(input); await run.next(); f.message(); f.permission(); await until(run, 'adapter:interaction_required')
    const waiting = run.next(); await vi.advanceTimersByTimeAsync(11)
    expect((await waiting).value).toMatchObject({ type: 'adapter:interaction_resolved', answer: 'reject', resolvedBy: 'timeout-fallback' }); f.finish(); await collect(run)
  })
})

describe('OpenCode session isolation and bounds', () => {
  it('serializes continuations of an owned session and rejects endpoint/cwd changes', async () => {
    const f = fixture(); const initial = f.adapter.execute(input); await initial.next(); f.finish(); await collect(initial)
    const first = f.adapter.resumeSession('ses_1', input); await first.next()
    const second = f.adapter.resumeSession('ses_1', input); const secondStarted = second.next()
    await Promise.resolve(); expect(f.prompts).toHaveLength(2)
    f.finish(1); await collect(first); expect((await secondStarted).value?.type).toBe('adapter:started')
    expect(f.prompts).toHaveLength(3); f.finish(2); await collect(second)
    f.adapter.configure({ baseUrl: 'http://127.0.0.1:4097' }); expect((await collect(f.adapter.resumeSession('ses_1', input)))[0]?.type).toBe('adapter:failed')
    f.adapter.configure({ baseUrl: endpoint }); expect((await collect(f.adapter.resumeSession('ses_1', { ...input, workingDirectory: '/elsewhere' })))[0]?.type).toBe('adapter:failed')
    expect(f.prompts).toHaveLength(3)
  })
  it('cancelling a queued continuation does not abort the active session', async () => {
    const f = fixture(); const initial = f.adapter.execute(input); await initial.next(); f.finish(); await collect(initial)
    const active = f.adapter.resumeSession('ses_1', input); await active.next()
    const controller = new AbortController(); const queued = collect(f.adapter.resumeSession('ses_1', { ...input, signal: controller.signal }))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    controller.abort(); await queued
    expect(f.client.session.abort).not.toHaveBeenCalled()
    f.finish(1); await collect(active)
  })
  it('retires uncertain sessions instead of permitting replay after a failed abort', async () => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next(); await run.return()
    expect((await collect(f.adapter.resumeSession('ses_1', input)))[0]?.type).toBe('adapter:failed')
    expect(f.prompts).toHaveLength(1)
  })
  it('fails on oversized output and closes the transport', async () => {
    const f = fixture({ maxOutputBytes: 128 }); const run = f.adapter.execute(input); await run.next()
    const result = f.result(0); result.parts[0]!.text = 'x'.repeat(200); f.finish(0, result)
    expect((await collect(run)).at(-1)).toMatchObject({ type: 'adapter:failed', error: 'OpenCode output limit exceeded' }); expect(f.client.session.abort).toHaveBeenCalledTimes(1)
  })
  it('fails closed when the event subscription ends before prompt response', async () => {
    const f = fixture(); const run = f.adapter.execute(input); await run.next(); f.streams[0]!.end()
    expect((await collect(run)).at(-1)?.type).toBe('adapter:failed'); expect(f.client.session.prompt).toHaveBeenCalledTimes(1)
  })
  it('aborts on a full event queue even when the caller pauses at started', async () => {
    const f = fixture({ maxQueuedEvents: 1 }); const run = f.adapter.execute(input); await run.next()
    f.streams[0]!.emit({ type: 'session.idle', properties: { sessionID: 'foreign' } })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const rest = await collect(run)
    expect(rest.at(-1)).toMatchObject({ type: 'adapter:failed', error: 'OpenCode event queue overflow' })
    expect(f.client.session.abort).toHaveBeenCalledTimes(1)
  })
  it('bounds raw response bytes and rejects requests outside the attached endpoint', async () => {
    const f = fixture({ maxOutputBytes: 128 }); const run = f.adapter.execute(input); await run.next()
    const fetcher = f.factory.mock.calls[0]![0].fetch
    await expect(fetcher('http://192.0.2.1/')).rejects.toThrow('escaped')
    f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(129)))
    const response = await fetcher(`${endpoint}/session`)
    await expect(response.text()).rejects.toThrow('byte limit')
    await run.return()
  })
  it('bounds a fetch that ignores cancellation and cancels its late response', async () => {
    vi.useFakeTimers(); const f = fixture({ requestTimeoutMs: 20 }); const run = f.adapter.execute(input); await run.next()
    const pending = deferred<Response>(); f.fetcher.mockImplementationOnce(() => pending.promise)
    const request = f.factory.mock.calls[0]![0].fetch(`${endpoint}/session`)
    const rejected = expect(request).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(21); await rejected
    const cancel = vi.fn(); pending.resolve(new Response(new ReadableStream({ cancel })))
    await Promise.resolve(); expect(cancel).toHaveBeenCalledTimes(1)
    await run.return()
  })
  it('bounds queued events and message tracking', async () => {
    const queue = new OpenCodeQueue<number>(1); queue.push(1); queue.push(2)
    await expect(queue.next(new AbortController().signal)).rejects.toThrow('overflow')
    const events = new OpenCodeEvents('s', 'p', 0, 10, new Set())
    expect(() => events.acceptMessage({ id: 'long-identifier', sessionID: 's', parentID: 'p', role: 'assistant', time: { created: 0 } })).toThrow('limit')
  })
  it('bounds concurrent resume waiters without losing serialization on cancellation', async () => {
    const sessions = new OpenCodeSessions(); sessions.add('s', endpoint, cwd)
    const controller = new AbortController(); const release = await sessions.lock('s', endpoint, cwd, controller.signal)
    const waiters = Array.from({ length: 15 }, () => sessions.lock('s', endpoint, cwd, controller.signal))
    await expect(sessions.lock('s', endpoint, cwd, controller.signal)).rejects.toThrow('queue full')
    controller.abort(); await Promise.allSettled(waiters); release()
    const next = await sessions.lock('s', endpoint, cwd, new AbortController().signal); next()
  })
  it('parses fragmented multiline SSE and closes on cancellation without reconnect', async () => {
    const controller = new AbortController(); const encoder = new TextEncoder(); const cancel = vi.fn()
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(encoder.encode(': comment\r\ndata: {"type":\r\n'))
      stream.enqueue(encoder.encode('data: "server.connected","properties":{}}\r\n\r\n'))
    }, cancel }), { headers: { 'content-type': 'text/event-stream' } }))
    const stream = subscribeEvents(fetcher, endpoint, cwd, controller.signal, 1024)
    expect((await stream.next()).value).toMatchObject({ type: 'server.connected' })
    const pending = stream.next(); controller.abort(); await expect(pending).rejects.toThrow('cancelled'); expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
