import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiAdapter } from '../pi/pi-adapter.js'
import { PiEventQueue, PiRunUsage } from '../pi/pi-events.js'
import type { AdapterConfig, AgentCLIAdapter, AgentEvent, AgentInput } from '../types.js'
import type { PiCreateOptions, PiEvent, PiMessage, PiResourceOptions, PiSdk, PiSession, PiSessionManager, PiToolCall, PiToolDecision, PiUsage } from '../pi/pi-sdk-types.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve()
  expect(predicate()).toBe(true)
}

const usage = (overrides: Partial<PiUsage> = {}): PiUsage => ({
  input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20,
  cost: { total: 0.01, totalFromProvider: true }, ...overrides,
})

const assistant = (text = 'done', stopReason: PiMessage['stopReason'] = 'stop', tokens = usage()): PiMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], stopReason, usage: tokens,
})

type Plan = (session: FakeSession) => Promise<void> | void

class FakeSession implements PiSession {
  messages: PiMessage[] = []
  isStreaming = false
  isRetrying = false
  pendingMessageCount = 0
  state = { pendingToolCalls: new Set<string>() }
  listeners = new Set<(event: PiEvent) => void>()
  aborted = deferred()
  readonly abort = vi.fn(async () => { this.aborted.resolve() })
  readonly dispose = vi.fn(() => undefined)
  readonly getSessionStats = vi.fn(() => ({
    tokens: { input: 1000, output: 500, cacheRead: 300, cacheWrite: 200, total: 2000 }, cost: 100,
  }))
  readonly unsubscribe = vi.fn(() => undefined)
  readonly prompt = vi.fn(async (_text: string, _options: { expandPromptTemplates: false; source: 'rpc' }) => {
    this.isStreaming = true
    try { await this.plan(this) } finally { this.isStreaming = false }
  })

  constructor(readonly sessionId: string, readonly gate: (event: PiToolCall) => Promise<PiToolDecision | undefined>, private readonly plan: Plan) {}

  subscribe(listener: (event: PiEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener); this.unsubscribe() }
  }

  emit(event: PiEvent) { for (const listener of this.listeners) listener(event) }
  answer(message = assistant()) {
    this.messages.push(message)
    this.emit({ type: 'message_end', message })
  }
  async tool(input: unknown = { path: 'README.md' }, id = 'call-1') {
    const decision = await this.gate({ type: 'tool_call', toolCallId: id, toolName: 'read', input })
    if (decision?.block) return false
    this.state.pendingToolCalls.add(id)
    this.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: input })
    this.state.pendingToolCalls.delete(id)
    this.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'file' }] }, isError: false, durationMs: 7 })
    return true
  }
}

let fixture: string
let cwd: string
let agentDir: string
let sessionDir: string

beforeEach(() => {
  // The consuming gate may supply its own Storage-local fixture directory.
  const root = process.env['DZUPAGENT_PI_TEST_ROOT'] ?? '/data/storage/datazup-runtime/ninel/tmp'
  mkdirSync(root, { recursive: true })
  fixture = mkdtempSync(join(root, 'pi-adapter-'))
  cwd = join(fixture, 'workspace')
  agentDir = join(fixture, 'profile')
  sessionDir = join(fixture, 'sessions')
  for (const directory of [cwd, agentDir, sessionDir]) mkdirSync(directory)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(fixture, { recursive: true, force: true })
})

function fixtureConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return { model: 'test-model', workingDirectory: cwd,
    providerOptions: { agentDir, sessionDir, provider: 'test-provider' }, ...overrides }
}

