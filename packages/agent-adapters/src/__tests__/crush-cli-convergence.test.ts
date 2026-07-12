import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CrushAdapter, createCrushCliAdapter } from '../crush/crush-adapter.js'
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
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

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
    const events = await collectEvents(new CrushAdapter().execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:completed'])
    expect(events.at(-1)).toMatchObject({ providerId: 'crush', result: 'CRUSH_OK' })
  })

  it('projects one selected provider and strict read-only tools into private disposable roots', async () => {
    const { profile, workspace } = await fixtureProfile()
    let projectionRoot = ''
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, args, options) {
      projectionRoot = options.env?.['CRUSH_GLOBAL_DATA']?.replace(/\/data$/u, '') ?? ''
      expect(options.cwd).toBe(workspace)
      expect(options.stdoutMode).toBe('text')
      expect(options.env?.['HOME']).toBe(join(projectionRoot, 'home'))
      expect(options.env?.['CRUSH_GLOBAL_CONFIG']).toBe(join(projectionRoot, 'config'))
      expect(options.env?.['CRUSH_SKILLS_DIR']).toBe(join(projectionRoot, 'skills'))
      expect(options.env?.['OPENAI_API_KEY']).toBeUndefined()
      expect(options.env?.['GEMINI_API_KEY']).toBeUndefined()
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

  it('enforces workspace-write with an exact allowlist and explicit auto-approval consent', async () => {
    const { profile, workspace } = await fixtureProfile()
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      const config = JSON.parse(await readFile(join(options.env!['CRUSH_GLOBAL_DATA']!, 'crush.json'), 'utf8'))
      expect(config.options.disabled_tools).not.toContain('view')
      expect(config.options.disabled_tools).not.toContain('edit')
      expect(config.options.disabled_tools).toEqual(expect.arrayContaining(['bash', 'write', 'fetch']))
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
      projectionRoots.push(options.env!['CRUSH_GLOBAL_DATA']!.replace(/\/data$/u, ''))
      await new Promise((resolve) => setTimeout(resolve, 10))
      yield { type: 'text_result', content: options.env!['CRUSH_GLOBAL_DATA']! }
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
    const events = await collectEvents(new CrushAdapter(config).execute(input))
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
