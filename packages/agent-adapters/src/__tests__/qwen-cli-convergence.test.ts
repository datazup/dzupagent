import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QwenAdapter, createQwenCliAdapter } from '../qwen/qwen-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('Qwen CLI convergence contract', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()
  const roots: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

  it('creates the explicit subscription CLI backend without API fallback', () => {
    expect(createQwenCliAdapter()).toBeInstanceOf(QwenAdapter)
  })

  it('maps installed stream-json envelopes including tool ids, deltas, usage, and structured output', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'qwen-session', model: 'qwen3-coder-plus' }
      yield { type: 'stream_event', session_id: 'qwen-session', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }
      yield { type: 'assistant', session_id: 'qwen-session', message: { content: [{ type: 'text', text: 'answer' }] } }
      yield { type: 'assistant', session_id: 'qwen-session', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { file_path: 'README.md' } }] } }
      yield { type: 'user', session_id: 'qwen-session', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }] } }
      yield { type: 'result', session_id: 'qwen-session', is_error: false, structured_result: { ok: true }, duration_ms: 31, usage: { input_tokens: 20, output_tokens: 8 } }
    })

    const events = await collectEvents(new QwenAdapter().execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:stream_delta',
      'adapter:message',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:completed',
    ])
    expect(events[3]).toMatchObject({ toolName: 'read_file', toolCallId: 'tool-1', input: { file_path: 'README.md' } })
    expect(events[4]).toMatchObject({ toolName: 'tool-1', toolCallId: 'tool-1', output: 'contents' })
    expect(events[5]).toMatchObject({ result: '{"ok":true}', usage: { inputTokens: 20, outputTokens: 8 }, durationMs: 31 })
  })

  it('projects Coding Plan into private home/runtime dirs, filters unrelated credentials, projects schema, and cleans up', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'qwen-profile-'))
    roots.push(profile)
    await writeFile(join(profile, 'settings.json'), '{"security":{"auth":{"selectedType":"openai"}},"env":{"BAILIAN_CODING_PLAN_API_KEY":"profile-test-only"}}\n')
    await writeFile(join(profile, 'installation_id'), 'test-installation\n')

    let projectionRoot = ''
    mockSpawnAndStreamJsonl.mockImplementation(async function* (_command, args, options) {
      projectionRoot = options.env?.['QWEN_HOME'] ?? ''
      expect(projectionRoot).not.toBe('')
      expect(options.env?.['QWEN_RUNTIME_DIR']).toBe(projectionRoot)
      expect(options.env?.['DASHSCOPE_API_KEY']).toBeUndefined()
      expect(options.env?.['QWEN_API_KEY']).toBeUndefined()
      expect(options.env?.['OPENAI_API_KEY']).toBeUndefined()
      expect(options.env?.['BAILIAN_CODING_PLAN_API_KEY']).toBe('explicit-test-only')
      expect(options.env?.['OPENAI_BASE_URL']).toBe('https://coding-intl.dashscope.aliyuncs.com/v1')
      expect(options.env?.['OPENAI_MODEL']).toBe('qwen3-coder-plus')
      expect(options.env?.['QWEN_CUSTOM_API_KEY_TEAM']).toBeUndefined()
      await expect(access(join(projectionRoot, 'settings.json'))).resolves.toBeUndefined()
      expect(JSON.parse(await readFile(join(projectionRoot, 'settings.json'), 'utf8'))).toMatchObject({
        security: { auth: { selectedType: 'openai', enforcedType: 'openai' } },
        model: { name: 'qwen3-coder-plus' },
        modelProviders: { openai: { protocol: 'openai', models: [{ envKey: 'BAILIAN_CODING_PLAN_API_KEY' }] } },
      })
      await expect(access(join(projectionRoot, 'oauth_creds.json'))).rejects.toThrow()
      const schemaIndex = args.indexOf('--json-schema')
      expect(schemaIndex).toBeGreaterThanOrEqual(0)
      expect(args[schemaIndex + 1]).toMatch(/^@.*output-schema\.json$/u)
      await expect(access(args[schemaIndex + 1]!.slice(1))).resolves.toBeUndefined()
      yield { type: 'result', is_error: false, result: 'ok' }
    })

    await collectEvents(new QwenAdapter({
      cliBaseProfileRoot: profile,
      env: {
        DASHSCOPE_API_KEY: 'must-not-spawn',
        QWEN_API_KEY: 'must-not-spawn',
        OPENAI_API_KEY: 'must-not-spawn',
        OPENAI_BASE_URL: 'https://must.not.spawn',
        BAILIAN_CODING_PLAN_API_KEY: 'explicit-test-only',
        QWEN_CUSTOM_API_KEY_TEAM: 'must-not-spawn',
      },
    }).execute({ prompt: 'x', outputSchema: { type: 'object', required: ['ok'] } }))

    expect(projectionRoot).not.toBe('')
    await expect(access(projectionRoot)).rejects.toThrow()
  })

  it('uses the installed system, resume, max-turn, and blocked-tool flags', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'result', is_error: false, result: 'ok' }
    })
    await collectEvents(new QwenAdapter().execute({
      prompt: 'x',
      systemPrompt: 'system',
      resumeSessionId: 'session-1',
      maxTurns: 3,
      policyContext: { activePolicy: { blockedTools: ['web_fetch'] } },
    }))
    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toEqual(expect.arrayContaining([
      '--system-prompt', 'system', '--resume', 'session-1',
      '--max-session-turns', '3', '--exclude-tools', 'web_fetch',
    ]))
    expect(args).not.toContain('--session')
    expect(args).not.toContain('--max-turns')
  })

  it.each([
    [{ apiKey: 'api-key' }, { prompt: 'x' }, 'BAILIAN_CODING_PLAN_API_KEY'],
    [{}, { prompt: 'x', options: { mcpServers: [{ id: 'local' }] } }, 'isolated bare mode'],
    [{}, { prompt: 'x', policyContext: { activePolicy: { allowedTools: ['read_file'] } } }, 'not a strict allowlist'],
    [{}, { prompt: 'x', policyContext: { activePolicy: { networkAccess: false } } }, 'network isolation'],
    [{}, { prompt: 'x', maxBudgetUsd: 1 }, 'cost budget'],
    [{ sandboxMode: 'full-access' }, { prompt: 'x', workingDirectory: '/workspace' }, 'approvalRequired=false'],
  ] as const)('refuses unsupported or identity-changing projection before spawn: %s', async (config, input, expected) => {
    const events = await collectEvents(new QwenAdapter(config).execute(input))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed' })
    expect((events.at(-1) as { error?: string }).error).toContain(expected)
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('rejects the discontinued qwen-oauth profile before spawn', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'qwen-api-profile-'))
    roots.push(profile)
    await writeFile(join(profile, 'settings.json'), '{"security":{"auth":{"selectedType":"qwen-oauth"}}}\n')
    const events = await collectEvents(new QwenAdapter({ cliBaseProfileRoot: profile }).execute({ prompt: 'x' }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed' })
    expect((events.at(-1) as { error?: string }).error).toContain('discontinued on 2026-04-15')
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })
})
