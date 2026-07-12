import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { createGeminiBackendAdapter } from '../gemini/gemini-backend.js'
import { GeminiSDKAdapter } from '../gemini/gemini-sdk-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('Gemini CLI convergence contract', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()
  const roots: string[] = []

  beforeEach(() => vi.clearAllMocks())
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('selects CLI by default and SDK only when explicitly requested', () => {
    expect(createGeminiBackendAdapter()).toBeInstanceOf(GeminiCLIAdapter)
    expect(createGeminiBackendAdapter({ backend: 'cli' })).toBeInstanceOf(GeminiCLIAdapter)
    expect(createGeminiBackendAdapter({ backend: 'sdk', googleApiKey: 'test-only' })).toBeInstanceOf(GeminiSDKAdapter)
  })

  it('maps installed stream-json event shapes including ids and usage', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'init', timestamp: '2026-07-12T00:00:00Z', session_id: 'gemini-session', model: 'gemini-test' }
      yield { type: 'message', timestamp: '2026-07-12T00:00:01Z', role: 'assistant', content: 'hel', delta: true }
      yield { type: 'tool_use', timestamp: '2026-07-12T00:00:02Z', tool_name: 'read_file', tool_id: 'tool-1', parameters: { path: 'README.md' } }
      yield { type: 'tool_result', timestamp: '2026-07-12T00:00:03Z', tool_id: 'tool-1', status: 'success', output: 'ok' }
      yield { type: 'result', timestamp: '2026-07-12T00:00:04Z', status: 'success', stats: { input_tokens: 10, output_tokens: 4, duration_ms: 25 } }
    })

    const events = await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:completed',
    ])
    expect(events[2]).toMatchObject({ toolName: 'read_file', toolCallId: 'tool-1', input: { path: 'README.md' } })
    expect(events[3]).toMatchObject({ toolName: 'tool-1', toolCallId: 'tool-1', output: 'ok' })
    expect(events[4]).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4 }, durationMs: 25 })
  })

  it('projects a private home, copies only approved profile files, filters API credentials, and cleans up', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'gemini-profile-'))
    roots.push(profile)
    await writeFile(join(profile, 'settings.json'), '{"selectedAuthType":"oauth-personal"}\n')
    await writeFile(join(profile, 'projects.json'), '{}\n')
    await mkdir(join(profile, 'history'))

    let projectedRoot = ''
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      projectedRoot = options.env?.['GEMINI_CLI_HOME'] ?? ''
      expect(projectedRoot).not.toBe('')
      expect(options.env?.['GEMINI_API_KEY']).toBeUndefined()
      expect(options.env?.['GOOGLE_API_KEY']).toBeUndefined()
      expect(options.env?.['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined()
      await expect(access(join(projectedRoot, '.gemini/settings.json'))).resolves.toBeUndefined()
      await expect(access(join(projectedRoot, '.gemini/projects.json'))).resolves.toBeUndefined()
      await expect(access(join(projectedRoot, '.gemini/history'))).resolves.toBeUndefined()
      yield { type: 'result', status: 'success' }
    })

    await collectEvents(new GeminiCLIAdapter({
      cliBaseProfileRoot: profile,
      env: {
        GEMINI_API_KEY: 'must-not-spawn',
        GOOGLE_API_KEY: 'must-not-spawn',
        GOOGLE_APPLICATION_CREDENTIALS: '/must/not/spawn.json',
        SAFE_ENV: 'kept',
      },
    }).execute({ prompt: 'x' }))

    expect(projectedRoot).not.toBe('')
    await expect(access(projectedRoot)).rejects.toThrow()
  })

  it('projects authenticated MCP through an environment placeholder in private settings', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'gemini-profile-'))
    roots.push(profile)
    await writeFile(join(profile, 'settings.json'), '{"selectedAuthType":"oauth-personal"}\n')
    let projectedRoot = ''
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, _args, options) {
      projectedRoot = options.env?.['GEMINI_CLI_HOME'] ?? ''
      expect(options.env?.['GEMINI_CLI_MCP_BEARER_TOKEN']).toBe('opaque-token')
      const settings = await readFile(join(projectedRoot, '.gemini/settings.json'), 'utf8')
      expect(settings).toContain('Bearer ${GEMINI_CLI_MCP_BEARER_TOKEN}')
      expect(settings).not.toContain('opaque-token')
      expect(JSON.parse(settings)).toMatchObject({
        selectedAuthType: 'oauth-personal',
        mcpServers: {
          codev_worker: {
            type: 'http',
            url: 'http://127.0.0.1:1234/mcp',
            includeTools: ['read_file'],
          },
        },
      })
      yield { type: 'result', status: 'success' }
    })

    const events = await collectEvents(new GeminiCLIAdapter({ cliBaseProfileRoot: profile }).execute({
      prompt: 'x',
      options: {
        mcpServers: [{
          id: 'codev_worker',
          transport: {
            kind: 'http',
            url: 'http://127.0.0.1:1234/mcp',
            bearerTokenEnv: { envVar: 'GEMINI_CLI_MCP_BEARER_TOKEN', tokenRef: 'worker-token' },
          },
          enabledTools: ['read_file'],
        }],
        mcpReferenceValues: { 'worker-token': 'opaque-token' },
      },
    }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed' })
    await expect(access(projectedRoot)).rejects.toThrow()
  })

  it.each([
    [{ systemPrompt: 'system' }, 'system-prompt'],
    [{ maxTurns: 2 }, 'max-turns'],
    [{ outputSchema: { type: 'object' } }, 'structured-output'],
    [{ policyContext: { activePolicy: { allowedTools: ['read_file'] } } }, 'tool allow/block'],
    [{ options: { mcpServers: [{ id: 'local', transport: { kind: 'stdio', command: 'x' } }] } }, 'only HTTP MCP'],
  ] as const)('refuses unsupported policy projection before spawn: %s', async (extra, expected) => {
    const events = await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'x', ...extra }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed' })
    expect((events.at(-1) as { error?: string }).error).toContain(expected)
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })
})
