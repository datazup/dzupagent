import { describe, expect, it, vi } from 'vitest'
import { guardClineRuntimeSdk, runClineWorker } from '../cline/cline-worker.js'
import type { ClineCoreInstance, ClineSdk } from '../cline/cline-sdk-types.js'
import { clineStreamEvent, clineUsage } from '../cline/cline-events.js'
import { clineChildEnv } from '../cline/cline-worker-transport.js'
import type { ClineBinding, ClineChildMessage, ClineStart } from '../cline/cline-worker-protocol.js'
import { CLINE_LIMITS, ClineQueue, isChildMessage, isParentMessage } from '../cline/cline-worker-protocol.js'

const binding: ClineBinding = { version: 1, runId: 'run', sessionId: 'session' }
const start: ClineStart = { ...binding, type: 'start', profileDir: '/provisioned-profile', cwd: '/workspace',
  provider: 'anthropic', model: 'model', prompt: 'hello', systemPrompt: 'system', enableTools: true, approvalTimeoutMs: 50 }
const success = { sessionId: 'session', result: { text: 'answer', finishReason: 'completed', usage: { inputTokens: 3, outputTokens: 4 } } }
it('strips unapprovable provider-native tools while retaining local tools and shutdown', async () => {
  const shutdown = vi.fn(async () => undefined)
  let build: ((input: unknown) => Promise<{ tools: unknown[]; modelTools?: unknown[]; shutdown(reason: string): void | Promise<void> }>) | undefined
  const core = coreFixture().core
  const sdk = guardClineRuntimeSdk({
    resolveSessionBackend: async () => ({}),
    DefaultRuntimeBuilder: class { async build() { return { tools: ['local-tool'], modelTools: ['web_search', 'image_generation'], shutdown } } },
    LocalRuntimeHost: class {
      constructor(options: { runtimeBuilder: { build: NonNullable<typeof build> } }) { build = options.runtimeBuilder.build }
      startSession = core.start
      stopSession = core.stop
      subscribe = core.subscribe
      dispose = core.dispose
    },
  })
  await sdk.ClineCore.create({ backendMode: 'local', automation: false, clientName: 'test', distinctId: 'run',
    toolPolicies: {}, capabilities: { requestToolApproval: async () => ({ approved: false }) } })
  const built = await build!({})
  expect(built.modelTools).toEqual([])
  expect(built.tools).toEqual(['local-tool'])
  expect(built.shutdown).toBe(shutdown)
})
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve() }
function harness(core: ClineCoreInstance, loader?: () => Promise<ClineSdk>) {
  const output: ClineChildMessage[] = []
  let receive!: (message: unknown) => void
  const loadSdk = vi.fn(loader ?? (async () => ({ ClineCore: { create: vi.fn(async () => core) } })))
  const worker = runClineWorker({ send: async message => { output.push(message) },
    onMessage(listener) { receive = listener; return vi.fn() } }, binding, '/private-home', { loadSdk })
  return { worker, output, loadSdk, receive: (message: unknown) => receive(message) }
}
function coreFixture() {
  let emit!: Parameters<ClineCoreInstance['subscribe']>[0]
  const unsubscribe = vi.fn()
  const core: ClineCoreInstance = {
    subscribe: vi.fn(listener => { emit = listener; return unsubscribe }),
    start: vi.fn(async () => success), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
  }
  return { core, unsubscribe, emit: (event: Parameters<typeof emit>[0]) => emit(event) }
}
function terminals(output: ClineChildMessage[]) { return output.filter(item => item.type === 'result' || item.type === 'fatal') }

