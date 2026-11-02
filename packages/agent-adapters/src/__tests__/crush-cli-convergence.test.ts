import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeError } from '@dzupagent/core/events'

import { CrushAdapter, createCrushCliAdapter } from '../crush/crush-adapter.js'
import { isCrushUsageReaderAvailable, readCrushUsage } from '../crush/crush-usage.js'
import { DEFAULT_CLI_RUNTIME_LIMITS } from '../cli-runtime/types.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('Crush CLI convergence contract', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()
  const roots: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function fixtureProfile(overrides: Record<string, unknown> = {}): Promise<{ profile: string; workspace: string }> {
    const profile = await mkdtemp(join(tmpdir(), 'crush-profile-'))
    const workspace = await mkdtemp(join(tmpdir(), 'crush-workspace-'))
    roots.push(profile, workspace)
    await writeFile(join(profile, 'crush.json'), `${JSON.stringify({
      models: {
        large: { provider: 'openrouter', model: 'qwen/qwen3-coder', max_tokens: 32_768 },
        small: { provider: 'gemini', model: 'gemini-2.5-pro' },
      },
      providers: {
        openrouter: { api_key: 'test-openrouter-secret' },
        gemini: { api_key: 'test-gemini-secret' },
      },
      options: { debug: true },
      mcp: { unsafe: { type: 'stdio', command: 'unsafe' } },
      ...overrides,
    })}\n`)
    return { profile, workspace }
  }

  it('creates the explicit Crush CLI host backend', () => {
    expect(createCrushCliAdapter()).toBeInstanceOf(CrushAdapter)
  })

  it('maps the bounded terminal-text record to one completed event', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: 'CRUSH_OK' }
    })
    const { workspace } = await fixtureProfile()
    const events = await collectEvents(new CrushAdapter({ workingDirectory: workspace }).execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:completed'])
    expect(events.at(-1)).toMatchObject({ providerId: 'crush', result: 'CRUSH_OK' })
  })

  it('passes the finite total timeout, cancellation and output bounds to the shared runner', async () => {
    const { workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      expect(options?.timeoutMs).toBe(12_345)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(options?.stdoutMode).toBe('text')
      expect({ ...DEFAULT_CLI_RUNTIME_LIMITS, ...options?.limits }).toMatchObject({
        stdoutBytes: 4 * 1024 * 1024,
        stderrBytes: 256 * 1024,
      })
      yield { type: 'text_result', content: 'bounded' }
    })
    await collectEvents(new CrushAdapter({ timeoutMs: 12_345 }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(mockSpawnAndStreamJsonl).toHaveBeenCalledOnce()
  })

  it('forwards explicit output limits without creating a separate runner', async () => {
    const { workspace } = await fixtureProfile()
    const runtimeLimits = { stdoutBytes: 2048, stderrBytes: 1024 }
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      expect(options?.limits).toEqual(runtimeLimits)
      yield { type: 'text_result', content: 'bounded' }
    })
    await collectEvents(new CrushAdapter({ runtimeLimits }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(mockSpawnAndStreamJsonl).toHaveBeenCalledOnce()
  })

  it.each(['ADAPTER_TIMEOUT', 'ADAPTER_EXECUTION_FAILED'] as const)('cleans the isolated run after %s without retrying', async (code) => {
    const { profile, workspace } = await fixtureProfile()
    let projectionRoot = ''
    const failure = new ForgeError({ code, message: 'bounded runner failure', recoverable: false })
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      projectionRoot = options!.env!['CRUSH_GLOBAL_DATA']!.replace(/\/data$/u, '')
      throw failure
    })
    const events: Array<{ type: string }> = []
    const run = (async () => {
      for await (const event of new CrushAdapter({ cliBaseProfileRoot: profile, timeoutMs: 1000 }).execute({ prompt: 'x', workingDirectory: workspace })) events.push(event)
    })()
    await expect(run).rejects.toBe(failure)
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:failed'])
    expect(mockSpawnAndStreamJsonl).toHaveBeenCalledOnce()
    expect(projectionRoot).not.toBe('')
    await expect(access(projectionRoot)).rejects.toThrow()
  })

  it('projects one selected provider and strict read-only tools into private disposable roots', async () => {
    const { profile, workspace } = await fixtureProfile()
    let projectionRoot = ''
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, args, options) {
      projectionRoot = options?.env?.['CRUSH_GLOBAL_DATA']?.replace(/\/data$/u, '') ?? ''
      expect(options?.cwd).toBe(workspace)
      expect(options?.stdoutMode).toBe('text')
      expect(options?.env?.['HOME']).toBe(join(projectionRoot, 'home'))
      expect(options?.env?.['CRUSH_GLOBAL_CONFIG']).toBe(join(projectionRoot, 'config'))
      expect(options?.env?.['CRUSH_SKILLS_DIR']).toBe(join(projectionRoot, 'skills'))
      expect(options?.env?.['OPENAI_API_KEY']).toBeUndefined()
      expect(options?.env?.['GEMINI_API_KEY']).toBeUndefined()
      const projected = JSON.parse(await readFile(join(projectionRoot, 'data', 'crush.json'), 'utf8'))
      expect(Object.keys(projected.providers)).toEqual(['openrouter'])
      expect(projected.models.large).toMatchObject({ provider: 'openrouter', model: 'qwen/qwen3-coder' })
      expect(projected.models.small).toEqual(projected.models.large)
      expect(projected.mcp).toEqual({})
      expect(projected.options).toMatchObject({
        disable_provider_auto_update: true,
        disable_metrics: true,
        auto_lsp: false,
      })
      expect(projected.options.disabled_tools).toEqual(expect.arrayContaining(['bash', 'edit', 'write', 'fetch', 'list_mcp_resources']))
      expect(projected.options.disabled_tools).not.toContain('view')
      // Exact upstream v0.98.1 inventory minus the six read-only tools.
      expect([...projected.options.disabled_tools].sort()).toEqual([
        'agent', 'bash', 'crush_info', 'crush_logs', 'job_output', 'job_kill', 'download', 'edit', 'multiedit',
        'lsp_restart', 'lsp_symbols', 'lsp_definition', 'lsp_call_hierarchy', 'lsp_rename', 'lsp_replace_symbol',
        'fetch', 'agentic_fetch', 'question', 'sourcegraph', 'todos', 'write',
        'list_mcp_resources', 'read_mcp_resource',
      ].sort())
      expect(args).toEqual(expect.arrayContaining(['--cwd', workspace, '--data-dir', join(projectionRoot, 'run-data'), 'run', '--quiet', '--', 'x']))
      expect(args).not.toEqual(expect.arrayContaining(['--output-format', '--prompt', '--system', '--permission', '--max-turns']))
      yield { type: 'text_result', content: 'ok' }
    })

    await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({
      prompt: 'x',
      workingDirectory: workspace,
    }))
    expect(projectionRoot).not.toBe('')
    await expect(access(projectionRoot)).rejects.toThrow()
  })

  it('uses the per-run compound model for both CLI selection and the isolated profile', async () => {
    const { profile, workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, args, options) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'openrouter/other-observed']))
      const projected = JSON.parse(await readFile(join(options!.env!['CRUSH_GLOBAL_DATA']!, 'crush.json'), 'utf8'))
      expect(projected.models.large).toMatchObject({ provider: 'openrouter', model: 'other-observed' })
      expect(Object.keys(projected.providers)).toEqual(['openrouter'])
      yield { type: 'text_result', content: 'ok' }
    })

    const events = await collectEvents(new CrushAdapter({
      cliBaseProfileRoot: profile,
      model: 'openrouter/qwen/qwen3-coder',
    }).execute({
      prompt: 'x',
      workingDirectory: workspace,
      options: { model: 'openrouter/other-observed' },
    }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed' })
  })

  it('projects immutable host-custodied profile content without reopening a source file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'crush-workspace-custodied-'))
    roots.push(workspace)
    const profileContent = `${JSON.stringify({
      models: {
        large: { provider: 'qwen', model: 'qwen-original' },
      },
      providers: {
        qwen: { api_key: 'custodied-secret-marker' },
      },
    })}\n`
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      const projected = JSON.parse(
        await readFile(join(options!.env!['CRUSH_GLOBAL_DATA']!, 'crush.json'), 'utf8'),
      )
      expect(projected.models.large).toMatchObject({ provider: 'qwen', model: 'qwen-original' })
      expect(projected.providers.qwen).toEqual({ api_key: 'custodied-secret-marker' })
      yield { type: 'text_result', content: 'ok' }
    })

    const events = await collectEvents(new CrushAdapter({
      cliBaseProfileContent: profileContent,
      credentialSource: 'profile-only',
    }).execute({
      prompt: 'x',
      workingDirectory: workspace,
      options: { model: 'qwen/qwen-original' },
    }))

    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed' })
    expect(mockSpawnAndStreamJsonl).toHaveBeenCalledOnce()
  })

  it('rejects ambient provider credentials in profile-only mode', async () => {
    const { profile, workspace } = await fixtureProfile({
      providers: { openrouter: { api_key: '$OPENROUTER_API_KEY' } },
    })
    vi.stubEnv('OPENROUTER_API_KEY', 'ambient-credential-marker')
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: 'unexpected' }
    })

    const events = await collectEvents(
      new CrushAdapter({ cliBaseProfileRoot: profile, credentialSource: 'profile-only' }).execute({
        prompt: 'x',
        workingDirectory: workspace,
      }),
    )

    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain('inline profile credential')
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('rejects an unknown credential-source mode before spawn', async () => {
    const { profile, workspace } = await fixtureProfile()

    const events = await collectEvents(
      new CrushAdapter({
        cliBaseProfileRoot: profile,
        credentialSource: 'profile-typo' as never,
      }).execute({ prompt: 'x', workingDirectory: workspace }),
    )

    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('enforces workspace-write with an exact allowlist and explicit auto-approval consent', async () => {
    const { profile, workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      const config = JSON.parse(await readFile(join(options!.env!['CRUSH_GLOBAL_DATA']!, 'crush.json'), 'utf8'))
      expect(config.options.disabled_tools).not.toContain('view')
      expect(config.options.disabled_tools).not.toContain('edit')
      expect(config.options.disabled_tools).toEqual(expect.arrayContaining(['bash', 'write', 'fetch']))
      expect(config.options.disabled_tools).toEqual(expect.arrayContaining([
        'crush_info', 'crush_logs', 'lsp_symbols', 'lsp_definition', 'lsp_call_hierarchy',
        'lsp_rename', 'lsp_replace_symbol', 'question',
      ]))
      yield { type: 'text_result', content: 'ok' }
    })
    await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({
      prompt: 'x',
      workingDirectory: workspace,
      policyContext: {
        activePolicy: {
          sandboxMode: 'workspace-write',
          approvalRequired: false,
          allowedTools: ['view', 'edit'],
          blockedTools: ['write'],
        },
      },
    }))
  })

  it('keeps concurrent provider profiles, databases, output, and cleanup isolated', async () => {
    const { profile, workspace } = await fixtureProfile()
    const projectionRoots: string[] = []
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      projectionRoots.push(options!.env!['CRUSH_GLOBAL_DATA']!.replace(/\/data$/u, ''))
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: 'text_result', content: options!.env!['CRUSH_GLOBAL_DATA']! }
    })
    const adapter = new CrushAdapter({ cliBaseProfileRoot: profile })
    const [first, second] = await Promise.all([
      collectEvents(adapter.execute({ prompt: 'one', workingDirectory: workspace })),
      collectEvents(adapter.execute({ prompt: 'two', workingDirectory: workspace })),
    ])
    expect(projectionRoots).toHaveLength(2)
    expect(projectionRoots[0]).not.toBe(projectionRoots[1])
    expect((first.at(-1) as { result?: string }).result).not.toBe((second.at(-1) as { result?: string }).result)
    await Promise.all(projectionRoots.map((root) => expect(access(root)).rejects.toThrow()))
  })

  it.each([
    [{ apiKey: 'generic' }, { prompt: 'x' }, 'base profile'],
    [{}, { prompt: 'x', systemPrompt: 'system' }, 'system-prompt'],
    [{}, { prompt: 'x', outputSchema: { type: 'object' } }, 'structured output'],
    [{}, { prompt: 'x', maxTurns: 2 }, 'turn limit'],
    [{}, { prompt: 'x', maxBudgetUsd: 1 }, 'budget limit'],
    [{}, { prompt: 'x', resumeSessionId: 'session' }, 'session resume'],
    [{}, { prompt: 'x', options: { mcpServers: [{ id: 'local' }] } }, 'MCP tools'],
    [{ sandboxMode: 'workspace-write' }, { prompt: 'x' }, 'approvalRequired=false'],
    [{ sandboxMode: 'full-access' }, { prompt: 'x', policyContext: { activePolicy: { approvalRequired: false, networkAccess: false } } }, 'deny network'],
    [{ model: 'unqualified' }, { prompt: 'x' }, 'provider/model'],
  ] as const)('refuses unsupported or identity-ambiguous input before spawn: %s', async (config, input, expected) => {
    // A private cwd, so an ancestor .crushrc (a workspace root may hold one) cannot preempt the refusal under test.
    const { workspace } = await fixtureProfile()
    const events = await collectEvents(new CrushAdapter({ ...config, workingDirectory: workspace }).execute(input))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain(expected)
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('rejects executable project configuration before spawn', async () => {
    const { profile, workspace } = await fixtureProfile()
    await writeFile(join(workspace, 'crush.json'), '{"providers":{}}\n')
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain('executable trusted input')
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it.each(['crushrc', '.crushrc'])('rejects a project %s, which Crush executes as Bash, before spawn', async (name) => {
    const { profile, workspace } = await fixtureProfile()
    await writeFile(join(workspace, name), 'touch crushrc-was-executed\n')
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain(join(workspace, name))
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('rejects a .crushrc in an ancestor of the working directory before spawn', async () => {
    const { profile, workspace } = await fixtureProfile()
    const nested = join(workspace, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    await writeFile(join(workspace, '.crushrc'), 'true\n')
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: nested }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain(join(workspace, '.crushrc'))
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('falls back to process.cwd() without a working directory and refuses its .crushrc before spawn', async () => {
    const { profile, workspace } = await fixtureProfile()
    await writeFile(join(workspace, '.crushrc'), 'true\n')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    try {
      const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x' }))
      expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
      expect((events.at(-1) as { error?: string }).error).toContain(join(workspace, '.crushrc'))
    } finally {
      cwd.mockRestore()
    }
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it.skipIf(typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule !== 'function')('does not turn native context snapshots into cumulative run usage', async () => {
    const { profile, workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, args) {
      const dataDir = args[args.indexOf('--data-dir') + 1]!
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(join(dataDir, 'crush.db'))
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL)')
      // Native fixture had three 17/5 responses (51/15 total), but this is
      // the latest context snapshot recorded by Crush, not cumulative usage.
      db.exec("INSERT INTO sessions VALUES ('main', 17, 5, 0.000066)")
      db.close()
      yield { type: 'text_result', content: 'done' }
    })
    const adapter = new CrushAdapter({ cliBaseProfileRoot: profile })
    expect(adapter.getCapabilities().supportsCostUsage).toBe(false)
    const events = await collectEvents(adapter.execute({ prompt: 'x', workingDirectory: workspace }))
    const completed = events.at(-1) as { type: string, usage?: { inputTokens: number, outputTokens: number, costCents?: number } }
    expect(completed).toMatchObject({ type: 'adapter:completed' })
    expect(completed).not.toHaveProperty('usage')
  })

  it('completes without usage when the run database is absent', async () => {
    const { profile, workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: 'done' }
    })
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed', result: 'done' })
    expect((events.at(-1) as { usage?: unknown }).usage).toBeUndefined()
  })

  it('rejects command substitution in provider profile strings', async () => {
    const { profile, workspace } = await fixtureProfile({
      providers: { openrouter: { api_key: '$(steal-secret)' } },
    })
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain('command substitution')
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('rejects a base-profile symlink that escapes the approved root', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'crush-profile-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'crush-profile-outside-'))
    const workspace = await mkdtemp(join(tmpdir(), 'crush-workspace-link-'))
    roots.push(profile, outside, workspace)
    await writeFile(join(outside, 'crush.json'), '{}\n')
    await symlink(join(outside, 'crush.json'), join(profile, 'crush.json'))
    const events = await collectEvents(new CrushAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x', workingDirectory: workspace }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect((events.at(-1) as { error?: string }).error).toContain('escapes its approved root')
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })
})

describe('Crush cumulative usage is unavailable', () => {
  it('keeps the compatibility reader unavailable instead of inventing totals', () => {
    expect(isCrushUsageReaderAvailable()).toBe(false)
    expect(readCrushUsage(undefined)).toBeUndefined()
    expect(readCrushUsage('/unread-context-snapshot')).toBeUndefined()
  })
})
