import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from '@dzupagent/core/events'
import { CodexAdapter } from '../codex/codex-adapter.js'
import { CodexCliAdapter } from '../codex/codex-cli-adapter.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
} from '../types.js'

type FakeChild = ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  pid: number
}

const NATIVE_ID = '11111111-1111-1111-1111-111111111111'

function createChild(emitStarted = true): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.pid = Math.floor(Math.random() * 10_000) + 1
  child.kill = vi.fn()
  if (emitStarted) queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: NATIVE_ID }) + '\n'))
  return child
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, undefined>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
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
  return {
    prompt: 'bounded CLI prompt',
    executionControlRequirement: ZERO_TOOL_REQUIREMENT,
    policyContext: {
      activePolicy: {
        toolPolicy: 'strict',
        allowedTools: [],
        blockedTools: [],
      },
      conformanceMode: 'strict',
    },
  }
}

interface CliEffectSnapshot {
  readonly sessionIds: number
  readonly clockReads: number
  readonly controllers: number
  readonly startedEvents: number
  readonly homeAndEnvironmentProjections: number
  readonly environmentSpawns: number
  readonly spawns: number
}

const ZERO_CLI_EFFECTS: CliEffectSnapshot = {
  sessionIds: 0,
  clockReads: 0,
  controllers: 0,
  startedEvents: 0,
  homeAndEnvironmentProjections: 0,
  environmentSpawns: 0,
  spawns: 0,
}

async function observeCliRun(
  run: (
    adapter: CodexCliAdapter,
  ) => AsyncGenerator<AgentEvent | AgentStreamEvent, void, undefined>,
): Promise<{ readonly effects: CliEffectSnapshot; readonly failure: unknown }> {
  const child = createChild()
  const spawn = vi.fn((
    _command: string,
    _args: readonly string[],
    _options: SpawnOptions,
  ) => {
    queueMicrotask(() => {
      child.stdout.write('{"type":"turn_completed","result":"unexpected"}\n')
      child.stdout.end()
      child.stderr.end()
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    return child
  })
  const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })
  const prepareCliRun = vi.spyOn(adapter, 'prepareCliRun')
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const NativeAbortController = globalThis.AbortController
  let controllerConstructions = 0
  class CountingAbortController extends NativeAbortController {
    constructor() {
      super()
      controllerConstructions += 1
    }
  }
  vi.stubGlobal('AbortController', CountingAbortController)

  const events: Array<AgentEvent | AgentStreamEvent> = []
  let failure: unknown
  let effects: CliEffectSnapshot = ZERO_CLI_EFFECTS
  try {
    for await (const event of run(adapter)) events.push(event)
  } catch (error) {
    failure = error
  } finally {
    const startedEvents = events.filter((event) => event.type === 'adapter:started')
    effects = {
      sessionIds: new Set(startedEvents.map((event) => event.sessionId)).size,
      clockReads: dateNow.mock.calls.length,
      controllers: controllerConstructions,
      startedEvents: startedEvents.length,
      homeAndEnvironmentProjections: prepareCliRun.mock.calls.length,
      environmentSpawns: spawn.mock.calls.filter((call) => call[2].env !== undefined).length,
      spawns: spawn.mock.calls.length,
    }
    prepareCliRun.mockRestore()
    dateNow.mockRestore()
    vi.unstubAllGlobals()
  }
  return { effects, failure }
}