describe('Cline isolated worker', () => {
  it('faithfully supplies the 0.2.0 local arguments and subscribes before start', async () => {
    const fixture = coreFixture()
    fixture.core.start = vi.fn(async input => {
      expect(fixture.core.subscribe).toHaveBeenCalledWith(expect.any(Function), { sessionId: 'session' })
      fixture.emit({ type: 'agent_event', payload: { sessionId: 'session', event: { type: 'content_start', contentType: 'text', text: 'delta' } } })
      expect(input).toEqual({
        config: { sessionId: 'session', cwd: '/workspace', workspaceRoot: '/workspace', providerId: 'anthropic', modelId: 'model',
          systemPrompt: 'system', mode: 'act', enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
          disableMcpSettingsTools: true, mcpApps: false, yolo: false, pluginPaths: [], agentPluginPaths: [], extensions: [],
          skills: [], checkpoint: { enabled: false }, compaction: { enabled: false }, toolPolicies: { '*': { enabled: true, autoApprove: false } } },
        prompt: 'hello', interactive: false, localRuntime: { configExtensions: [], extensions: [], extraTools: [] },
        plugins: { '*': { enabled: false } }, toolPolicies: { '*': { enabled: true, autoApprove: false } },
        capabilities: { requestToolApproval: expect.any(Function) },
      })
      return success
    })
    const create = vi.fn(async () => fixture.core)
    const h = harness(fixture.core, async () => ({ ClineCore: { create } }))
    h.receive(start)
    await h.worker.done
    expect(create).toHaveBeenCalledWith({ backendMode: 'local', automation: false, clientName: 'dzupagent-cline', distinctId: 'run',
      toolPolicies: { '*': { enabled: true, autoApprove: false } }, capabilities: { requestToolApproval: expect.any(Function) } })
    expect(h.output.map(item => item.type)).toEqual(['ready', 'event', 'result'])
    expect(terminals(h.output)).toEqual([{ ...binding, type: 'result', success: true, text: 'answer', reason: 'completed', usage: { inputTokens: 3, outputTokens: 4 } }])
    expect(fixture.core.stop).toHaveBeenCalledWith('session')
    expect(fixture.core.dispose).toHaveBeenCalledOnce()
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['error', 'aborted', 'max_iterations', 'mistake_limit'])('does not label %s as completion', async finishReason => {
    const { core } = coreFixture()
    core.start = vi.fn(async () => ({ ...success, result: { ...success.result, finishReason } }))
    const h = harness(core)
    h.receive(start)
    await h.worker.done
    expect(terminals(h.output)).toMatchObject([{ type: 'result', success: false }])
  })

  it('does not infer success from done/ended events or missing start result', async () => {
    const fixture = coreFixture()
    fixture.core.start = vi.fn(async () => {
      fixture.emit({ type: 'ended', payload: { sessionId: 'session', reason: 'completed' } })
      fixture.emit({ type: 'agent_event', payload: { sessionId: 'session', event: { type: 'done', reason: 'completed' } } })
      return { sessionId: 'session' }
    })
    const h = harness(fixture.core)
    h.receive(start)
    await h.worker.done
    expect(terminals(h.output)).toMatchObject([{ type: 'result', success: false }])
  })

  it('rejects mismatched session results and discards foreign/delegated events', async () => {
    const fixture = coreFixture()
    fixture.core.start = vi.fn(async () => {
      for (const payload of [
        { sessionId: 'other', event: { type: 'content_start', contentType: 'text', text: 'foreign' } },
        { sessionId: 'session', teamRole: 'teammate', event: { type: 'content_start', contentType: 'text', text: 'foreign' } },
        { sessionId: 'session', event: { type: 'content_start', contentType: 'text', parentAgentId: 'parent', text: 'foreign' } },
      ]) fixture.emit({ type: 'agent_event', payload })
      return { ...success, sessionId: 'other' }
    })
    const h = harness(fixture.core)
    h.receive(start)
    await h.worker.done
    expect(h.output.filter(item => item.type === 'event')).toEqual([])
    expect(terminals(h.output)).toMatchObject([{ type: 'fatal', code: 'CLINE_SESSION_MISMATCH' }])
  })

  it.each([true, false])('routes an exact approval response (%s), once only', async approved => {
    const { core } = coreFixture()
    const observed: boolean[] = []
    core.start = vi.fn(async input => {
      const answer = await input.capabilities.requestToolApproval({ sessionId: 'session', agentId: 'a', conversationId: 'c', iteration: 1,
        toolCallId: 'call', toolName: 'read_file', input: {}, policy: {} })
      observed.push(answer.approved)
      return success
    })
    const h = harness(core)
    h.receive(start)
    await flush()
    const request = h.output.find(item => item.type === 'approval_request')!
    expect(request.type).toBe('approval_request')
    expect(request).toMatchObject({ toolCallId: 'call', action: '{}' })
    if (request.type !== 'approval_request') throw new Error('missing approval')
    h.receive({ ...binding, type: 'approval_response', requestId: request.requestId, approved })
    h.receive({ ...binding, type: 'approval_response', requestId: request.requestId, approved: !approved })
    await h.worker.done
    expect(observed).toEqual([approved])
    expect(terminals(h.output)).toHaveLength(1)
  })

  it('denies approvals on cancellation, including a late approval', async () => {
    const { core } = coreFixture()
    let answer: boolean | undefined
    core.start = vi.fn(async input => {
      answer = (await input.capabilities.requestToolApproval({ sessionId: 'session', agentId: 'a', conversationId: 'c', iteration: 1,
        toolCallId: 'call', toolName: 'read_file', input: {}, policy: {} })).approved
      return success
    })
    const h = harness(core)
    h.receive(start)
    await flush()
    const request = h.output.find(item => item.type === 'approval_request')!
    h.receive({ ...binding, type: 'cancel' })
    if (request.type === 'approval_request') h.receive({ ...binding, type: 'approval_response', requestId: request.requestId, approved: true })
    await h.worker.done
    expect(answer).toBe(false)
    expect(terminals(h.output)).toMatchObject([{ type: 'fatal', code: 'CLINE_CANCELLED' }])
  })

  it('denies an unanswered permission at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const { core } = coreFixture()
      let answer: boolean | undefined
      core.start = vi.fn(async input => {
        answer = (await input.capabilities.requestToolApproval({ sessionId: 'session', agentId: 'a', conversationId: 'c', iteration: 1,
          toolCallId: 'call', toolName: 'read_file', input: {}, policy: {} })).approved
        return success
      })
      const h = harness(core)
      h.receive(start)
      await flush()
      await vi.advanceTimersByTimeAsync(51)
      await h.worker.done
      expect(answer).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('cancels during optional dependency loading without creating a session', async () => {
    const { core } = coreFixture()
    let resolve!: (sdk: ClineSdk) => void
    const create = vi.fn(async () => core)
    const h = harness(core, () => new Promise(done => { resolve = done }))
    h.receive(start)
    h.receive({ ...binding, type: 'cancel' })
    resolve({ ClineCore: { create } })
    await h.worker.done
    expect(create).not.toHaveBeenCalled()
    expect(terminals(h.output)).toMatchObject([{ type: 'fatal', code: 'CLINE_CANCELLED' }])
  })

  it('sanitizes dependency exceptions and observes cleanup rejection', async () => {
    const { core } = coreFixture()
    core.start = vi.fn(async () => { throw new Error('private diagnostic') })
    core.stop = vi.fn(async () => { throw new Error('stop failure') })
    core.dispose = vi.fn(async () => { throw new Error('dispose failure') })
    const h = harness(core)
    h.receive(start)
    await h.worker.done
    expect(terminals(h.output)).toEqual([{ ...binding, type: 'fatal', code: 'CLINE_SDK_FAILED' }])
    const missing = harness(core, async () => { throw new Error('Cannot find @cline/sdk') })
    missing.receive(start)
    await missing.worker.done
    expect(terminals(missing.output)).toEqual([{ ...binding, type: 'fatal', code: 'CLINE_SDK_FAILED' }])
  })

  it('bounds hung stop/dispose without an unhandled terminal promise', async () => {
    vi.useFakeTimers()
    try {
      const { core } = coreFixture()
      core.stop = vi.fn(() => new Promise(() => undefined))
      core.dispose = vi.fn(() => new Promise(() => undefined))
      const h = harness(core)
      h.receive(start)
      await flush()
      await vi.advanceTimersByTimeAsync(401)
      await h.worker.done
      expect(terminals(h.output)).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('bounds queued worker IPC sends and fails closed on overflow', async () => {
    const fixture = coreFixture()
    fixture.core.start = vi.fn(async () => {
      for (let n = 0; n < 100; n++) fixture.emit({ type: 'agent_event', payload: { sessionId: 'session',
        event: { type: 'content_start', contentType: 'text', text: 'delta' } } })
      await flush()
      return success
    })
    const h = harness(fixture.core)
    h.receive(start)
    await h.worker.done
    expect(h.output.filter(item => item.type === 'event').length).toBeLessThanOrEqual(32)
    expect(terminals(h.output)).toMatchObject([{ type: 'fatal', code: 'CLINE_IPC_BACKPRESSURE' }])
  })

  it('rejects relative paths before loading the optional SDK', async () => {
    const { core } = coreFixture()
    const h = harness(core)
    h.receive({ ...start, cwd: 'relative' })
    await h.worker.done
    expect(h.loadSdk).not.toHaveBeenCalled()
    expect(terminals(h.output)).toMatchObject([{ type: 'fatal', code: 'CLINE_ABSOLUTE_PATH_REQUIRED' }])
  })
})

describe('Cline protocol and event boundaries', () => {
  it('does not inherit auth, proxies, NODE_OPTIONS, CLINE config or arbitrary env', () => {
    expect(clineChildEnv({ PATH: '/bin', LANG: 'C', NODE_OPTIONS: '--require=unsafe', HTTP_PROXY: 'unsafe',
      ANTHROPIC_API_KEY: 'fixture-only', CLINE_DIR: '/wrong', HOME: '/wrong', CUSTOM: 'wrong' }, '/private')).toEqual({
      PATH: '/bin', LANG: 'C', HOME: '/private', XDG_CONFIG_HOME: '/private/config', XDG_CACHE_HOME: '/private/cache',
      XDG_DATA_HOME: '/private/data', XDG_STATE_HOME: '/private/state', TMPDIR: '/private/tmp', TMP: '/private/tmp', TEMP: '/private/tmp',
    })
  })
  it('rejects oversized, unknown-version, unexpected-field and malformed frames', () => {
    expect(isParentMessage(start)).toBe(true)
    expect(isParentMessage({ ...start, version: 2 })).toBe(false)
    expect(isParentMessage({ ...start, apiKey: 'fixture-only' })).toBe(false)
    expect(isParentMessage({ ...start, prompt: 'x'.repeat(CLINE_LIMITS.frameBytes) })).toBe(false)
    expect(isChildMessage({ ...binding, type: 'result', success: true, text: '', reason: 'completed', usage: { inputTokens: -1, outputTokens: 0 } })).toBe(false)
    expect(isChildMessage({ ...binding, type: 'event', event: { kind: 'tool_result', name: 'x', id: 'a', output: '', durationMs: NaN, isError: false } })).toBe(false)
  })
  it('bounds queues and wakes pending readers on close', async () => {
    const queue = new ClineQueue<number>()
    for (let i = 0; i < CLINE_LIMITS.queue; i++) expect(queue.push(i)).toBe(true)
    expect(queue.push(999)).toBe(false)
    const empty = new ClineQueue<number>()
    const pending = empty.next()
    empty.close()
    await expect(pending).resolves.toBeUndefined()
    expect(empty.push(1)).toBe(false)
  })
  it.each([undefined, {}, { inputTokens: 0 }, { inputTokens: NaN, outputTokens: 1 }, { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 1 }, { inputTokens: 1, outputTokens: Infinity }, { inputTokens: 1, outputTokens: 2, cacheReadTokens: -1 }])('preserves unknown/invalid usage as unknown: %j', usage => {
    expect(clineUsage(usage)).toBeUndefined()
  })
  it('keeps valid zero counts and cache metrics, omitting unverified cost', () => {
    expect(clineUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 3, totalCost: 10 }))
      .toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 2, cacheWriteTokens: 3 })
  })
  it('normalizes tool error events without treating them as session completion', () => {
    expect(clineStreamEvent({ type: 'agent_event', payload: { sessionId: 'session', event: {
      type: 'content_end', contentType: 'tool', toolName: 'read_file', toolCallId: 't', output: 'bad', error: 'failed', durationMs: 2,
    } } }, 'session')).toEqual({ kind: 'tool_result', name: 'read_file', id: 't', output: 'bad', durationMs: 2, isError: true })
  })
})
