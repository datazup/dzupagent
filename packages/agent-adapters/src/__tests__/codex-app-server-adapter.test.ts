import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Transform } from 'node:stream'

import { ForgeError } from '@dzupagent/core'
import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionAttemptBinding,
} from '@dzupagent/runtime-contracts/provider-session'
import { describe, expect, it, vi } from 'vitest'

import {
  CodexAppServerAdapter,
  createCodexAppServerAdapter,
} from '../codex/codex-app-server-adapter.js'
import { CodexAppServerStdioClient } from '../codex/codex-app-server-client.js'
import { CodexAdapter } from '../codex/codex-adapter.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
} from '../types.js'

interface RpcFrame {
  readonly id?: number | string | undefined
  readonly method?: string | undefined
  readonly params?: Record<string, unknown> | undefined
}

interface FakeServer {
  readonly child: ChildProcess
  readonly stdout: PassThrough
  readonly calls: RpcFrame[]
  readonly stalledWrites: RpcFrame[]
}

type TurnScenario = (server: FakeServer, frame: RpcFrame) => void

interface FakeServerOptions {
  readonly stallMethod?: 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start' | undefined
  readonly stallInitializedWrite?: boolean | undefined
  readonly onInterrupt?: TurnScenario | undefined
  readonly results?: Readonly<Partial<Record<
    'initialize' | 'thread/start' | 'thread/resume' | 'turn/start',
    unknown
  >>> | undefined
}

const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`

/*
 * The adapter's execution deadline is measured against a monotonic clock it
 * imports from `node:perf_hooks`, which `vi.useFakeTimers()` cannot reach -- it
 * replaces the global `performance`, not a module binding captured at import
 * time. A fake-timer test that leaves the default in place therefore races real
 * wall time against its own tiny `timeoutMs`, and on a loaded host setup alone
 * outruns it. Injecting the faked global makes the deadline advance with
 * `advanceTimersByTimeAsync` and nothing else.
 */
const fakeMonotonicNow = (): number => globalThis.performance.now()

function executableIdentity(path = '/fixture/codex', realPath = path) {
  return { name: 'codex', path, realPath, artifactDigest: ARTIFACT_DIGEST }
}

function runtimeDependencies(
  child: ChildProcess,
  extras: {
    readonly now?: (() => number) | undefined
    readonly monotonicNow?: (() => number) | undefined
    readonly realpath?: ((path: string) => Promise<string>) | undefined
    readonly stat?: ((path: string) => Promise<{ isFile(): boolean }>) | undefined
    readonly access?: ((path: string, mode?: number) => Promise<void>) | undefined
    readonly digestArtifact?: ((path: string) => Promise<string>) | undefined
  } = {},
) {
  return {
    spawn: () => child,
    realpath: extras.realpath ?? (async (path: string) => path),
    stat: extras.stat ?? (async () => ({ isFile: () => true })),
    access: extras.access ?? (async () => undefined),
    digestArtifact: extras.digestArtifact ?? (async () => ARTIFACT_DIGEST),
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.monotonicNow ? { monotonicNow: extras.monotonicNow } : {}),
  }
}

function binding(
  unsupported: readonly string[] = [],
): ProviderSessionAttemptBinding {
  const native = new Set([
    'execute',
    'stream',
    'resume',
    'cancel',
    'usage',
    'interrupt-turn',
    'goal-control',
  ])
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: 'binding-app-server',
    executionAttemptId: 'attempt-app-server',
    authSourceRef: 'auth-source://test/codex',
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: 'descriptor-app-server',
      providerId: 'codex',
      backend: {
        id: 'codex-app-server@test',
        kind: 'app-server',
        version: '0.147.0',
        protocolSchemaRef: 'codex-app-server://generated-json-schema/0.147.0',
        protocolSchemaDigest: `sha256:${'a'.repeat(64)}`,
        artifactDigest: ARTIFACT_DIGEST,
      },
      capabilities: Object.fromEntries(PROVIDER_SESSION_CAPABILITIES.map((capability) => [
        capability,
        !native.has(capability) || unsupported.includes(capability)
          ? {
              status: 'unsupported',
              emulation: 'forbidden',
              reason: 'fixture-unsupported',
            }
          : { status: 'native', emulation: 'forbidden' },
      ])) as ProviderSessionAttemptBinding['descriptor']['capabilities'],
      observedAt: '2026-08-13T00:00:00.000Z',
    },
    effectAuthorities: Object.fromEntries(PROVIDER_SESSION_EFFECTS.map((effect) => [
      effect,
      {
        effect,
        retryAuthorityId: 'io/provider-effect-retry',
        fallbackAuthorityId: 'io/provider-route-fallback',
        maxRetries: 0,
        fallback: 'none',
      },
    ])) as ProviderSessionAttemptBinding['effectAuthorities'],
    boundAt: '2026-08-13T00:00:00.000Z',
  }
}

function fakeServer(
  scenario: TurnScenario,
  resumeThreadId = 'thread-1',
  options: FakeServerOptions = {},
): FakeServer {
  const child = new EventEmitter() as ChildProcess
  const stalledWrites: RpcFrame[] = []
  const stdin = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const frame = JSON.parse(chunk.toString('utf8')) as RpcFrame
      if (options.stallInitializedWrite && frame.method === 'initialized') {
        stalledWrites.push(frame)
        return
      }
      callback(null, chunk)
    },
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const calls: RpcFrame[] = []
  const server: FakeServer = { child, stdout, calls, stalledWrites }
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    }),
  })

  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const frame = JSON.parse(buffer.slice(0, boundary)) as RpcFrame
      buffer = buffer.slice(boundary + 1)
      calls.push(frame)
      if (frame.method === options.stallMethod) {
        continue
      } else if (frame.method === 'initialize') {
        respond(server, frame.id, resultFor(options, 'initialize', initializeResponse()))
      } else if (frame.method === 'thread/start') {
        respond(server, frame.id, resultFor(options, 'thread/start', threadResponse('thread-1')))
      } else if (frame.method === 'thread/resume') {
        respond(server, frame.id, resultFor(options, 'thread/resume', threadResponse(resumeThreadId)))
      } else if (frame.method === 'turn/start') {
        respond(server, frame.id, resultFor(options, 'turn/start', {
          turn: turnPayload('turn-1', 'inProgress'),
        }))
        scenario(server, frame)
      } else if (frame.method === 'turn/interrupt') {
        if (options.onInterrupt) options.onInterrupt(server, frame)
        else {
          respond(server, frame.id, {})
          notify(server, 'turn/completed', {
            threadId: resumeThreadId,
            turn: turnPayload('turn-1', 'interrupted'),
          })
        }
      }
    }
  })
  return server
}

function resultFor(
  options: FakeServerOptions,
  method: 'initialize' | 'thread/start' | 'thread/resume' | 'turn/start',
  fallback: unknown,
): unknown {
  return options.results && Object.hasOwn(options.results, method)
    ? options.results[method]
    : fallback
}

function initializeResponse(): Record<string, unknown> {
  return {
    codexHome: '/fixture/codex-home',
    platformFamily: 'unix',
    platformOs: 'linux',
    userAgent: 'codex_cli_rs/0.147.0',
  }
}

function threadPayload(id: string): Record<string, unknown> {
  return {
    cliVersion: '0.147.0',
    createdAt: 1,
    cwd: '/fixture/workspace',
    ephemeral: false,
    id,
    modelProvider: 'openai',
    preview: '',
    sessionId: id,
    source: 'appServer',
    status: { type: 'idle' },
    turns: [],
    updatedAt: 1,
  }
}

function threadResponse(id: string): Record<string, unknown> {
  return {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    cwd: '/fixture/workspace',
    model: 'gpt-5.6',
    modelProvider: 'openai',
    sandbox: { type: 'readOnly' },
    thread: threadPayload(id),
  }
}

function turnPayload(
  id: string,
  status: 'completed' | 'failed' | 'inProgress' | 'interrupted',
): Record<string, unknown> {
  return { id, items: [], status }
}

function respond(server: FakeServer, id: RpcFrame['id'], result: unknown): void {
  server.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function rejectResponse(server: FakeServer, id: RpcFrame['id']): void {
  server.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32_000, message: 'provider-owned private failure' },
  })}\n`)
}