describe('Codex explicit CLI backend', () => {
  it('includes standing context in the actual native prompt exactly once', () => {
    const adapter = new CodexCliAdapter();
    expect(adapter.buildArgs({ prompt: 'task', systemPrompt: 'standing' }).at(-1)).toBe('standing\n\ntask');
  })

  it.each(['missing', 'foreign'])('refuses %s native identity without synthetic started events', async mode => {
    const events: AgentStreamEvent[] = [];
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn: () => {
      const child = createChild(false);
      queueMicrotask(() => {
        if (mode === 'foreign') child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '22222222-2222-2222-2222-222222222222' }) + '\n');
        child.stdout.write('{"type":"turn.completed"}\n'); child.stdout.end(); child.stderr.end();
        child.exitCode = 0; child.emit('close', 0, null);
      });
      return child;
    } } });
    const run = async () => { for await (const event of adapter.executeWithRaw({ prompt: 'inert', resumeSessionId: NATIVE_ID })) events.push(event); };
    await expect(run()).rejects.toThrow(/Native Codex session identity/);
    expect(events.some(event => event.type === 'adapter:started')).toBe(false);
  })

  it('rejects nonnative resume before constructing a CLI home or spawning', async () => {
    const spawn = vi.fn();
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } });
    await expect(collect(adapter.executeWithRaw({ prompt: 'inert', resumeSessionId: 'controller-shaped-id' }))).rejects.toThrow(/resume identity/);
    expect(spawn).not.toHaveBeenCalled();
  })
  it('returns one stable unsupported admission from the selected CLI instance', () => {
    const adapter = new CodexCliAdapter()

    expect(adapter.getCapabilities().supportsZeroToolDispatch).toBe(false)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
  })

  it('rejects direct execution before CLI session, clock, controller, start, projection, or spawn effects', async () => {
    const { effects, failure } = await observeCliRun((adapter) =>
      adapter.executeWithRaw(zeroToolInput()))

    expect(effects).toEqual(ZERO_CLI_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: { admission: ZERO_TOOL_DIRECT_DENIAL },
    })
  })

  it('rejects resume with an ordinary opted-in requirement before CLI effects', async () => {
    const { effects, failure } = await observeCliRun((adapter) =>
      adapter.resumeSession('session-ordinary', zeroToolInput()))

    expect(effects).toEqual(ZERO_CLI_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: { admission: ZERO_TOOL_DIRECT_DENIAL },
    })
  })

  it('rejects resume with a non-enumerable requirement before CLI effects', async () => {
    const input = zeroToolInput()
    Object.defineProperty(input, 'executionControlRequirement', {
      configurable: true,
      enumerable: false,
      value: ZERO_TOOL_REQUIREMENT,
    })

    const { effects, failure } = await observeCliRun((adapter) =>
      adapter.resumeSession('session-hidden', input))

    expect(effects).toEqual(ZERO_CLI_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: {
        admission: {
          ...ZERO_TOOL_REJECTION,
          blockers: ['execution_control_requirement_invalid'],
        },
      },
    })
  })

  it('rejects resume with an accessor-backed requirement without invoking the getter', async () => {
    const input = zeroToolInput()
    let getterReads = 0
    Object.defineProperty(input, 'executionControlRequirement', {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1
        throw new Error('execution-control getter must remain unread')
      },
    })

    const { effects, failure } = await observeCliRun((adapter) =>
      adapter.resumeSession('session-accessor', input))

    expect(getterReads).toBe(0)
    expect(effects).toEqual(ZERO_CLI_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: {
        admission: {
          ...ZERO_TOOL_REJECTION,
          blockers: ['execution_control_requirement_invalid'],
        },
      },
    })
  })

  it('pairs Codex file-change start and completion events with one stable tool call id', () => {
    const adapter = new CodexCliAdapter()
    const item = { id: 'file-change-1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'modified' }] }
    const started = adapter.mapProviderEvent({ type: 'item.started', item }, NATIVE_ID, { prompt: 'test' })
    const completed = adapter.mapProviderEvent({ type: 'item.completed', item }, NATIVE_ID, { prompt: 'test' })
    expect(started).toMatchObject({ type: 'adapter:tool_call', toolName: 'file_edit', toolCallId: 'file-change-1' })
    expect(completed).toMatchObject({ type: 'adapter:tool_result', toolName: 'file_edit', toolCallId: 'file-change-1' })
  })

  it('materializes exactly the explicit backend and keeps SDK as the default', () => {
    expect(createCodexBackendAdapter()).toBeInstanceOf(CodexAdapter)
    expect(createCodexBackendAdapter({ backend: 'sdk' })).toBeInstanceOf(CodexAdapter)
    expect(createCodexBackendAdapter({ backend: 'cli' })).toBeInstanceOf(CodexCliAdapter)
  })

  it.each([
    [undefined, undefined, false],
    [false, undefined, false],
    [true, undefined, true],
    [false, true, true],
    [true, false, false],
    [true, 'true', true],
    [undefined, 'true', false],
  ])('maps skipGitRepoCheck config=%s input=%s to flag=%s for exec and resume', (configured, perCall, enabled) => {
    const adapter = new CodexCliAdapter({ skipGitRepoCheck: configured as boolean | undefined })
    for (const resumeSessionId of [undefined, NATIVE_ID]) {
      const args = adapter.buildArgs({
        prompt: 'inspect',
        resumeSessionId,
        options: { skipGitRepoCheck: perCall },
      }, '/schema.json')
      expect(args.includes('--skip-git-repo-check')).toBe(enabled)
      if (enabled) {
        expect(args.indexOf('--skip-git-repo-check')).toBeGreaterThan(args.indexOf('exec'))
        expect(args.indexOf('--skip-git-repo-check')).toBeLessThan(args.indexOf('--'))
      }
      expect(args.slice(- (resumeSessionId ? 3 : 2))).toEqual(
        resumeSessionId ? ['--', resumeSessionId, 'inspect'] : ['--', 'inspect'],
      )
    }
  })

  it('maps read-only and workspace-write args without forwarding API keys or subscription credentials', async () => {
    const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const adapter = new CodexCliAdapter({
      apiKey: 'sk-secret-value',
      cliPath: 'codex-test',
      env: {
        OPENAI_API_KEY: 'sk-secret-value',
        CODEX_SUBSCRIPTION_TOKEN: 'subscription-secret',
        SAFE_FLAG: 'ok',
      },
      runtimeDependencies: {
        spawn: (command, args, options) => {
          spawned.push({ command, args, options })
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"agent_message","text":"ok"}\n')
            child.stdout.write('{"type":"turn_completed","result":"done"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({ prompt: 'inspect', workingDirectory: process.cwd() }))
    const first = spawned[0]!
    expect(first.args).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request', '--sandbox', 'read-only', 'exec', '--json', '--', 'inspect']))
    expect(first.args).not.toContain('--model')
    expect(JSON.stringify(first.args)).not.toContain('sk-secret-value')
    expect(JSON.stringify(first.options.env)).not.toContain('sk-secret-value')
    expect(JSON.stringify(first.options.env)).not.toContain('subscription-secret')
    expect(first.options.env).toMatchObject({ SAFE_FLAG: 'ok' })
    expect(first.options.env).toMatchObject({ PATH: process.env.PATH })
    expect(first.options.env).toMatchObject({ CODEX_HOME: expect.stringContaining('dzupagent-codex-') })

    spawned.length = 0
    await collect(adapter.executeWithRaw({
      prompt: 'write',
      workingDirectory: process.cwd(),
      policyContext: { activePolicy: { sandboxMode: 'workspace-write', approvalRequired: false } },
    }))
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '--ask-for-approval', 'never']))
  })

  it('uses the installed CLI argument contract for reasoning, resume, and file-backed output schemas', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const adapter = new CodexCliAdapter({
      reasoning: 'high',
      runtimeDependencies: {
        spawn: (_command, args, options) => {
          calls.push({ args, env: options.env ?? {} })
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({
      prompt: 'continue',
      resumeSessionId: NATIVE_ID,
      outputSchema: { type: 'object' },
    }))

    const args = calls[0]!.args
    expect(args).toEqual(expect.arrayContaining([
      '--config', 'model_reasoning_effort="high"', 'exec', 'resume', '--json', '--output-schema',
    ]))
    expect(args).not.toContain('--reasoning')
    expect(args).not.toContain('--approval-policy')
    expect(args).not.toContain('--resume')
    const schemaPath = args[args.indexOf('--output-schema') + 1]!
    expect(schemaPath).toBe(join(String(calls[0]!.env.CODEX_HOME), 'output-schema.json'))
    expect(args.slice(-3)).toEqual(['--', NATIVE_ID, 'continue'])
  })

  it.each(['xhigh', 'max'])('forwards qualified native %s effort without falling back to defaults', (reasoning) => {
    const adapter = new CodexCliAdapter({ model: 'gpt-6.1-sol', nativeReasoning: {
      model: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      evidenceRef: 'fixture/native-observation', expiresAt: '2099-01-01T00:00:00Z',
    } })
    const args = adapter.buildArgs({ prompt: 'bounded', options: { reasoning } })
    expect(args).toContain(`model_reasoning_effort="${reasoning}"`)
  })

  it.each(['ultra', 'max', '', 2, false, null])('refuses unqualified effort %s before provider dispatch', async (reasoning) => {
    const spawn = vi.fn()
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })
    await expect(collect(adapter.executeWithRaw({ prompt: 'bounded', options: { reasoning } }))).rejects.toThrow(/reasoning effort/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses stale, mismatched and unsupported native model mappings', () => {
    const snapshot = { model: 'gpt-6.1-sol', efforts: ['high', 'max'], evidenceRef: 'fixture/native-observation', expiresAt: '2099-01-01T00:00:00Z' }
    for (const nativeReasoning of [snapshot, { ...snapshot, model: 'other-model' }, { ...snapshot, expiresAt: '2000-01-01T00:00:00Z' }]) {
      const adapter = new CodexCliAdapter({ model: 'gpt-6.1-sol', nativeReasoning })
      expect(() => adapter.buildArgs({ prompt: 'bounded', options: { reasoning: 'xhigh' } })).toThrow(/reasoning effort/)
    }
    const adapter = new CodexCliAdapter({ model: 'gpt-6.1-sol', nativeReasoning: snapshot })
    expect(() => adapter.buildArgs({ prompt: 'bounded', options: { model: 'gpt-6-astra', reasoning: 'max' } })).toThrow(/reasoning effort/)
  })

  it('reuses a worker-owned private session home across provider restart', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'dzupagent-codex-session-'))
    const homes: string[] = []
    const adapter = new CodexCliAdapter({
      persistentSessionHome: true,
      runtimeDependencies: {
        spawn: (_command, _args, options) => {
          homes.push(String(options.env?.CODEX_HOME))
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"turn.completed"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })
    try {
      await collect(adapter.executeWithRaw({ prompt: 'pause', workingDirectory }))
      const sessionPath = join(homes[0]!, 'sessions', 'resume.jsonl')
      await writeFile(sessionPath, JSON.stringify({ thread: NATIVE_ID }) + '\n', { mode: 0o600 })
      await collect(adapter.executeWithRaw({
        prompt: 'continue', workingDirectory, resumeSessionId: NATIVE_ID,
      }))

      expect(homes[1]).toBe(homes[0])
      await expect(readFile(sessionPath, 'utf8')).resolves.toContain(NATIVE_ID)
    } finally {
      await rm(workingDirectory, { recursive: true, force: true })
    }
  })

  // MVP-07-CP06FA: a coordinated attempt's working directory is the pinned
  // candidate checkout, so the persistent home must live under a root outside it.
  describe('persistent session home root', () => {
    function recordingAdapter(homes: string[], persistentSessionHomeRoot: string, spawned = { count: 0 }) {
      return new CodexCliAdapter({
        persistentSessionHome: true,
        persistentSessionHomeRoot,
        runtimeDependencies: {
          spawn: (_command, _args, options) => {
            spawned.count += 1
            homes.push(String(options.env?.CODEX_HOME))
            const child = createChild()
            queueMicrotask(() => {
              child.stdout.write('{"type":"turn.completed"}\n')
              child.stdout.end()
              child.stderr.end()
              child.exitCode = 0
              child.emit('close', 0, null)
            })
            return child
          },
        },
      })
    }

    it('places the home under the root, keyed by the working directory, and reuses it on restart', async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'dzupagent-codex-rooted-'))
      const checkout = join(scratch, 'checkout')
      const other = join(scratch, 'other')
      const homeRoot = join(scratch, 'homes')
      await mkdir(checkout)
      await mkdir(other)
      const homes: string[] = []
      const adapter = recordingAdapter(homes, homeRoot)
      try {
        await collect(adapter.executeWithRaw({ prompt: 'pause', workingDirectory: checkout }))
        await collect(adapter.executeWithRaw({ prompt: 'continue', workingDirectory: checkout, resumeSessionId: NATIVE_ID }))
        await collect(adapter.executeWithRaw({ prompt: 'other', workingDirectory: other }))

        const realRoot = await realpath(homeRoot)
        const key = createHash('sha256').update(await realpath(checkout)).digest('hex').slice(0, 32)
        expect(homes[0]).toBe(join(realRoot, key))
        expect(homes[1]).toBe(homes[0])
        expect(homes[2]).not.toBe(homes[0])
        expect(dirname(homes[2]!)).toBe(realRoot)
        await expect(readdir(checkout)).resolves.toEqual([])
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })

    it.each([
      ['the working directory itself', (checkout: string) => checkout, 'session_home_inside_working_directory'],
      ['a directory inside it', (checkout: string) => join(checkout, 'nested', 'homes'), 'session_home_inside_working_directory'],
      ['a relative root', () => 'relative-homes', 'invalid_session_home_root'],
    ])('refuses %s before spawning or creating anything', async (_label, rootFor, reason) => {
      const checkout = await mkdtemp(join(tmpdir(), 'dzupagent-codex-rooted-refuse-'))
      const spawned = { count: 0 }
      const adapter = recordingAdapter([], rootFor(checkout), spawned)
      try {
        await expect(collect(adapter.executeWithRaw({ prompt: 'refused', workingDirectory: checkout })))
          .rejects.toMatchObject({ code: 'CAPABILITY_DENIED', context: { reason } })
        expect(spawned.count).toBe(0)
        await expect(readdir(checkout)).resolves.toEqual([])
      } finally {
        await rm(checkout, { recursive: true, force: true })
      }
    })

    it('refuses a symlinked root that leads back into the working directory', async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'dzupagent-codex-rooted-link-'))
      const checkout = join(scratch, 'checkout')
      await mkdir(join(checkout, 'inner'), { recursive: true })
      await symlink(join(checkout, 'inner'), join(scratch, 'link'))
      const spawned = { count: 0 }
      const adapter = recordingAdapter([], join(scratch, 'link'), spawned)
      try {
        await expect(collect(adapter.executeWithRaw({ prompt: 'refused', workingDirectory: checkout })))
          .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
        expect(spawned.count).toBe(0)
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  })

  it('normalizes installed CLI dotted envelopes and carries the final assistant message into completion', async () => {
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: () => {
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"thread.started","thread_id":"11111111-1111-1111-1111-111111111111"}\n')
            child.stdout.write('{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"final answer"}}\n')
            child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    const events = await collect(adapter.executeWithRaw({ prompt: 'dotted events' }))
    expect(events.find((event) => event.type === 'adapter:message')).toMatchObject({ content: 'final answer', sessionId: NATIVE_ID })
    expect(new Set(events.map(event => event.type === 'adapter:provider_raw' ? event.rawEvent.sessionId : event.sessionId))).toEqual(new Set([NATIVE_ID]))
    expect([...events].reverse().find((event) => event.type === 'adapter:completed')).toMatchObject({
      result: 'final answer',
      usage: { inputTokens: 7, outputTokens: 2 },
    })
  })

  it('copies approved local auth state into the private CODEX_HOME without mutating the base profile', async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), 'dzupagent-codex-base-'))
    const authPath = join(baseRoot, 'auth.json')
    await writeFile(authPath, '{"auth_mode":"chatgpt"}\n', { mode: 0o600 })
    let projectedAuth = ''
    try {
      const adapter = new CodexCliAdapter({
        cliBaseProfileRoot: baseRoot,
        cliBaseProfileFiles: ['auth.json'],
        runtimeDependencies: {
          spawn: (_command, _args, options) => {
            const child = createChild()
            queueMicrotask(async () => {
              projectedAuth = await readFile(join(String(options.env?.CODEX_HOME), 'auth.json'), 'utf8')
              child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
              child.stdout.end()
              child.stderr.end()
              child.exitCode = 0
              child.emit('close', 0, null)
            })
            return child
          },
        },
      })

      await collect(adapter.executeWithRaw({ prompt: 'auth' }))
      expect(projectedAuth).toBe('{"auth_mode":"chatgpt"}\n')
      expect(await readFile(authPath, 'utf8')).toBe('{"auth_mode":"chatgpt"}\n')
    } finally {
      await rm(baseRoot, { recursive: true, force: true })
    }
  })

  it('projects authenticated HTTP MCP through private config and a reference-backed bearer environment variable', async () => {
    let projectedConfig = ''
    let projectedEnv: NodeJS.ProcessEnv = {}
    let projectedArgs: readonly string[] = []
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: (_command, args, options) => {
          const child = createChild()
          queueMicrotask(async () => {
            projectedArgs = args
            projectedEnv = options.env ?? {}
            projectedConfig = await readFile(join(String(options.env?.CODEX_HOME), 'config.toml'), 'utf8')
            child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({
      prompt: 'use worker tools',
      options: {
        mcpServers: [{
          id: 'codev_worker',
          transport: {
            kind: 'http',
            url: 'http://127.0.0.1:7821',
            bearerTokenEnv: { envVar: 'CODEV_MCP_TOKEN', tokenRef: 'worker-token' },
          },
        }],
        mcpReferenceValues: { 'worker-token': 'raw-token-value' },
      },
    }))

    expect(projectedConfig).toContain('[mcp_servers."codev_worker"]')
    expect(projectedConfig).toContain('url = "http://127.0.0.1:7821/"')
    expect(projectedConfig).toContain('enabled = true')
    expect(projectedConfig).toContain('required = true')
    expect(projectedConfig).toContain('default_tools_approval_mode = "auto"')
    expect(projectedConfig).toContain('bearer_token_env_var = "CODEV_MCP_TOKEN"')
    expect(projectedConfig).not.toContain('raw-token-value')
    expect(projectedEnv.CODEV_MCP_TOKEN).toBe('raw-token-value')
    expect(projectedArgs).toEqual(expect.arrayContaining([
      '--disable', 'apps', '--disable', 'plugins', '--disable', 'enable_mcp_apps',
    ]))
  })

  it('rejects unresolved, materialized-header, and unsafe bearer MCP projections before spawn', async () => {
    const spawn = vi.fn()
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })
    const base = { id: 'worker', transport: { kind: 'http' as const, url: 'http://127.0.0.1:7821' } }

    await expect(collect(adapter.executeWithRaw({
      prompt: 'missing ref',
      options: {
        mcpServers: [{ ...base, transport: { ...base.transport, bearerTokenEnv: { envVar: 'CODEV_MCP_TOKEN', tokenRef: 'missing' } } }],
      },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({
      prompt: 'headers',
      options: { mcpServers: [{ ...base, transport: { ...base.transport, headerRefs: { Authorization: 'secret-ref' } } }] },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({
      prompt: 'unsafe env',
      options: {
        mcpServers: [{ ...base, transport: { ...base.transport, bearerTokenEnv: { envVar: 'bad-name', tokenRef: 'token' } } }],
        mcpReferenceValues: { token: 'value' },
      },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects unsupported policy and MCP combinations before spawn after a prior successful run', async () => {
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })

    await expect(collect(adapter.executeWithRaw({ prompt: 'ok' }))).resolves.toEqual(expect.any(Array))
    expect(spawn).toHaveBeenCalledTimes(1)

    await expect(collect(adapter.executeWithRaw({ prompt: 'bad', options: { sandboxMode: 'full-access' } })))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({ prompt: 'mcp', options: { mcpServers: [{ id: 'local' }] } })))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('maps raw, normalized, structured output, auth failure, timeout, cancellation, overflow, and cleanup without SDK fallback', async () => {
    const cleanupRoots: string[] = []
    const spawn = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        if (args.includes('auth-fail')) {
          child.stdout.write('{"type":"error","message":"auth login required","code":"auth_required"}\n')
          child.stdout.end()
          child.stderr.end()
          child.exitCode = 0
          child.emit('close', 0, null)
          return
        }
        child.stdout.write('{"type":"agent_message","text":"hello"}\n')
        child.stdout.write('{"type":"turn_completed","result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":3},"duration_ms":4}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn,
        onDiagnostic: (diagnostic) => {
          if (diagnostic.kind === 'cli_home_projection_cleanup_status') cleanupRoots.push(String(diagnostic.metadata?.['root']))
        },
      },
    })

    const events = await collect(adapter.executeWithRaw({
      prompt: 'structured',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }))
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['adapter:started', 'adapter:provider_raw', 'adapter:message', 'adapter:completed']))
    expect(events.find((event) => event.type === 'adapter:completed')).toMatchObject({ result: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 3 } })

    const authEvents = await collect(adapter.executeWithRaw({ prompt: 'auth-fail' }))
    expect(authEvents.find((event) => event.type === 'adapter:failed')).toMatchObject({ code: 'ADAPTER_AUTH_FAILED' })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(cleanupRoots).toHaveLength(2)

    const timeoutChild = createChild()
    const timeoutAdapter = new CodexCliAdapter({
      timeoutMs: 20,
      runtimeDependencies: {
        spawn: () => timeoutChild,
        setTimer: ((callback: (...args: unknown[]) => void) => setTimeout(callback, 0)) as typeof setTimeout,
        killProcessTree: (_child, signal) => {
          timeoutChild.signalCode = signal
          timeoutChild.stdout.end()
          timeoutChild.stderr.end()
          setTimeout(() => timeoutChild.emit('close', null, signal), 0)
        },
      },
    })
    await expect(collect(timeoutAdapter.executeWithRaw({ prompt: 'timeout' }))).rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' })

    const controller = new AbortController()
    const cancelAdapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: () => createChild(),
        killProcessTree: (child, signal) => {
          const fake = child as FakeChild
          fake.stdout.end()
          fake.stderr.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })
    setTimeout(() => controller.abort(), 0)
    await expect(collect(cancelAdapter.executeWithRaw({ prompt: 'cancel', signal: controller.signal }))).rejects.toMatchObject({ code: 'AGENT_ABORTED' })

    const overflowAdapter = new CodexCliAdapter({
      runtimeLimits: { stdoutBytes: 64 },
      runtimeDependencies: {
        spawn: () => {
          const child = createChild()
          queueMicrotask(() => child.stdout.write(`{"type":"agent_message","text":"${'x'.repeat(256)}"}\n`))
          return child
        },
        killProcessTree: (child, signal) => {
          const fake = child as FakeChild
          fake.stdout.end()
          fake.stderr.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })
    await expect(collect(overflowAdapter.executeWithRaw({ prompt: 'overflow' }))).rejects.toBeInstanceOf(ForgeError)
  })

  it('keeps concurrent run state isolated when one run overflows and another succeeds', async () => {
    const spawn = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        if (args.includes('overflow')) {
          child.stdout.write(`{"type":"agent_message","text":"${'x'.repeat(512)}"}\n`)
          return
        }
        child.stdout.write('{"type":"turn_completed","result":"done"}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    // The bound must admit the mandatory native thread.started line plus the
    // successful run's terminal line, and still reject the 512-byte overflow.
    const adapter = new CodexCliAdapter({
      runtimeLimits: { stdoutBytes: 256 },
      runtimeDependencies: {
        spawn,
        killProcessTree: (child, signal) => {
          const fake = child as FakeChild
          fake.stdout.end()
          fake.stderr.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })

    const failed = collect(adapter.executeWithRaw({ prompt: 'overflow' }))
    const succeeded = collect(adapter.executeWithRaw({ prompt: 'success' }))

    await expect(failed).rejects.toBeDefined()
    await expect(succeeded).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'adapter:completed', result: 'done' }),
    ]))
  })
})