function harness(plans: Plan[] = [session => session.answer()]) {
  const sessions: FakeSession[] = []
  const resources: PiResourceOptions[] = []
  const offGate = vi.fn(() => undefined)
  const files = new Map<string, string>()
  let counter = 0
  const manager = (id: string, directory = cwd, file?: string): PiSessionManager => ({
    getSessionId: () => id, getCwd: () => directory, getSessionFile: () => file,
  })
  const sdk: PiSdk = {
    VERSION: '1.5.0',
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    DefaultResourceLoader: class {
      constructor(readonly options: PiResourceOptions) { resources.push(options) }
      async reload() {
        for (const factory of this.options.extensionFactories) await factory({ on: (_event, handler) => {
          hooks.set(this, handler)
          return offGate
        } })
      }
    },
    ModelRuntime: { create: vi.fn(async () => ({ getModel: vi.fn(() => ({ id: 'test-model' })) })) },
    SessionManager: {
      create: vi.fn(() => manager(`session-${++counter}`)),
      findById: vi.fn((_cwd, id) => files.get(id)),
      open: vi.fn(file => manager([...files.entries()].find(([, value]) => value === file)?.[0] ?? 'mismatch', cwd, file)),
    },
    createAgentSession: vi.fn(async (options: PiCreateOptions) => {
      const session = new FakeSession(options.sessionManager.getSessionId(), hooks.get(options.resourceLoader)!, plans[sessions.length] ?? (s => s.answer()))
      sessions.push(session)
      return { session }
    }),
  }
  const hooks = new Map<unknown, (event: PiToolCall) => Promise<PiToolDecision | undefined>>()
  const loader = vi.fn(async () => sdk)
  const adapter = new PiAdapter(fixtureConfig(), loader)
  const saved = (id = 'saved') => {
    const file = join(sessionDir, `${id}.jsonl`)
    writeFileSync(file, '')
    files.set(id, realpathSync(file))
    return file
  }
  return { sdk, adapter, loader, sessions, resources, offGate, files, manager, saved }
}

