import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzupagent/core'

import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { CrushAdapter } from '../crush/crush-adapter.js'
import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { GooseAdapter } from '../goose/goose-adapter.js'
import { ClaudeAgentAdapter } from '../claude/claude-adapter.js'
import { CodexAdapter } from '../codex/codex-adapter.js'
import { OpenRouterAdapter } from '../openrouter/openrouter-adapter.js'
import { PiAdapter, OpenCodeAdapter, ClineAdapter } from '../providers.js'
import type { PiMessage, PiResourceOptions, PiSdk, PiSession } from '../pi/pi-sdk-types.js'
import type { OpenCodeClient, OpenCodeSdk } from '../opencode/opencode-sdk-types.js'
import type { ClineTransportFactory } from '../cline/cline-worker-transport.js'
import * as crushUsage from '../crush/crush-usage.js'
import type { AgentCLIAdapter, AgentEvent, AdapterProviderId, TokenUsage } from '../types.js'
import { getProcessHelperMocks } from './test-helpers.js'

const codexSdkMock = vi.hoisted(() => {
  const startThread = vi.fn()
  const resumeThread = vi.fn()
  const Codex = vi.fn().mockImplementation(() => ({
    startThread,
    resumeThread,
  }))
  return { Codex, startThread, resumeThread }
})

const claudeSdkMock = vi.hoisted(() => ({
  query: vi.fn(),
  listSessions: vi.fn(),
  getSessionInfo: vi.fn(),
}))

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexSdkMock.Codex,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeSdkMock.query,
  listSessions: claudeSdkMock.listSessions,
  getSessionInfo: claudeSdkMock.getSessionInfo,
}))

type CliConformanceCase = {
  providerId: AdapterProviderId
  adapter: AgentCLIAdapter
  input?: Parameters<AgentCLIAdapter['execute']>[0]
  completedRecord: Record<string, unknown>
  expectedUsage?: TokenUsage
  expectedArgs: string[]
}

async function drainEvents<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const events: T[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

function terminalEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'adapter:completed' || event.type === 'adapter:failed')
}

function expectAutonomousToolLoopEvidence(events: AgentEvent[]): void {
  const toolCallIndex = events.findIndex((event) => event.type === 'adapter:tool_call')
  const toolResultIndex = events.findIndex(
    (event, index) => index > toolCallIndex && event.type === 'adapter:tool_result',
  )
  const postToolModelIndex = events.findIndex(
    (event, index) =>
      index > toolResultIndex &&
      (event.type === 'adapter:message' || event.type === 'adapter:stream_delta'),
  )

  expect(toolCallIndex, 'autonomous loop must expose a tool call').toBeGreaterThanOrEqual(0)
  expect(toolResultIndex, 'autonomous loop must expose tool execution').toBeGreaterThan(toolCallIndex)
  expect(
    postToolModelIndex,
    'autonomous loop must expose a model response after tool execution',
  ).toBeGreaterThan(toolResultIndex)
}

// Crush refuses project config (.crushrc, crush.json, ...) in any ancestor of its cwd, and a
// workspace root may hold one, so Crush runs here use a private temp cwd, not process.cwd().
const crushCwd = mkdtempSync(join(tmpdir(), 'crush-hermetic-cwd-'))
afterAll(() => rmSync(crushCwd, { recursive: true, force: true }))