function notify(
  server: FakeServer,
  method: string,
  params: Record<string, unknown>,
  id?: string,
): void {
  server.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    ...(id ? { id } : {}),
    method,
    params,
  })}\n`)
}

function completedScenario(server: FakeServer): void {
  notify(server, 'thread/started', { thread: threadPayload('thread-1') })
  notify(server, 'turn/started', {
    threadId: 'thread-1',
    turn: turnPayload('turn-1', 'inProgress'),
  })
  notify(server, 'item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    delta: 'qualified',
  })
  notifyUsage(server)
  notify(server, 'item/fileChange/requestApproval', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-approval',
    reason: 'provider-owned private reason',
  }, 'approval-1')
  notify(server, 'turn/completed', {
    threadId: 'thread-1',
    turn: turnPayload('turn-1', 'completed'),
  })
}

function notifyUsage(server: FakeServer, threadId = 'thread-1'): void {
  notify(server, 'thread/tokenUsage/updated', {
    threadId,
    turnId: 'turn-1',
    tokenUsage: {
      last: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 18,
      },
      total: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
        totalTokens: 18,
      },
    },
  })
}

async function collect(
  events: AsyncGenerator<AgentEvent, void, undefined>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

function input(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: 'Run the provider-free fixture',
    correlationId: 'correlation-1',
    ...overrides,
  }
}

const ZERO_TOOL_REQUIREMENT: AdapterExecutionControlRequirement = {
  schema: 'dzupagent/adapter-execution-control-requirement/v1',
  tools: { mode: 'none' },
}

const ZERO_TOOL_REJECTION: AdapterExecutionControlAdmission = {
  schema: 'dzupagent/adapter-execution-control-admission/v1',
  status: 'rejected',
  providerId: 'codex',
  requirementSha256: 'sha256:e367236e0d9802cbfd0f42190c9173d577c12ad4cbdd8b258721900eb78e5731',
  tools: { mode: 'none', enforcement: 'unsupported' },
  blockers: ['zero_tool_dispatch_unsupported'],
  effects: {
    credentialReads: 0,
    networkAttempts: 0,
    providerDispatches: 0,
    providerSpendUsd: 0,
  },
}

const ZERO_TOOL_DIRECT_DENIAL: AdapterExecutionControlAdmission = {
  ...ZERO_TOOL_REJECTION,
  blockers: ['zero_tool_dispatch_capability_missing'],
}

function zeroToolInput(): AgentInput {
  return input({
    executionControlRequirement: ZERO_TOOL_REQUIREMENT,
    policyContext: {
      activePolicy: {
        toolPolicy: 'strict',
        allowedTools: [],
        blockedTools: [],
      },
      conformanceMode: 'strict',
    },
  })
}

interface AppServerEffectSnapshot {
  readonly runtimeValidations: number
  readonly clockReads: number
  readonly connections: number
  readonly spawns: number
  readonly threadStarts: number
  readonly threadResumes: number
  readonly turnStarts: number
  readonly startedEvents: number
}

const ZERO_APP_SERVER_EFFECTS: AppServerEffectSnapshot = {
  runtimeValidations: 0,
  clockReads: 0,
  connections: 0,
  spawns: 0,
  threadStarts: 0,
  threadResumes: 0,
  turnStarts: 0,
  startedEvents: 0,
}

async function observeAppServerRun(
  run: (
    adapter: CodexAppServerAdapter,
  ) => AsyncGenerator<AgentEvent, void, undefined>,
): Promise<{
  readonly effects: AppServerEffectSnapshot
  readonly failure: unknown
}> {
  const server = fakeServer(completedScenario)
  const spawn = vi.fn(() => server.child)
  const realpathCall = vi.fn(async (path: string) => path)
  const stat = vi.fn(async () => ({ isFile: () => true }))
  const access = vi.fn(async () => undefined)
  const digestArtifact = vi.fn(async () => ARTIFACT_DIGEST)
  const now = vi.fn(() => 1_000)
  const monotonicNow = vi.fn(() => 1_000)
  const connect = vi.spyOn(CodexAppServerStdioClient, 'connect')
  const adapter = createCodexAppServerAdapter({
    attemptBinding: binding(),
    executable: executableIdentity(),
    dependencies: {
      spawn,
      realpath: realpathCall,
      stat,
      access,
      digestArtifact,
      now,
      monotonicNow,
    },
  })

  let failure: unknown
  const events: AgentEvent[] = []
  let effects: AppServerEffectSnapshot = ZERO_APP_SERVER_EFFECTS
  try {
    for await (const event of run(adapter)) events.push(event)
  } catch (error) {
    failure = error
  } finally {
    effects = {
      runtimeValidations:
        realpathCall.mock.calls.length
        + stat.mock.calls.length
        + access.mock.calls.length
        + digestArtifact.mock.calls.length,
      clockReads: now.mock.calls.length + monotonicNow.mock.calls.length,
      connections: connect.mock.calls.length,
      spawns: spawn.mock.calls.length,
      threadStarts: server.calls.filter((frame) => frame.method === 'thread/start').length,
      threadResumes: server.calls.filter((frame) => frame.method === 'thread/resume').length,
      turnStarts: server.calls.filter((frame) => frame.method === 'turn/start').length,
      startedEvents: events.filter((event) => event.type === 'adapter:started').length,
    }
    connect.mockRestore()
  }
  return { effects, failure }
}

function interruptRequest() {
  return {
    schema: PROVIDER_SESSION_OPERATION_SCHEMA,
    operationId: 'operation-interrupt-turn',
    attemptBindingId: 'binding-app-server',
    kind: 'interrupt-turn',
    session: {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: 'session',
      opaqueId: 'thread-1',
    },
    turn: {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: 'turn',
      opaqueId: 'turn-1',
    },
  } as const
}

describe('Codex App Server provider-session adapter', () => {
  it('returns one stable unsupported admission from the selected app-server instance', () => {
    const server = fakeServer(completedScenario)
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    expect(adapter.getCapabilities().supportsZeroToolDispatch).toBe(false)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
  })

  it.each(['execute', 'resume'] as const)(
    'rejects direct %s before runtime validation, clocks, connection, spawn, or RPC',
    async (operation) => {
      const { effects, failure } = await observeAppServerRun((adapter) =>
        operation === 'execute'
          ? adapter.execute(zeroToolInput())
          : adapter.resumeSession('thread-1', zeroToolInput()))

      expect(effects).toEqual(ZERO_APP_SERVER_EFFECTS)
      expect(failure).toBeInstanceOf(ForgeError)
      expect(failure).toMatchObject({
        code: 'CAPABILITY_DENIED',
        recoverable: false,
        context: { admission: ZERO_TOOL_DIRECT_DENIAL },
      })
    },
  )

  it('rejects an opted-in invalid resume reference before clocks, validation, connection, spawn, or RPC', async () => {
    const { effects, failure } = await observeAppServerRun((adapter) =>
      adapter.resumeSession('', zeroToolInput()))

    expect(effects).toEqual(ZERO_APP_SERVER_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: { admission: ZERO_TOOL_DIRECT_DENIAL },
    })
  })

  it('keeps SDK default and admits app-server only with an exact complete binding', () => {
    expect(createCodexBackendAdapter()).toBeInstanceOf(CodexAdapter)

    const server = fakeServer(completedScenario)
    expect(createCodexBackendAdapter({
      backend: 'app-server',
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })).toBeInstanceOf(CodexAppServerAdapter)

    const spawn = vi.fn(() => server.child)
    expect(() => createCodexAppServerAdapter({
      attemptBinding: binding(['usage']),
      executable: executableIdentity(),
      dependencies: {
        ...runtimeDependencies(server.child),
        spawn,
      },
    })).toThrow(/admitted exact base-capability binding/u)
    expect(spawn).not.toHaveBeenCalled()

    expect(() => createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity('codex', 'codex'),
    })).toThrow(/resolved qualified executable identity/u)
    expect(() => createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: { ...executableIdentity(), name: 'not-codex' },
    })).toThrow(/resolved qualified executable identity/u)
    expect(() => createCodexAppServerAdapter({
      attemptBinding: binding(),
    } as never)).toThrow(/resolved qualified executable identity/u)
  })

  it('reports an unavailable qualified executable without starting a process', async () => {
    const server = fakeServer(completedScenario)
    const spawn = vi.fn()
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity('/fixture/missing-codex'),
      dependencies: {
        ...runtimeDependencies(server.child, {
          access: async () => { throw new Error('missing') },
        }),
        spawn,
      },
    })

    await expect(adapter.healthCheck()).resolves.toEqual(expect.objectContaining({
      healthy: false,
      cliAvailable: false,
      lastError: 'Qualified Codex executable is unavailable',
    }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects drifted and non-executable runtime identities before spawn', async () => {
    const server = fakeServer(completedScenario)
    const driftedSpawn = vi.fn(() => server.child)
    const drifted = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: {
        ...runtimeDependencies(server.child, {
          realpath: async () => '/fixture/replaced-codex',
        }),
        spawn: driftedSpawn,
      },
    })
    const driftedEvents = await collect(drifted.execute(input()))
    expect(driftedEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    }))
    expect(driftedSpawn).not.toHaveBeenCalled()

    const nonExecutableSpawn = vi.fn(() => server.child)
    const nonExecutable = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: {
        ...runtimeDependencies(server.child, {
          access: async () => { throw new Error('not executable') },
        }),
        spawn: nonExecutableSpawn,
      },
    })
    const nonExecutableEvents = await collect(nonExecutable.execute(input()))
    expect(nonExecutableEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    }))
    expect(nonExecutableSpawn).not.toHaveBeenCalled()

    const changedArtifactSpawn = vi.fn(() => server.child)
    const changedArtifact = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: {
        ...runtimeDependencies(server.child, {
          digestArtifact: async () => `sha256:${'c'.repeat(64)}`,
        }),
        spawn: changedArtifactSpawn,
      },
    })
    const changedArtifactEvents = await collect(changedArtifact.execute(input()))
    expect(changedArtifactEvents.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    }))
    expect(changedArtifactSpawn).not.toHaveBeenCalled()
    expect(JSON.stringify([...driftedEvents, ...nonExecutableEvents])).not.toContain('/fixture/')
  })

  it('rejects a searchable directory identity before spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dzupagent-app-server-executable-'))
    try {
      const server = fakeServer(completedScenario)
      const spawn = vi.fn(() => server.child)
      const adapter = createCodexAppServerAdapter({
        attemptBinding: binding(),
        executable: executableIdentity(directory, await realpath(directory)),
        dependencies: { spawn },
      })

      const events = await collect(adapter.execute(input()))
      expect(events.at(-1)).toEqual(expect.objectContaining({
        type: 'adapter:failed',
        code: 'CODEX_APP_SERVER_EXECUTABLE_INVALID',
      }))
      expect(spawn).not.toHaveBeenCalled()
      expect(JSON.stringify(events)).not.toContain(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('starts one thread/turn and emits bounded normalized stream, usage, and passive interaction events', async () => {
    const server = fakeServer(completedScenario)
    let now = 100
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child, { now: () => now++ }),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:interaction_required',
      'adapter:completed',
    ])
    expect(events[1]).toEqual(expect.objectContaining({ content: 'qualified' }))
    expect(events[2]).toEqual(expect.objectContaining({
      kind: 'permission',
      question: 'Codex requires an explicit approval decision.',
    }))
    expect(JSON.stringify(events[2])).not.toContain('private reason')
    expect(events[3]).toEqual(expect.objectContaining({
      result: 'qualified',
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
      },
    }))
    // execute() is declared to yield AgentEvent (provider_raw excluded); widening
    // here keeps the leak check an honest runtime assertion rather than a tautology.
    const streamEvents: AgentStreamEvent[] = events
    expect(streamEvents.some((event) => event.type === 'adapter:provider_raw')).toBe(false)
    expect(server.calls.some((frame) => frame.id === 'approval-1' && !frame.method)).toBe(false)
  })

  it.each([
    [
      'cwd',
      { workingDirectory: '/requested/workspace' },
      threadResponse('thread-1'),
    ],
    [
      'model',
      { model: 'requested-model' },
      threadResponse('thread-1'),
    ],
    [
      'sandbox',
      { sandboxMode: 'workspace-write' as const },
      threadResponse('thread-1'),
    ],
  ] as const)('rejects a mismatched effective %s before turn/start', async (
    _field,
    config,
    result,
  ) => {
    const server = fakeServer(completedScenario, 'thread-1', {
      results: { 'thread/start': result },
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      ...config,
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_THREAD_INVALID',
    }))
    expect(server.calls.some((frame) => frame.method === 'turn/start')).toBe(false)
  })

  it('rejects an incomplete thread response before turn/start', async () => {
    const complete = threadResponse('thread-1')
    const { model: _model, ...incomplete } = complete
    const server = fakeServer(completedScenario, 'thread-1', {
      results: { 'thread/start': incomplete },
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_THREAD_INVALID',
    }))
    expect(server.calls.some((frame) => frame.method === 'turn/start')).toBe(false)
  })

  it('rejects an incomplete turn/start response before adapter start', async () => {
    const server = fakeServer(completedScenario, 'thread-1', {
      results: { 'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } } },
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events).toEqual([
      expect.objectContaining({
        type: 'adapter:failed',
        code: 'CODEX_APP_SERVER_TURN_INVALID',
      }),
    ])
  })

  it.each([
    ['thread/started', (server: FakeServer): void => {
      notify(server, 'thread/started', { thread: { id: 'thread-1' } })
    }],
    ['turn/started', (server: FakeServer): void => {
      notify(server, 'turn/started', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'inProgress' },
      })
    }],
    ['turn/completed', (_server: FakeServer): void => undefined],
  ] as const)('rejects an incomplete %s notification without completion', async (
    method,
    prefix,
  ) => {
    const server = fakeServer((current) => {
      prefix(current)
      notifyUsage(current)
      notify(current, 'turn/completed', {
        threadId: 'thread-1',
        turn: method === 'turn/completed'
          ? { id: 'turn-1', status: 'completed' }
          : turnPayload('turn-1', 'completed'),
      })
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: method === 'thread/started'
        ? 'CODEX_APP_SERVER_THREAD_INVALID'
        : 'CODEX_APP_SERVER_TURN_INVALID',
    }))
    expect(events.some((event) => event.type === 'adapter:completed')).toBe(false)
  })

  it('resumes the exact thread and completes one turn without synthesizing a new session', async () => {
    const server = fakeServer((current) => {
      notify(current, 'turn/started', {
        threadId: 'thread-9',
        turn: turnPayload('turn-1', 'inProgress'),
      })
      notifyUsage(current, 'thread-9')
      notify(current, 'turn/completed', {
        threadId: 'thread-9',
        turn: turnPayload('turn-1', 'completed'),
      })
    }, 'thread-9')
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.resumeSession('thread-9', input()))

    expect(events.at(0)).toEqual(expect.objectContaining({
      type: 'adapter:started',
      sessionId: 'thread-9',
      isResume: true,
    }))
    expect(server.calls.find((frame) => frame.method === 'thread/resume')?.params)
      .toEqual(expect.objectContaining({ threadId: 'thread-9' }))
    expect(server.calls.some((frame) => frame.method === 'thread/start')).toBe(false)
  })

  it('interrupts the exact active turn and rejects stale-turn notifications', async () => {
    const interruptServer = fakeServer(() => undefined)
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(interruptServer.child),
    })
    const stream = adapter.execute(input())
    await expect(stream.next()).resolves.toEqual(expect.objectContaining({
      value: expect.objectContaining({ type: 'adapter:started' }),
      done: false,
    }))
    adapter.interrupt()
    const interrupted = await collect(stream)
    expect(interrupted.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_CANCELLED',
    }))
    expect(interruptServer.calls.find((frame) => frame.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 'turn-1' })

    const staleServer = fakeServer((current) => {
      notify(current, 'item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'stale-turn',
        itemId: 'item-1',
        delta: 'must not pass',
      })
    })
    const staleAdapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(staleServer.child),
    })
    const stale = await collect(staleAdapter.execute(input()))
    expect(stale.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_STALE_TURN',
    }))
  })

  it('maps process death and execution timeout to stable terminal failures', async () => {
    const deathServer = fakeServer((current) => {
      current.child.emit('exit', 17, null)
    })
    const deathAdapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(deathServer.child),
    })
    const death = await collect(deathAdapter.execute(input()))
    expect(death.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_PROCESS_DIED',
    }))

    // This half runs on real timers, and it asserts the deadline fires *after*
    // the turn is live -- an interrupt is only possible once there is an active
    // run. Freezing the monotonic clock stops setup from consuming the budget
    // before it finishes, and the margin keeps the real timer from firing first
    // on a loaded host; at 10 ms the two raced and setup lost about half the time.
    const timeoutServer = fakeServer(() => undefined)
    const timeoutAdapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      timeoutMs: 250,
      dependencies: runtimeDependencies(timeoutServer.child, { monotonicNow: () => 0 }),
    })
    const timeout = await collect(timeoutAdapter.execute(input()))
    expect(timeout.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
    }))
    expect(timeoutServer.calls.some((frame) => frame.method === 'turn/interrupt')).toBe(true)
  })

  it('keeps timeout terminal-authoritative when success and late frames arrive before interrupt acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeServer(
        () => undefined,
        'thread-1',
        {
          onInterrupt: (current, frame) => {
            notify(current, 'item/agentMessage/delta', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'late-item',
              delta: 'must-not-leak',
            })
            notify(current, 'item/tool/requestUserInput', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'late-input',
            }, 'late-request')
            notifyUsage(current)
            notify(current, 'turn/completed', {
              threadId: 'thread-1',
              turn: turnPayload('turn-1', 'completed'),
            })
            respond(current, frame.id, {})
          },
        },
      )
      const adapter = createCodexAppServerAdapter({
        attemptBinding: binding(),
        executable: executableIdentity(),
        timeoutMs: 10,
        dependencies: runtimeDependencies(server.child, { monotonicNow: fakeMonotonicNow }),
      })
      const stream = adapter.execute(input())
      await expect(stream.next()).resolves.toEqual(expect.objectContaining({
        value: expect.objectContaining({ type: 'adapter:started' }),
        done: false,
      }))
      const remaining = collect(stream)

      await vi.advanceTimersByTimeAsync(10)

      const events = await remaining
      expect(events).toEqual([
        expect.objectContaining({
          type: 'adapter:failed',
          code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
        }),
      ])
      expect(JSON.stringify(events)).not.toContain('must-not-leak')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps cancellation terminal-authoritative when completion races interrupt acknowledgement', async () => {
    const controller = new AbortController()
    const server = fakeServer(
      () => undefined,
      'thread-1',
      {
        onInterrupt: (current, frame) => {
          notify(current, 'item/agentMessage/delta', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'late-item',
            delta: 'must-not-leak',
          })
          notify(current, 'item/fileChange/requestApproval', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'late-approval',
          }, 'late-approval-request')
          notifyUsage(current)
          notify(current, 'turn/completed', {
            threadId: 'thread-1',
            turn: turnPayload('turn-1', 'completed'),
          })
          respond(current, frame.id, {})
        },
      },
    )
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })
    const stream = adapter.execute(input({ signal: controller.signal }))
    await expect(stream.next()).resolves.toEqual(expect.objectContaining({
      value: expect.objectContaining({ type: 'adapter:started' }),
      done: false,
    }))

    controller.abort()
    const events = await collect(stream)

    expect(events).toEqual([
      expect.objectContaining({
        type: 'adapter:failed',
        code: 'CODEX_APP_SERVER_CANCELLED',
      }),
    ])
    expect(JSON.stringify(events)).not.toContain('must-not-leak')
  })

  it('applies the execution deadline to initialize, thread start/resume, and turn setup', async () => {
    vi.useFakeTimers()
    try {
      for (const stallMethod of [
        'initialize',
        'thread/start',
        'thread/resume',
        'turn/start',
      ] as const) {
        const server = fakeServer(() => undefined, 'thread-1', { stallMethod })
        const adapter = createCodexAppServerAdapter({
          attemptBinding: binding(),
          executable: executableIdentity(),
          timeoutMs: 10,
          clientLimits: {
            requestTimeoutMs: 50,
            cleanupTimeoutMs: 5,
          },
          dependencies: runtimeDependencies(server.child, { monotonicNow: fakeMonotonicNow }),
        })
        let settled = false
        const execution = stallMethod === 'thread/resume'
          ? adapter.resumeSession('thread-1', input())
          : adapter.execute(input())
        const result = collect(execution).then((events) => {
          settled = true
          return events
        })

        await vi.advanceTimersByTimeAsync(15)
        const settledWithinDeadlineAndGrace = settled
        await vi.advanceTimersByTimeAsync(50)
        const events = await result

        expect(settledWithinDeadlineAndGrace, stallMethod).toBe(true)
        expect(events.at(-1), stallMethod).toEqual(expect.objectContaining({
          type: 'adapter:failed',
          code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
        }))
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels stalled initialization within cleanup grace', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const server = fakeServer(
        () => undefined,
        'thread-1',
        { stallMethod: 'initialize' },
      )
      const adapter = createCodexAppServerAdapter({
        attemptBinding: binding(),
        executable: executableIdentity(),
        timeoutMs: 1_000,
        clientLimits: {
          requestTimeoutMs: 1_000,
          cleanupTimeoutMs: 5,
        },
        dependencies: runtimeDependencies(server.child, { monotonicNow: fakeMonotonicNow }),
      })
      let settled = false
      const result = collect(adapter.execute(input({ signal: controller.signal }))).then((events) => {
        settled = true
        return events
      })

      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await vi.advanceTimersByTimeAsync(10)
      const settledWithinCleanupGrace = settled
      await vi.advanceTimersByTimeAsync(1_000)
      const events = await result

      expect(settledWithinCleanupGrace).toBe(true)
      expect(events.at(-1)).toEqual(expect.objectContaining({
        type: 'adapter:failed',
        code: 'CODEX_APP_SERVER_CANCELLED',
      }))
      expect(server.child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(server.calls.some((frame) => frame.method === 'thread/start')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('interrupts every stalled setup stage within cleanup grace', async () => {
    vi.useFakeTimers()
    try {
      for (const stage of [
        'realpath',
        'stat',
        'access',
        'digest',
        'post-spawn-digest',
        'initialize',
        'initialized',
        'thread/start',
        'thread/resume',
        'turn/start',
      ] as const) {
        const stalledOperation = vi.fn(() => new Promise<never>(() => undefined))
        let digestCalls = 0
        const server = fakeServer(
          () => undefined,
          'thread-1',
          {
            ...(stage === 'initialized' ? { stallInitializedWrite: true } : {}),
            ...(stage === 'initialize'
              || stage === 'thread/start'
              || stage === 'thread/resume'
              || stage === 'turn/start'
              ? { stallMethod: stage }
              : {}),
          },
        )
        const spawn = vi.fn(() => server.child)
        const adapter = createCodexAppServerAdapter({
          attemptBinding: binding(),
          executable: executableIdentity(),
          timeoutMs: 1_000,
          clientLimits: {
            requestTimeoutMs: 1_000,
            cleanupTimeoutMs: 5,
          },
          dependencies: {
            ...runtimeDependencies(server.child, {
              monotonicNow: fakeMonotonicNow,
              ...(stage === 'realpath' ? { realpath: stalledOperation } : {}),
              ...(stage === 'stat' ? { stat: stalledOperation } : {}),
              ...(stage === 'access' ? { access: stalledOperation } : {}),
              ...(stage === 'digest' ? { digestArtifact: stalledOperation } : {}),
              ...(stage === 'post-spawn-digest'
                ? {
                    digestArtifact: async () => {
                      digestCalls += 1
                      return digestCalls === 1
                        ? ARTIFACT_DIGEST
                        : stalledOperation()
                    },
                  }
                : {}),
            }),
            spawn,
          },
        })
        let settled = false
        const execution = stage === 'thread/resume'
          ? adapter.resumeSession('thread-1', input())
          : adapter.execute(input())
        const result = collect(execution).then((events) => {
          settled = true
          return events
        })

        await vi.advanceTimersByTimeAsync(1)
        if (stage === 'realpath' || stage === 'stat' || stage === 'access' || stage === 'digest') {
          expect(stalledOperation, stage).toHaveBeenCalledTimes(1)
        } else if (stage === 'post-spawn-digest') {
          expect(digestCalls, stage).toBe(2)
          expect(stalledOperation, stage).toHaveBeenCalledTimes(1)
          expect(server.calls.some((frame) => frame.method === 'initialize'), stage).toBe(false)
        } else if (stage === 'initialized') {
          expect(server.stalledWrites, stage).toEqual([
            expect.objectContaining({ method: 'initialized' }),
          ])
        } else {
          expect(server.calls.some((frame) => frame.method === stage), stage).toBe(true)
        }

        adapter.interrupt()
        await vi.advanceTimersByTimeAsync(10)
        const settledWithinCleanupGrace = settled
        await vi.advanceTimersByTimeAsync(1_000)
        const events = await result

        expect(settledWithinCleanupGrace, stage).toBe(true)
        expect(events.at(-1), stage).toEqual(expect.objectContaining({
          type: 'adapter:failed',
          code: 'CODEX_APP_SERVER_CANCELLED',
        }))
        if (stage === 'realpath' || stage === 'stat' || stage === 'access' || stage === 'digest') {
          expect(spawn, stage).not.toHaveBeenCalled()
          expect(server.child.kill, stage).not.toHaveBeenCalled()
        } else {
          expect(spawn, stage).toHaveBeenCalledTimes(1)
          expect(server.child.kill, stage).toHaveBeenCalledTimes(1)
          expect(server.child.kill, stage).toHaveBeenCalledWith('SIGTERM')
        }
        if (stage === 'initialize' || stage === 'initialized') {
          expect(server.calls.some((frame) => frame.method === 'thread/start'), stage).toBe(false)
        }
        if (stage === 'thread/start' || stage === 'thread/resume') {
          expect(server.calls.some((frame) => frame.method === 'turn/start'), stage).toBe(false)
        }
        expect(vi.getTimerCount(), stage).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stalled timeout interrupt with a short cleanup grace', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeServer(
        () => undefined,
        'thread-1',
        { onInterrupt: () => undefined },
      )
      const adapter = createCodexAppServerAdapter({
        attemptBinding: binding(),
        executable: executableIdentity(),
        timeoutMs: 10,
        interruptGraceMs: 5,
        clientLimits: {
          requestTimeoutMs: 1_000,
          cleanupTimeoutMs: 5,
        },
        dependencies: runtimeDependencies(server.child, { monotonicNow: fakeMonotonicNow }),
      })
      const stream = adapter.execute(input())
      await stream.next()
      let settled = false
      const result = collect(stream).then((events) => {
        settled = true
        return events
      })

      await vi.advanceTimersByTimeAsync(15)
      const settledWithinGrace = settled
      await vi.advanceTimersByTimeAsync(1_000)
      const events = await result

      expect(settledWithinGrace).toBe(true)
      expect(events.at(-1)).toEqual(expect.objectContaining({
        type: 'adapter:failed',
        code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one interrupt acknowledgement and never accepts before the provider response', async () => {
    let interruptFrame: RpcFrame | undefined
    const server = fakeServer(
      () => undefined,
      'thread-1',
      { onInterrupt: (_current, frame) => { interruptFrame = frame } },
    )
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })
    const stream = adapter.execute(input())
    await stream.next()
    let firstSettled = false
    let secondSettled = false
    const first = adapter.interruptTurn(interruptRequest()).finally(() => { firstSettled = true })
    const second = adapter.interruptTurn(interruptRequest()).finally(() => { secondSettled = true })

    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeAcknowledgement = [firstSettled, secondSettled]
    expect(interruptFrame?.id).toBeDefined()
    respond(server, interruptFrame?.id, {})
    notify(server, 'turn/completed', {
      threadId: 'thread-1',
      turn: turnPayload('turn-1', 'interrupted'),
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'interrupt-turn', accepted: true },
      { kind: 'interrupt-turn', accepted: true },
    ])
    await collect(stream)
    expect(settledBeforeAcknowledgement).toEqual([false, false])
    expect(server.calls.filter((frame) => frame.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('shares an interrupt failure across every concurrent acknowledgement caller', async () => {
    let interruptFrame: RpcFrame | undefined
    const server = fakeServer(
      () => undefined,
      'thread-1',
      { onInterrupt: (_current, frame) => { interruptFrame = frame } },
    )
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })
    const stream = adapter.execute(input())
    await stream.next()
    const first = adapter.interruptTurn(interruptRequest())
    const second = adapter.interruptTurn(interruptRequest())

    await Promise.resolve()
    expect(interruptFrame?.id).toBeDefined()
    rejectResponse(server, interruptFrame?.id)
    notify(server, 'turn/completed', {
      threadId: 'thread-1',
      turn: turnPayload('turn-1', 'interrupted'),
    })
    const results = await Promise.allSettled([first, second])
    await collect(stream)

    expect(results).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'CODEX_APP_SERVER_REQUEST_FAILED' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'CODEX_APP_SERVER_REQUEST_FAILED' }),
      }),
    ])
    expect(server.calls.filter((frame) => frame.method === 'turn/interrupt')).toHaveLength(1)
  })

  it.each([
    ['null', null],
    ['boolean', false],
    ['number', 0],
    ['string', 'accepted'],
    ['array', []],
    ['nonempty object', { accepted: false }],
  ] as const)('rejects a schema-invalid %s interrupt acknowledgement for every caller', async (
    _shape,
    result,
  ) => {
    let interruptFrame: RpcFrame | undefined
    const server = fakeServer(
      () => undefined,
      'thread-1',
      { onInterrupt: (_current, frame) => { interruptFrame = frame } },
    )
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })
    const stream = adapter.execute(input())
    await stream.next()
    const first = adapter.interruptTurn(interruptRequest())
    const second = adapter.interruptTurn(interruptRequest())

    await Promise.resolve()
    expect(interruptFrame?.id).toBeDefined()
    respond(server, interruptFrame?.id, result)
    notify(server, 'turn/completed', {
      threadId: 'thread-1',
      turn: turnPayload('turn-1', 'interrupted'),
    })
    const results = await Promise.allSettled([first, second])
    await collect(stream)

    expect(results).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'CODEX_APP_SERVER_INTERRUPT_RESPONSE_INVALID',
        }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'CODEX_APP_SERVER_INTERRUPT_RESPONSE_INVALID',
        }),
      }),
    ])
    expect(server.calls.filter((frame) => frame.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('fails closed when terminal usage evidence is absent or malformed', async () => {
    const missingServer = fakeServer((current) => {
      notify(current, 'turn/completed', {
        threadId: 'thread-1',
        turn: turnPayload('turn-1', 'completed'),
      })
    })
    const missingAdapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(missingServer.child),
    })
    const missing = await collect(missingAdapter.execute(input()))
    expect(missing.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_USAGE_MISSING',
    }))

    const malformedServer = fakeServer((current) => {
      notify(current, 'thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 2,
          },
        },
      })
    })
    const malformedAdapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(malformedServer.child),
    })
    const malformed = await collect(malformedAdapter.execute(input()))
    expect(malformed.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_USAGE_INVALID',
    }))
  })

  /*
   * The turn event stream is the adapter's only inbound surface, and every
   * branch below is a refusal: the provider has emitted something the adapter
   * must not normalize into an ordinary event. They are pinned as one group
   * because the loop's value is precisely that a malformed turn cannot be
   * mistaken for a completed one.
   */
  it('refuses an unsupported provider-initiated request without answering it', async () => {
    const server = fakeServer((current) => {
      notify(current, 'turn/started', {
        threadId: 'thread-1',
        turn: turnPayload('turn-1', 'inProgress'),
      })
      notify(current, 'workspace/writeFile', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        path: '/fixture/workspace/private.txt',
      }, 'request-unsupported')
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_REQUEST_UNSUPPORTED',
    }))
    expect(events.some((event) => event.type === 'adapter:interaction_required')).toBe(false)
    // The refusal must stay silent on the wire: answering a request the adapter
    // does not understand would let the provider drive an unadmitted effect.
    expect(server.calls.some((frame) => frame.id === 'request-unsupported' && !frame.method))
      .toBe(false)
  })

  it('rejects a duplicated turn start', async () => {
    const server = fakeServer((current) => {
      notify(current, 'turn/started', {
        threadId: 'thread-1',
        turn: turnPayload('turn-1', 'inProgress'),
      })
      notify(current, 'turn/started', {
        threadId: 'thread-1',
        turn: turnPayload('turn-1', 'inProgress'),
      })
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_DUPLICATE_EVENT',
    }))
  })

  it('rejects an empty message delta instead of streaming it', async () => {
    const server = fakeServer((current) => {
      notify(current, 'item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: '',
      })
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_DELTA_INVALID',
    }))
    expect(events.some((event) => event.type === 'adapter:stream_delta')).toBe(false)
  })

  it('stops accumulating once the aggregate result exceeds its limit', async () => {
    // Individually admissible deltas: each is under both the delta bound and the
    // transport line bound, so only the running total can reject this stream.
    const delta = 'x'.repeat(500_000)
    const server = fakeServer((current) => {
      for (let index = 0; index < 5; index += 1) {
        notify(current, 'item/agentMessage/delta', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: `item-${String(index)}`,
          delta,
        })
      }
      notifyUsage(current)
      notify(current, 'turn/completed', {
        threadId: 'thread-1',
        turn: turnPayload('turn-1', 'completed'),
      })
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_RESULT_LIMIT',
    }))
    expect(events.some((event) => event.type === 'adapter:completed')).toBe(false)
  })

  it('maps a provider protocol error frame to a stable terminal failure', async () => {
    const server = fakeServer((current) => {
      notify(current, 'error', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        message: 'provider-owned private failure',
      })
    })
    const adapter = createCodexAppServerAdapter({
      attemptBinding: binding(),
      executable: executableIdentity(),
      dependencies: runtimeDependencies(server.child),
    })

    const events = await collect(adapter.execute(input()))

    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'adapter:failed',
      code: 'CODEX_APP_SERVER_PROTOCOL_ERROR',
    }))
    expect(JSON.stringify(events)).not.toContain('private failure')
  })
})