async function collect(events: AsyncGenerator<AgentEvent, void, undefined>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function terminal(events: AgentEvent[]) {
  const terminalEvents = events.filter(event => event.type === 'adapter:completed' || event.type === 'adapter:failed')
  expect(terminalEvents).toHaveLength(1)
  return terminalEvents[0]!
}

describe('Pi adapter contract and isolation', () => {
  it('implements AgentCLIAdapter lazily and normalizes success with the real session ID', async () => {
    const h = harness([s => {
      expect(s.listeners.size).toBe(1)
      s.emit({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'done' } })
      s.answer()
      s.emit({ type: 'agent_end', messages: s.messages, willRetry: false })
    }])
    const adapter: AgentCLIAdapter = h.adapter
    expect(h.loader).not.toHaveBeenCalled()
    const events = await collect(adapter.execute({ prompt: 'hi', correlationId: 'correlation' }))
    expect(events.map(e => e.type)).toEqual(['adapter:started', 'adapter:stream_delta', 'adapter:message', 'adapter:completed'])
    expect(events.every(e => 'correlationId' in e && e.correlationId === 'correlation')).toBe(true)
    expect(terminal(events)).toMatchObject({ type: 'adapter:completed', sessionId: 'session-1', result: 'done', usage: {
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheWriteTokens: 2, costCents: 1,
    } })
    expect(h.sessions[0]!.prompt).toHaveBeenCalledWith('hi', { expandPromptTemplates: false, source: 'rpc' })
    expect(h.sessions[0]!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(h.offGate).toHaveBeenCalledTimes(1)
    expect(h.adapter.respondInteraction('stale', 'yes')).toBe(false)
    expect(h.adapter.getCapabilities()).toMatchObject({ executesToolLoop: true, supportsResume: true, supportsFork: false, supportsZeroToolDispatch: false })
    expect(h.adapter.getCapabilities()).not.toHaveProperty('maxContextTokens')
  })

  it('health and warmup inspect exports without initializing auth, models, resources or sessions', async () => {
    const h = harness()
    expect(await h.adapter.healthCheck()).toMatchObject({ healthy: true, sdkInstalled: true, cliAvailable: false })
    await h.adapter.warmup()
    expect(h.loader).toHaveBeenCalledTimes(1)
    expect(h.sdk.ModelRuntime.create).not.toHaveBeenCalled()
    expect(h.sdk.SettingsManager.inMemory).not.toHaveBeenCalled()
    expect(h.resources).toHaveLength(0)
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('reports missing optional SDK explicitly without initializing a session', async () => {
    const adapter = new PiAdapter(fixtureConfig())
    const loader = vi.spyOn(adapter as unknown as { loadOptionalSdkModule: () => Promise<PiSdk> }, 'loadOptionalSdkModule')
    const { ForgeError } = await import('@dzupagent/core/events')
    loader.mockRejectedValue(new ForgeError({ code: 'ADAPTER_SDK_NOT_INSTALLED', message: 'Install @earendil-works/pi-coding-agent@1.5.0', recoverable: false }))
    const events = await collect(adapter.execute({ prompt: 'hi' }))
    expect(terminal(events)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_SDK_NOT_INSTALLED' })
    expect(await adapter.healthCheck()).toMatchObject({ healthy: false, sdkInstalled: false })
  })

  it.each(['version', 'exports'])('rejects an incompatible SDK %s', async condition => {
    const h = harness()
    if (condition === 'version') h.sdk.VERSION = '1.4.0'
    else h.sdk.ModelRuntime = {} as PiSdk['ModelRuntime']
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'ADAPTER_SDK_INCOMPATIBLE' })
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('constructs explicit isolated resources and disables network catalog refresh', async () => {
    const h = harness()
    await collect(h.adapter.execute({ prompt: 'hi', systemPrompt: 'host system' }))
    expect(h.sdk.SettingsManager.inMemory).toHaveBeenCalledWith(expect.objectContaining({
      packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off', compaction: { enabled: false },
      enableAnalytics: false, enableInstallTelemetry: false,
    }), { projectTrusted: false })
    expect(h.resources[0]).toMatchObject({ cwd, agentDir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [],
      additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [], systemPrompt: '', appendSystemPrompt: [] })
    expect(h.resources[0]!.systemPromptOverride('ambient system')).toBe('host system')
    expect(h.resources[0]!.appendSystemPromptOverride(['ambient append'])).toEqual([])
    expect(h.resources[0]!.extensionFactories).toHaveLength(1)
    expect(h.sdk.ModelRuntime.create).toHaveBeenCalledWith({ authPath: join(agentDir, 'auth.json'),
      modelsPath: null, modelsStorePath: join(agentDir, 'models-cache.json'), allowModelNetwork: false,
      refreshOnCreate: false, signal: expect.any(AbortSignal) })
    expect(h.sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ cwd, agentDir,
      tools: ['read', 'bash', 'edit', 'write'], excludeTools: [] }))
  })

  it.each(['agentDir', 'sessionDir', 'provider'])('requires explicit %s without a silent home fallback', async key => {
    const h = harness()
    const options = { ...fixtureConfig().providerOptions }
    delete options[key]
    h.adapter.configure({ providerOptions: options })
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'CONFIG_INVALID' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it('rejects missing workspace and model', async () => {
    const h = harness()
    h.adapter.configure({ workingDirectory: undefined })
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'CONFIG_INVALID' })
    h.adapter.configure({ workingDirectory: cwd, model: undefined })
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'CONFIG_INVALID' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it.each<Partial<AgentInput>>([
    { maxTurns: 1 }, { maxBudgetUsd: 0 }, { outputSchema: {} },
    { policyContext: { activePolicy: { sandboxMode: 'read-only' } } },
    { policyContext: { activePolicy: { networkAccess: false } } },
    { policyContext: { activePolicy: { maxBudgetUsd: 1 } } },
    { policyContext: { activePolicy: { maxTurns: 1 } } },
    { policyContext: { projectedGuardrails: { maxCostCents: 1 } } },
    { policyContext: { projectedGuardrails: { maxIterations: 1 } } },
    { options: { networkAccess: false } },
    { executionControlRequirement: { schema: 'dzupagent/adapter-execution-control-requirement/v1', tools: { mode: 'none' } } },
  ])('rejects unsupported execution controls before dispatch: %j', async input => {
    const h = harness()
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi', ...input })))).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it.each<Partial<AdapterConfig>>([
    { sandboxMode: 'workspace-write' }, { apiKey: 'fake-key' }, { env: {} }, { envFilter: {} },
    { thinkingBudgetTokens: 100 }, { promptCache: 'off' }, { skipGitRepoCheck: true },
    { interactionPolicy: { mode: 'ai-autonomous' } },
    { interactionPolicy: { mode: 'ask-caller', askCaller: { timeoutFallback: 'auto-approve' } } },
  ])('rejects unsupported configuration before loading: %j', async config => {
    const h = harness()
    h.adapter.configure(config)
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it('projects a strict allowlist and merged denylists before dispatch', async () => {
    const h = harness()
    await collect(h.adapter.execute({ prompt: 'hi', options: { excludeTools: ['bash'] }, policyContext: {
      activePolicy: { toolPolicy: 'strict', allowedTools: ['read'], blockedTools: ['write'] },
      projectedGuardrails: { blockedTools: ['edit'] },
    } }))
    expect(h.sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ['read'], excludeTools: ['bash', 'write', 'edit'] }))
  })

  it.each(['auto-approve', 'default-answers'] as const)('rejects %s when caller approval is required', async mode => {
    const h = harness()
    h.adapter.configure({ interactionPolicy: { mode } })
    const events = await collect(h.adapter.execute({ prompt: 'hi', policyContext: { activePolicy: { approvalRequired: true } } }))
    expect(terminal(events)).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it('fails closed if the host approval extension is not loaded', async () => {
    const h = harness()
    h.sdk.DefaultResourceLoader = class { async reload() {} }
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'ADAPTER_SDK_INCOMPATIBLE' })
    expect(h.sessions[0]!.prompt).not.toHaveBeenCalled()
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('Pi settlement and event ordering', () => {
  it('keeps text, tool call, tool result and final answer in source order', async () => {
    const h = harness([async s => {
      s.answer(assistant('checking', 'toolUse'))
      expect(await s.tool()).toBe(true)
      s.answer(assistant('finished'))
    }])
    h.adapter.configure({ interactionPolicy: { mode: 'auto-approve' } })
    const events = await collect(h.adapter.execute({ prompt: 'hi' }))
    expect(events.map(e => e.type)).toEqual(['adapter:started', 'adapter:message', 'adapter:interaction_resolved',
      'adapter:tool_call', 'adapter:tool_result', 'adapter:message', 'adapter:completed'])
    expect(terminal(events)).toMatchObject({ result: 'finished', usage: { inputTokens: 20, costCents: 2 } })
  })

  it('does not complete at agent_end and allows a retry to succeed', async () => {
    const gate = deferred()
    const h = harness([async s => {
      s.answer(assistant('retrying', 'error'))
      s.emit({ type: 'agent_end', messages: s.messages, willRetry: true })
      s.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: 'retry' })
      await gate.promise
      s.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
      s.answer(assistant('recovered'))
    }])
    const stream = h.adapter.execute({ prompt: 'hi' })
    const collecting = collect(stream)
    await until(() => h.sessions[0]?.messages.length === 1)
    expect(h.sessions[0]!.dispose).not.toHaveBeenCalled()
    gate.resolve()
    expect(terminal(await collecting)).toMatchObject({ type: 'adapter:completed', result: 'recovered', usage: { inputTokens: 20 } })
  })

  it.each<PiMessage['stopReason']>(['pending', 'toolUse', 'deferred', 'error', 'aborted'])('does not report %s as success', async reason => {
    const h = harness([s => s.answer(assistant('incomplete', reason))])
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ type: 'adapter:failed' })
  })

  it('reports retry exhaustion as failure with current-run usage', async () => {
    const h = harness([s => {
      s.answer(assistant('retry failure', 'error'))
      s.emit({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'failed' })
    }])
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ type: 'adapter:failed', code: 'PROVIDER_ERROR', usage: { inputTokens: 10 } })
  })

  it.each(['streaming', 'retrying', 'queued', 'tools', 'missing', 'deferred-handle'])('rejects unresolved settlement: %s', async mode => {
    const h = harness([s => {
      if (mode !== 'missing') s.answer({ ...assistant(), ...(mode === 'deferred-handle' ? { deferred: {} } : {}) })
      if (mode === 'retrying') s.isRetrying = true
      if (mode === 'queued') s.pendingMessageCount = 1
      if (mode === 'tools') s.state.pendingToolCalls.add('unfinished')
      if (mode === 'streaming') Object.defineProperty(s, 'isStreaming', { get: () => true, set: () => undefined })
    }])
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ code: 'ADAPTER_INCOMPLETE_RESULT' })
  })

  it('observes prompt rejection and disposes exactly once', async () => {
    const h = harness([async () => { throw new Error('prompt failed') }])
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi' })))).toMatchObject({ type: 'adapter:failed', error: 'prompt failed' })
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(h.sessions[0]!.listeners.size).toBe(0)
  })

  it('drains bounded queued events before completion', async () => {
    const h = harness([s => { s.answer(assistant('one', 'toolUse')); s.answer(assistant('two')) }])
    h.adapter.configure({ providerOptions: { ...fixtureConfig().providerOptions, queueCapacity: 2 } })
    const stream = h.adapter.execute({ prompt: 'hi' })
    expect((await stream.next()).value).toMatchObject({ type: 'adapter:started' })
    await until(() => h.sessions[0]!.dispose.mock.calls.length === 1)
    expect((await collect(stream)).map(e => e.type)).toEqual(['adapter:message', 'adapter:message', 'adapter:completed'])
  })

  it('fails explicitly on overflow rather than silently dropping data', async () => {
    const h = harness([s => { s.answer(assistant('one')); s.answer(assistant('two')); s.answer(assistant('three')) }])
    h.adapter.configure({ providerOptions: { ...fixtureConfig().providerOptions, queueCapacity: 1 } })
    const stream = h.adapter.execute({ prompt: 'hi' })
    await stream.next()
    await until(() => h.sessions[0]!.dispose.mock.calls.length === 1)
    const events = await collect(stream)
    expect(events[0]).toMatchObject({ type: 'adapter:message', content: 'one' })
    expect(terminal(events)).toMatchObject({ type: 'adapter:failed', code: 'ADAPTER_EVENT_QUEUE_OVERFLOW' })
    expect(h.sessions[0]!.abort).toHaveBeenCalledTimes(1)
  })

  it('resolves every queued reader when closed', async () => {
    const queue = new PiEventQueue(1)
    const first = queue.next()
    const second = queue.next()
    queue.close()
    expect(await first).toEqual({ done: true, value: undefined })
    expect(await second).toEqual({ done: true, value: undefined })
  })
})