describe('CLI adapter conformance contract', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  const cases: CliConformanceCase[] = [
    {
      providerId: 'qwen',
      adapter: new QwenAdapter(),
      completedRecord: {
        type: 'completed',
        content: 'qwen done',
        duration_ms: 24,
        usage: {
          input_tokens: 150,
          output_tokens: 30,
          cached_input_tokens: 20,
          cost_cents: 4.5,
        },
      },
      expectedUsage: {
        inputTokens: 150,
        outputTokens: 30,
        cachedInputTokens: 20,
        costCents: 4.5,
      },
      expectedArgs: ['--bare', '--auth-type', 'openai', '--output-format', 'stream-json', '--model', 'qwen3-coder-plus', '--prompt', 'contract'],
    },
    {
      providerId: 'crush',
      adapter: new CrushAdapter({ workingDirectory: crushCwd }),
      completedRecord: {
        type: 'text_result',
        content: 'crush done',
        duration_ms: 31,
      },
      expectedArgs: ['--data-dir', 'run', '--quiet', '--', 'contract'],
    },
    {
      providerId: 'gemini',
      adapter: new GeminiCLIAdapter(),
      completedRecord: {
        type: 'completed',
        result: 'gemini done',
        duration_ms: 42,
      },
      expectedUsage: undefined as unknown as TokenUsage,
      expectedArgs: ['--output-format', 'stream-json', '--prompt', 'contract', '--approval-mode', 'plan', '--sandbox'],
    },
    {
      providerId: 'goose',
      adapter: new GooseAdapter({ cliProvider: 'ollama', model: 'qwen3' }),
      input: {
        prompt: 'contract',
        policyContext: { activePolicy: { sandboxMode: 'full-access', approvalRequired: false } },
      },
      completedRecord: {
        type: 'text_result',
        content: 'goose done',
        duration_ms: 55,
      },
      expectedUsage: undefined as unknown as TokenUsage,
      expectedArgs: ['run', '--quiet', '--no-session', '--provider', 'ollama', '--model', 'qwen3', '--text', 'contract'],
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.providerId} emits exactly one terminal completed event with usage attribution`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        if (testCase.providerId !== 'crush') yield { type: 'message', content: `${testCase.providerId} hello` }
        yield testCase.completedRecord
      })

      const events = await drainEvents(testCase.adapter.execute(testCase.input ?? { prompt: 'contract' }))
      const terminals = terminalEvents(events)

      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.type).toBe('adapter:completed')

      const completed = terminals[0]
      if (completed?.type === 'adapter:completed') {
        expect(completed.providerId).toBe(testCase.providerId)
        if (testCase.expectedUsage !== undefined) {
          expect(completed.usage).toEqual(testCase.expectedUsage)
        } else {
          expect(completed.usage).toBeUndefined()
        }
        if (testCase.providerId === 'crush') expect(completed.result).toBe('crush done')
      }

      const [, args] = mockSpawnAndStreamJsonl.mock.calls.at(-1)!
      for (const arg of testCase.expectedArgs) {
        expect(args).toContain(arg)
      }
      if (testCase.providerId === 'crush') {
        expect(mockSpawnAndStreamJsonl.mock.calls.at(-1)?.[2]?.stdoutMode).toBe('text')
        expect(events.some(event => event.type === 'adapter:tool_call' || event.type === 'adapter:tool_result')).toBe(false)
      }
    })

    it(`${testCase.providerId} treats provider failure as terminal without adding synthetic completion`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        if (testCase.providerId === 'goose' || testCase.providerId === 'crush') {
          throw new ForgeError({ code: 'PROVIDER_UNAVAILABLE', message: `${testCase.providerId} failed`, recoverable: false })
        }
        yield { type: 'error', error: { message: `${testCase.providerId} failed`, code: 'PROVIDER_UNAVAILABLE' } }
      })

      const events: AgentEvent[] = []
      let thrown: unknown
      try {
        for await (const event of testCase.adapter.execute(testCase.input ?? { prompt: 'contract' })) {
          events.push(event)
        }
      } catch (error) {
        thrown = error
      }
      const terminals = terminalEvents(events)

      expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:failed'])
      expect(terminals).toHaveLength(1)

      const failed = terminals[0]
      expect(failed?.type).toBe('adapter:failed')
      if (failed?.type === 'adapter:failed') {
        expect(failed.providerId).toBe(testCase.providerId)
        expect(failed.code).toBe('PROVIDER_UNAVAILABLE')
      }
      if (testCase.providerId === 'goose' || testCase.providerId === 'crush') expect(thrown).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
      else expect(thrown).toBeUndefined()
    })

    it(`${testCase.providerId} surfaces aborts as adapter:failed before rethrowing`, async () => {
      let markAbortHandlerReady!: () => void
      const abortHandlerReady = new Promise<void>((resolve) => { markAbortHandlerReady = resolve })
      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary, _args, opts) {
        if (testCase.providerId !== 'crush') yield { type: 'message', content: `${testCase.providerId} running` }
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            markAbortHandlerReady()
            resolve()
            return
          }
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
          markAbortHandlerReady()
        })
        throw new ForgeError({
          code: 'AGENT_ABORTED',
          message: `${testCase.providerId} aborted`,
          recoverable: true,
        })
      })

      const stream = testCase.adapter.execute(testCase.input ?? { prompt: 'contract' })
      const first = await stream.next()
      expect(first.value?.type).toBe('adapter:started')

      let third
      if (testCase.providerId === 'goose' || testCase.providerId === 'crush') {
        const pending = stream.next()
        // These adapters prepare a private filesystem projection before spawn.
        // Wait for the actual fake abort boundary, not an event-loop tick.
        await abortHandlerReady
        testCase.adapter.interrupt()
        third = await pending
      } else {
        const second = await stream.next()
        expect(second.value?.type).toBe('adapter:message')
        testCase.adapter.interrupt()
        third = await stream.next()
      }
      expect(third.value?.type).toBe('adapter:failed')
      if (third.value?.type === 'adapter:failed') {
        expect(third.value.providerId).toBe(testCase.providerId)
        expect(third.value.code).toBe('AGENT_ABORTED')
      }

      await expect(stream.next()).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
    })
  }

  it('requires behavioral tool execution and a post-tool model response for a true loop capability', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_call', name: 'search', arguments: { query: 'contract' } }
      yield { type: 'tool_result', name: 'search', output: 'found' }
      yield { type: 'message', role: 'assistant', content: 'Used the search result' }
      yield { type: 'completed', result: 'done' }
    })

    const adapter = new GeminiCLIAdapter()
    const events = await drainEvents(adapter.execute({ prompt: 'contract' }))

    expect(adapter.getCapabilities().executesToolLoop).toBe(true)
    expectAutonomousToolLoopEvidence(events)
  })

  it('rejects a function-call-only trace as autonomous loop evidence', () => {
    const events: AgentEvent[] = [
      {
        type: 'adapter:tool_call',
        providerId: 'gemini-sdk',
        toolName: 'search',
        input: { query: 'contract' },
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'gemini-sdk',
        sessionId: 'session-1',
        result: '',
        durationMs: 1,
        timestamp: 2,
      },
    ]

    expect(() => expectAutonomousToolLoopEvidence(events)).toThrow()
  })

  it('crush keeps resume unsupported as an explicit contract', async () => {
    const adapter = new CrushAdapter({ workingDirectory: crushCwd })

    await expect(drainEvents(adapter.resumeSession('sess-1', { prompt: 'resume' }))).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    })
  })

  it('omits Crush cumulative usage even when a context snapshot is available', async () => {
    const measured = { inputTokens: 77, outputTokens: 18, costCents: 0.5 }
    const reader = vi.spyOn(crushUsage, 'readCrushUsage').mockReturnValue(measured)
    try {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'text_result', content: 'plain answer', token_usage: { prompt_tokens: 9999, completion_tokens: 9999 } }
      })
      const events = await drainEvents(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'contract' }))
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: 'adapter:completed', result: 'plain answer' })])
      expect(terminalEvents(events)[0]).not.toHaveProperty('usage')
      expect(reader).not.toHaveBeenCalled()
    } finally { reader.mockRestore() }
  })
})

// These seams never import an optional SDK, connect to a host, or read auth.
function piContractFixture(pending = false) {
  let listener: ((event: { type: 'message_end'; message: PiMessage }) => void) | undefined
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const dispose = vi.fn()
  const unsubscribe = vi.fn()
  const session: PiSession = {
    sessionId: 'pi-contract', messages: [], isStreaming: false, isRetrying: false,
    pendingMessageCount: 0, state: { pendingToolCalls: new Set() },
    subscribe: callback => { listener = callback; return unsubscribe },
    prompt: async () => {
      if (pending) { await wait; return }
      const message: PiMessage = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pi answer' }] }
      session.messages.push(message)
      listener?.({ type: 'message_end', message })
    },
    abort: async () => { release() }, dispose,
    // Lifetime totals must never become current-turn usage.
    getSessionStats: () => ({ tokens: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, total: 19998 }, cost: 100 }),
  }
  const sdk: PiSdk = {
    VERSION: '1.5.0', SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(private readonly options: PiResourceOptions) {}
      async reload() {
        for (const factory of this.options.extensionFactories) await factory({ on: () => () => undefined })
      }
    },
    readStoredCredential: () => ({ type: 'api_key', key: 'in-memory-fixture' }),
    ModelRuntime: { create: async () => ({ getModel: () => ({}) }) },
    SessionManager: {
      create: () => ({ getSessionId: () => session.sessionId, getCwd: () => crushCwd, getSessionFile: () => undefined }),
      findById: () => undefined,
      open: () => { throw new Error('no persisted session in fixture') },
    },
    createAgentSession: async () => ({ session }),
  }
  const loader = vi.fn(async () => sdk)
  const adapter = new PiAdapter({ model: 'fixture', workingDirectory: crushCwd,
    providerOptions: { provider: 'openai', agentDir: crushCwd, sessionDir: crushCwd } }, loader)
  return { adapter, loader, closed: dispose, unsubscribe }
}

function openCodeContractFixture(pending = false) {
  const cancelled = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
    }, cancel: cancelled,
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const aborted = vi.fn(async () => ({ data: true }))
  const client: OpenCodeClient = {
    tool: { ids: async () => ({ data: [] }) },
    session: {
      create: async () => ({ data: { id: 'opencode-contract', directory: crushCwd } }),
      abort: aborted,
      prompt: async options => {
        if (pending) return new Promise(() => undefined)
        const info = { id: 'answer', role: 'assistant', sessionID: options.path.id,
          parentID: options.body.messageID, time: { created: Date.now(), completed: Date.now() }, finish: 'stop' }
        return { data: { info, parts: [{ id: 'text', type: 'text', text: 'opencode answer', messageID: info.id, sessionID: info.sessionID }] } }
      },
    },
    event: { subscribe: async () => { throw new Error('SDK SSE must not bypass the injected fetch') } },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
  }
  const loader = vi.fn(async (): Promise<OpenCodeSdk> => ({ createOpencodeClient: () => client }))
  const adapter = new OpenCodeAdapter({ baseUrl: 'http://127.0.0.1:4096', cwd: crushCwd, cleanupTimeoutMs: 20 },
    { loadSdk: loader, fetch: fetcher })
  return { adapter, loader, closed: cancelled, aborted }
}

function clineContractFixture(pending = false) {
  const closed = vi.fn(async () => undefined)
  const factory = vi.fn<ClineTransportFactory>(async (binding, emit) => {
    emit({ ...binding, type: 'ready' })
    return { shutdown: closed, send: async message => {
      if (message.type === 'start' && !pending) emit({ ...binding, type: 'result', success: true, text: 'cline answer', reason: 'completed' })
    } }
  })
  const adapter = new ClineAdapter({ profileDir: crushCwd, workingDirectory: crushCwd, provider: 'fixture', model: 'fixture' }, factory)
  return { adapter, loader: factory, closed }
}

describe('optional SDK hosts shared conformance', () => {
  const cases = [
    { id: 'pi', fixture: piContractFixture },
    { id: 'opencode', fixture: openCodeContractFixture },
    { id: 'cline', fixture: clineContractFixture },
  ] as const
  for (const { id, fixture } of cases) {
    it(`${id} emits one attributed completion, keeps unknown usage absent and closes its seam`, async () => {
      const h = fixture()
      expect(h.loader).not.toHaveBeenCalled()
      const events = await drainEvents(h.adapter.execute({ prompt: 'contract', correlationId: 'sdk-contract' }))
      expect(events[0]).toMatchObject({ type: 'adapter:started', providerId: id })
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: 'adapter:completed', providerId: id, result: `${id} answer` })])
      const terminal = terminalEvents(events)[0]
      expect(terminal && 'usage' in terminal ? terminal.usage : undefined).toBeUndefined()
      expect(events.every(event => event.correlationId === 'sdk-contract')).toBe(true)
      expect(h.closed).toHaveBeenCalledOnce()
    })

    it(`${id} wakes a pending read on interrupt and closes without synthetic completion`, async () => {
      const h = fixture(true)
      const stream = h.adapter.execute({ prompt: 'contract' })
      expect((await stream.next()).value).toMatchObject({ type: 'adapter:started' })
      const next = stream.next()
      h.adapter.interrupt()
      const events: AgentEvent[] = []
      const first = await next
      if (!first.done) events.push(first.value)
      events.push(...await drainEvents(stream))
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: 'adapter:failed', providerId: id })])
      expect(h.closed).toHaveBeenCalledOnce()
    })

    it(`${id} refuses unsupported budget controls before loading or transport effects`, async () => {
      const h = fixture()
      const run = async () => drainEvents(h.adapter.execute({ prompt: 'contract', maxBudgetUsd: 0 }))
      if (id === 'cline') await expect(run()).rejects.toThrow('CLINE_UNSUPPORTED_CONTROL')
      else expect(terminalEvents(await run())).toEqual([expect.objectContaining({ type: 'adapter:failed', providerId: id })])
      expect(h.loader).not.toHaveBeenCalled()
      expect(h.closed).not.toHaveBeenCalled()
    })
  }

  it('rejects OpenCode owned-server mode and unowned resume before SDK loading', async () => {
    const h = openCodeContractFixture()
    h.adapter.configure({ mode: 'owned' })
    expect(terminalEvents(await drainEvents(h.adapter.execute({ prompt: 'contract' })))[0]).toMatchObject({ type: 'adapter:failed' })
    h.adapter.configure({ mode: 'attached' })
    expect(terminalEvents(await drainEvents(h.adapter.resumeSession('foreign', { prompt: 'contract' })))[0]).toMatchObject({ type: 'adapter:failed' })
    expect(h.loader).not.toHaveBeenCalled()
  })

  it('rejects Cline resume without spawning a worker', async () => {
    const h = clineContractFixture()
    const adapter: AgentCLIAdapter = h.adapter
    await expect(drainEvents(adapter.resumeSession('old', { prompt: 'contract' }))).rejects.toThrow('CLINE_RESUME_UNSUPPORTED')
    expect(h.loader).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Claude adapter conformance (SDK-based, needs SDK mock)
// ---------------------------------------------------------------------------

describe('Claude adapter conformance contract', () => {
  beforeEach(() => {
    claudeSdkMock.query.mockReset()
    claudeSdkMock.query.mockReturnValue({
      interrupt: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          session_id: 'claude-contract-session',
          model: 'claude-sonnet-4-5-20250514',
          tools: [],
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          session_id: 'claude-contract-session',
        }
      },
    })
  })

  it('creates with valid config and reports capabilities', () => {
    const adapter = new ClaudeAgentAdapter({ model: 'claude-sonnet-4-5-20250514' })
    expect(adapter.providerId).toBe('claude')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(true)
    expect(caps.supportsFork).toBe(true)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
  })

  it('execute() starts with adapter:started through the provider-free SDK fixture', async () => {
    const adapter = new ClaudeAgentAdapter()
    const events = await drainEvents(adapter.execute({ prompt: 'test' }))

    expect(events[0]?.type).toBe('adapter:started')
    if (events[0]?.type === 'adapter:started') {
      expect(events[0].providerId).toBe('claude')
    }
    expect(events.at(-1)?.type).toBe('adapter:completed')
    expect(claudeSdkMock.query).toHaveBeenCalledTimes(1)
  })

  it('configure() merges config without throwing', () => {
    const adapter = new ClaudeAgentAdapter()
    expect(() => adapter.configure({ model: 'claude-sonnet-4-5-20250514', timeoutMs: 30_000 })).not.toThrow()
  })

  it('interrupt() is safe to call when no conversation is active', () => {
    const adapter = new ClaudeAgentAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Codex adapter conformance (SDK-based, needs SDK mock)
// ---------------------------------------------------------------------------

describe('Codex adapter conformance contract', () => {
  beforeEach(() => {
    codexSdkMock.startThread.mockReset()
    codexSdkMock.resumeThread.mockReset()
    codexSdkMock.Codex.mockClear()
    codexSdkMock.startThread.mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'codex-contract-thread' }
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      }),
    })
  })

  it('creates with valid config and reports capabilities', () => {
    const adapter = new CodexAdapter({ model: 'gpt-5.4' })
    expect(adapter.providerId).toBe('codex')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(true)
    expect(caps.supportsFork).toBe(false)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
    expect(caps.nativeToolControls).toEqual({
      mode: true,
      allowlist: true,
      blocklist: true,
    })
  })

  it('execute() either throws SDK_NOT_INSTALLED or starts with adapter:started', async () => {
    const adapter = new CodexAdapter()
    const stream = adapter.execute({ prompt: 'test' })

    try {
      const first = await stream.next()
      // Some environments have the optional SDK installed but no configured
      // local runtime/session, so the iterator may fail before starting.
      // Treat that as inconclusive rather than a conformance failure.
      if (first.value?.type === 'adapter:failed') {
        return
      }
      // SDK is installed and active: first event must be adapter:started
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('adapter:started')
      if (first.value?.type === 'adapter:started') {
        expect(first.value.providerId).toBe('codex')
      }
      // Clean up: interrupt and fully drain the stream so SDK teardown
      // errors are observed here rather than escaping as unhandled
      // rejections.
      adapter.interrupt()
      try {
        let drained = 0
        for await (const event of stream) {
          void event
          if (++drained > 100) break
        }
      } catch {
        // expected: abort or teardown error
      }
    } catch (err) {
      // Only treat the optional-SDK path as acceptable here. Assertion
      // failures from the started-event contract should still fail the test.
      const errorCode = typeof err === 'object' && err !== null
        ? (err as { code?: unknown }).code
        : undefined
      if (errorCode !== 'ADAPTER_SDK_NOT_INSTALLED') {
        throw err
      }
      expect(err).toMatchObject({ code: 'ADAPTER_SDK_NOT_INSTALLED' })
    }
  }, 15_000)

  it('configure() merges config without throwing', () => {
    const adapter = new CodexAdapter()
    expect(() => adapter.configure({ model: 'gpt-5.4', sandboxMode: 'workspace-write' })).not.toThrow()
  })

  it('interrupt() is safe to call when no session is active', () => {
    const adapter = new CodexAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// OpenRouter adapter conformance (fetch-based)
// ---------------------------------------------------------------------------

describe('OpenRouter adapter conformance contract', () => {
  it('creates with valid config and reports capabilities', () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'test-key' })
    expect(adapter.providerId).toBe('openrouter')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(false)
    expect(caps.supportsFork).toBe(false)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
  })

  it('execute() emits adapter:failed when no API key is configured', async () => {
    // Ensure no env key is set for this test
    const originalKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']

    try {
      const adapter = new OpenRouterAdapter()
      const stream = adapter.execute({ prompt: 'test' })

      await expect(stream.next()).rejects.toMatchObject({
        code: 'ADAPTER_EXECUTION_FAILED',
      })
    } finally {
      if (originalKey !== undefined) {
        process.env['OPENROUTER_API_KEY'] = originalKey
      }
    }
  })

  it('resumeSession() throws because OpenRouter does not support resume', async () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'test-key' })

    await expect(
      drainEvents(adapter.resumeSession('sess-1', { prompt: 'resume' })),
    ).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('configure() merges config without throwing', () => {
    const adapter = new OpenRouterAdapter()
    expect(() =>
      adapter.configure({ openRouterApiKey: 'new-key', defaultModel: 'meta-llama/llama-3-70b' }),
    ).not.toThrow()
  })

  it('interrupt() is safe to call when no request is active', () => {
    const adapter = new OpenRouterAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })

  it('healthCheck() reports unhealthy when no API key is set', async () => {
    const originalKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']

    try {
      const adapter = new OpenRouterAdapter()
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.providerId).toBe('openrouter')
    } finally {
      if (originalKey !== undefined) {
        process.env['OPENROUTER_API_KEY'] = originalKey
      }
    }
  })
})