describe('Pi cancellation and interaction ownership', () => {
  it('pre-cancellation performs no SDK or session initialization', async () => {
    const h = harness()
    const signal = AbortSignal.abort()
    expect(terminal(await collect(h.adapter.execute({ prompt: 'hi', signal })))).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    expect(h.loader).not.toHaveBeenCalled()
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('cancels during SDK loading without dispatching a prompt', async () => {
    const h = harness()
    const loaded = deferred<PiSdk>()
    const adapter = new PiAdapter(fixtureConfig(), () => loaded.promise)
    const controller = new AbortController()
    const result = collect(adapter.execute({ prompt: 'hi', signal: controller.signal }))
    controller.abort()
    expect(terminal(await result)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    loaded.resolve(h.sdk)
    await until(() => true)
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('cancels during resource loading without initializing a model', async () => {
    const h = harness()
    const reload = deferred()
    h.sdk.DefaultResourceLoader = class { async reload() { await reload.promise } }
    const controller = new AbortController()
    const result = collect(h.adapter.execute({ prompt: 'hi', signal: controller.signal }))
    await until(() => h.sdk.SessionManager.create.mock !== undefined && vi.mocked(h.sdk.SessionManager.create).mock.calls.length === 1)
    controller.abort()
    expect(terminal(await result)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    reload.resolve()
    await until(() => true)
    expect(h.sdk.ModelRuntime.create).not.toHaveBeenCalled()
  })

  it('cancels during model initialization without creating a session', async () => {
    const h = harness()
    const model = deferred<Awaited<ReturnType<PiSdk['ModelRuntime']['create']>>>()
    vi.mocked(h.sdk.ModelRuntime.create).mockImplementation(() => model.promise)
    const controller = new AbortController()
    const result = collect(h.adapter.execute({ prompt: 'hi', signal: controller.signal }))
    await until(() => vi.mocked(h.sdk.ModelRuntime.create).mock.calls.length === 1)
    controller.abort()
    expect(terminal(await result)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    model.resolve({ getModel: () => ({}) })
    await until(() => true)
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('disposes a session that arrives after initialization cancellation', async () => {
    const h = harness()
    const created = deferred<{ session: PiSession }>()
    vi.mocked(h.sdk.createAgentSession).mockImplementation(() => created.promise)
    const controller = new AbortController()
    const result = collect(h.adapter.execute({ prompt: 'hi', signal: controller.signal }))
    await until(() => vi.mocked(h.sdk.createAgentSession).mock.calls.length === 1)
    controller.abort()
    expect(terminal(await result)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    const late = new FakeSession('session-1', async () => undefined, s => s.answer())
    created.resolve({ session: late })
    await until(() => late.dispose.mock.calls.length === 1)
    expect(late.prompt).not.toHaveBeenCalled()
    expect(late.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels only the calling run and interrupt cancels all active runs', async () => {
    const h = harness([s => s.aborted.promise, s => s.aborted.promise, s => s.aborted.promise])
    const controller = new AbortController()
    const one = collect(h.adapter.execute({ prompt: 'one', signal: controller.signal }))
    const two = collect(h.adapter.execute({ prompt: 'two' }))
    await until(() => h.sessions.length === 2)
    controller.abort()
    expect(terminal(await one)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    expect(h.sessions[1]!.abort).not.toHaveBeenCalled()
    const three = collect(h.adapter.execute({ prompt: 'three' }))
    await until(() => h.sessions.length === 3)
    h.adapter.interrupt()
    expect(terminal(await two)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    expect(terminal(await three)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    for (const session of h.sessions) expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['return', 'throw'] as const)('iterator %s cancels while next is pending', async method => {
    const h = harness([s => s.aborted.promise])
    const stream = h.adapter.execute({ prompt: 'hi' })
    await stream.next()
    const pending = stream.next()
    if (method === 'return') await stream.return()
    else await expect(stream.throw(new Error('consumer closed'))).rejects.toThrow('consumer closed')
    expect((await pending).done).toBeDefined()
    expect(h.sessions[0]!.abort).toHaveBeenCalledTimes(1)
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(h.sessions[0]!.listeners.size).toBe(0)
  })

  it('observes abort and late prompt rejections without emitting a second terminal event', async () => {
    const prompt = deferred()
    const h = harness([() => prompt.promise])
    const stream = h.adapter.execute({ prompt: 'hi' })
    await stream.next()
    h.sessions[0]!.abort.mockRejectedValue(new Error('abort rejected'))
    h.adapter.interrupt()
    expect(terminal(await collect(stream))).toMatchObject({ code: 'EXECUTION_CANCELLED' })
    prompt.reject(new Error('late prompt rejected'))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('registers approval before publication, supports immediate response and rejects stale responses', async () => {
    const h = harness([async s => { expect(await s.tool()).toBe(true); s.answer() }])
    const events: AgentEvent[] = []
    let id = ''
    for await (const event of h.adapter.execute({ prompt: 'hi' })) {
      events.push(event)
      if (event.type === 'adapter:interaction_required') {
        id = event.interactionId
        expect(event.question).toContain('README.md')
        expect(h.adapter.respondInteraction(id, 'yes')).toBe(true)
        expect(h.adapter.respondInteraction(id, 'yes')).toBe(false)
      }
    }
    expect(terminal(events)).toMatchObject({ type: 'adapter:completed' })
    expect(h.adapter.respondInteraction(id, 'yes')).toBe(false)
  })

  it.each(['no', 'yesterday', 'approve', ''])('denies an unapproved answer %j before any tool side effect', async answer => {
    let executed: boolean | undefined
    const h = harness([async s => { executed = await s.tool(); s.answer() }])
    for await (const event of h.adapter.execute({ prompt: 'hi' })) {
      if (event.type === 'adapter:interaction_required') h.adapter.respondInteraction(event.interactionId, answer)
    }
    expect(executed).toBe(false)
  })

  it.each([null, [], 'bad'])('blocks malformed tool input %j', async input => {
    let executed: boolean | undefined
    const h = harness([async s => { executed = await s.tool(input); s.answer() }])
    h.adapter.configure({ interactionPolicy: { mode: 'auto-approve' } })
    const events = await collect(h.adapter.execute({ prompt: 'hi' }))
    expect(executed).toBe(false)
    expect(events.some(e => e.type === 'adapter:tool_call')).toBe(false)
  })

  it('cancellation dominates a racing yes and disposes pending interactions with denial', async () => {
    let executed: boolean | undefined
    const h = harness([async s => { executed = await s.tool(); s.answer() }])
    const controller = new AbortController()
    const events: AgentEvent[] = []
    for await (const event of h.adapter.execute({ prompt: 'hi', signal: controller.signal })) {
      events.push(event)
      if (event.type === 'adapter:interaction_required') {
        expect(h.adapter.respondInteraction(event.interactionId, 'yes')).toBe(true)
        controller.abort()
      }
    }
    await until(() => executed !== undefined)
    expect(executed).toBe(false)
    expect(terminal(events)).toMatchObject({ code: 'EXECUTION_CANCELLED' })
  })

  it('denies tools on interaction timeout and removes timers', async () => {
    vi.useFakeTimers()
    let executed: boolean | undefined
    const h = harness([async s => { executed = await s.tool(); s.answer() }])
    h.adapter.configure({ interactionPolicy: { mode: 'ask-caller', askCaller: { timeoutMs: 25 } } })
    const events: AgentEvent[] = []
    const result = (async () => {
      for await (const event of h.adapter.execute({ prompt: 'hi' })) {
        events.push(event)
        if (event.type === 'adapter:interaction_required') await vi.advanceTimersByTimeAsync(25)
      }
    })()
    await result
    expect(executed).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'adapter:interaction_resolved', answer: 'no', resolvedBy: 'timeout-fallback' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('execution timeout aborts and clears resources', async () => {
    vi.useFakeTimers()
    const h = harness([s => s.aborted.promise])
    h.adapter.configure({ timeoutMs: 10 })
    const stream = h.adapter.execute({ prompt: 'hi' })
    await stream.next()
    await vi.advanceTimersByTimeAsync(10)
    expect(terminal(await collect(stream))).toMatchObject({ code: 'EXECUTION_TIMEOUT' })
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Pi resume, configuration and usage provenance', () => {
  it('uses exact synchronous findById and never falls back for an unknown session', async () => {
    const h = harness()
    expect(terminal(await collect(h.adapter.resumeSession('unknown', { prompt: 'hi' })))).toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(h.sdk.SessionManager.findById).toHaveBeenCalledWith(cwd, 'unknown', sessionDir)
    expect(h.sdk.SessionManager.open).not.toHaveBeenCalled()
    expect(h.sdk.SessionManager.create).not.toHaveBeenCalled()
  })

  it.each(['id', 'workspace', 'path', 'symlink'])('rejects resumed session %s mismatch', async kind => {
    const h = harness()
    const file = h.saved()
    if (kind === 'id') vi.mocked(h.sdk.SessionManager.open).mockReturnValue(h.manager('wrong', cwd, file))
    if (kind === 'workspace') vi.mocked(h.sdk.SessionManager.open).mockReturnValue(h.manager('saved', agentDir, file))
    if (kind === 'path') { const outside = join(fixture, 'outside.jsonl'); writeFileSync(outside, ''); h.files.set('saved', outside) }
    if (kind === 'symlink') {
      const outside = join(fixture, 'outside.jsonl'); writeFileSync(outside, '')
      const link = join(sessionDir, 'escape.jsonl'); symlinkSync(outside, link); h.files.set('saved', link)
    }
    expect(terminal(await collect(h.adapter.resumeSession('saved', { prompt: 'hi' })))).toMatchObject({ code: 'SESSION_INVALID' })
    expect(h.sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('excludes concurrent use of a saved session across separate adapter instances and releases it after settlement', async () => {
    const h = harness([s => s.aborted.promise])
    h.saved()
    const first = h.adapter.resumeSession('saved', { prompt: 'first' })
    await first.next()
    const second = new PiAdapter(fixtureConfig(), h.loader)
    expect(terminal(await collect(second.resumeSession('saved', { prompt: 'second' })))).toMatchObject({ code: 'SESSION_BUSY' })
    await first.return()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(terminal(await collect(second.resumeSession('saved', { prompt: 'third' })))).toMatchObject({ type: 'adapter:completed' })
  })

  it('snapshots configuration and per-call options when each iterator is created', async () => {
    const h = harness()
    const input = { prompt: 'first', options: { tools: ['read'] } }
    const first = h.adapter.execute(input)
    input.options.tools.push('bash')
    h.adapter.configure({ model: 'changed', interactionPolicy: { mode: 'auto-deny' } })
    const second = h.adapter.execute({ prompt: 'second' })
    await Promise.all([collect(first), collect(second)])
    const calls = vi.mocked(h.sdk.createAgentSession).mock.calls
    expect(calls[0]![0].tools).toEqual(['read'])
    const runtimeCalls = vi.mocked(h.sdk.ModelRuntime.create).mock.results
    const firstRuntime = await runtimeCalls[0]!.value
    const secondRuntime = await runtimeCalls[1]!.value
    expect(firstRuntime.getModel).toHaveBeenCalledWith('test-provider', 'test-model')
    expect(secondRuntime.getModel).toHaveBeenCalledWith('test-provider', 'changed')
    expect(h.sessions[0]!.sessionId).not.toBe(h.sessions[1]!.sessionId)
  })

  it('resumes without replaying old text or including lifetime usage', async () => {
    const h = harness()
    h.saved()
    const create = h.sdk.createAgentSession
    vi.mocked(h.sdk.createAgentSession).mockImplementation(async options => {
      // Use the original factory implementation, avoiding the mock's dispatch.
      const original = new FakeSession(options.sessionManager.getSessionId(), async () => undefined, s => {
        s.emit({ type: 'message_end', message: old })
        s.answer(assistant('new', 'stop', usage({ reasoning: 4, cacheWrite1h: 2 })))
      })
      const old = assistant('old', 'stop', usage({ input: 10000 }))
      original.messages.push(old)
      h.sessions.push(original)
      return { session: original }
    })
    expect(create).toBe(h.sdk.createAgentSession)
    const events = await collect(h.adapter.resumeSession('saved', { prompt: 'continue' }))
    expect(events.filter(e => e.type === 'adapter:message')).toEqual([expect.objectContaining({ content: 'new' })])
    expect(terminal(events)).toMatchObject({ sessionId: 'saved', result: 'new', usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2, costCents: 1 } })
    expect(h.sessions[0]!.getSessionStats).toHaveBeenCalledTimes(1)
  })

  it('does not turn old resumed success into a new completion', async () => {
    const h = harness([() => undefined])
    h.saved()
    const original = vi.mocked(h.sdk.createAgentSession).getMockImplementation()!
    vi.mocked(h.sdk.createAgentSession).mockImplementation(async options => {
      const result = await original(options)
      result.session.messages.push(assistant('old'))
      return result
    })
    expect(terminal(await collect(h.adapter.resumeSession('saved', { prompt: 'continue' })))).toMatchObject({ code: 'ADAPTER_INCOMPLETE_RESULT' })
  })

  it.each([undefined, false])('omits estimated or unknown cost provenance %j while retaining tokens', reported => {
    const meter = new PiRunUsage()
    meter.add(usage({ cost: { total: 2, totalFromProvider: reported } }))
    expect(meter.snapshot()).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheWriteTokens: 2 })
  })

  it('omits mixed reported/estimated cost and never invents zero cost', () => {
    const meter = new PiRunUsage()
    expect(meter.snapshot()).toBeUndefined()
    meter.add(usage())
    meter.add(usage({ cost: { total: 0 } }))
    expect(meter.snapshot()).not.toHaveProperty('costCents')
    expect(meter.snapshot()).toMatchObject({ inputTokens: 20, outputTokens: 10 })
  })

  it('snapshots finalized usage, sums exact provider costs and avoids subset double counting', () => {
    const meter = new PiRunUsage()
    const record = usage({ reasoning: 4, cacheWrite1h: 1 })
    meter.add(record)
    record.input = 5000
    meter.add(usage({ cost: { total: 0.02, totalFromProvider: true } }))
    expect(meter.snapshot()).toEqual({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 6, cacheWriteTokens: 4, costCents: 3 })
  })

  it.each([undefined, -1, NaN, Infinity, 0.5])('never invents zero for invalid token measurement %j', value => {
    const meter = new PiRunUsage()
    meter.add(usage({ input: value as number }))
    expect(meter.snapshot()).toBeUndefined()
  })

  it('keeps a missing contributing assistant measurement unknown', () => {
    const meter = new PiRunUsage()
    meter.add(undefined)
    meter.add(usage())
    expect(meter.snapshot()).toBeUndefined()
  })

  it('rejects token total overflow and omits overflowing costs', () => {
    const tokens = new PiRunUsage()
    tokens.add(usage({ input: Number.MAX_SAFE_INTEGER }))
    tokens.add(usage())
    expect(tokens.snapshot()).toBeUndefined()
    const cost = new PiRunUsage()
    cost.add(usage({ cost: { total: Number.MAX_VALUE, totalFromProvider: true } }))
    expect(cost.snapshot()).toMatchObject({ inputTokens: 10 })
    expect(cost.snapshot()).not.toHaveProperty('costCents')
  })
})
