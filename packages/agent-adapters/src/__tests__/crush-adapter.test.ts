import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzupagent/core'

import { CrushAdapter } from '../crush/crush-adapter.js'
import { isCrushUsageReaderAvailable } from '../crush/crush-usage.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

// An ancestor's project config must not affect the adapter fixtures.
const crushCwd = mkdtempSync(join(tmpdir(), 'crush-hermetic-cwd-'))
afterAll(() => rmSync(crushCwd, { recursive: true, force: true }))

describe('CrushAdapter', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  it('throws ADAPTER_SDK_NOT_INSTALLED when crush binary is missing', async () => {
    mockIsBinaryAvailable.mockResolvedValue(false)
    await expect(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'hello' }).next())
      .rejects.toMatchObject({ code: 'ADAPTER_SDK_NOT_INSTALLED' })
  })

  it('maps one terminal text record without inventing intermediate tool events', async () => {
    const text = 'working\n{"type":"tool_call","name":"bash"}\nlocal result'
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: text, duration_ms: 7 }
    })
    const events = await collectEvents(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'build' }))
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:completed'])
    expect(events.at(-1)).toMatchObject({ providerId: 'crush', result: text, durationMs: 7 })
    expect((events.at(-1) as { usage?: unknown }).usage).toBeUndefined()
    const [, args, options] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(options?.stdoutMode).toBe('text')
    expect(args).toEqual(expect.arrayContaining(['run', '--quiet']))
    expect(args).not.toContain('--output-format')
    expect(args).not.toContain('--prompt')
  })

  it('keeps JSON-looking metrics as text rather than reporting unmeasured usage', async () => {
    const text = '{"metrics":{"promptTokens":32,"completionTokens":6}}'
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: text }
    })
    const events = await collectEvents(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'x' }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed', result: text })
    expect((events.at(-1) as { usage?: unknown }).usage).toBeUndefined()
  })

  it('ignores invalid provider options when building args', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: 'ok' }
    })
    await collectEvents(new CrushAdapter({
      workingDirectory: crushCwd,
      providerOptions: { quantization: '   ', gpuLayers: -1, contextSize: 'bad' },
    }).execute({ prompt: 'hello' }))
    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).not.toContain('--quantization')
    expect(args).not.toContain('--gpu-layers')
    expect(args).not.toContain('--context-size')
  })

  it('emits adapter:failed and does not rethrow for non-Forge errors', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('crush failed')
    })
    const events = await collectEvents(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:failed'])
    expect(events.at(-1)).toMatchObject({ error: 'crush failed' })
  })

  it('refuses unsupported resumeSession', async () => {
    await expect(collectEvents(new CrushAdapter({ workingDirectory: crushCwd }).resumeSession('sess', { prompt: 'resume' })))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })

  it('rethrows ForgeError after emitting adapter:failed', async () => {
    const original = new ForgeError({ code: 'ADAPTER_TIMEOUT', message: 'timeout', recoverable: true })
    mockSpawnAndStreamJsonl.mockImplementation(async function* () { throw original })
    const events: Array<{ type: string }> = []
    const run = (async () => {
      for await (const event of new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'x' })) events.push(event)
    })()
    await expect(run).rejects.toBe(original)
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:failed'])
  })

  it('names the redacted stderr cause of a failed Crush exit and rethrows the original', async () => {
    const original = new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: "Process 'crush' exited with code 1",
      recoverable: false,
      context: {
        command: 'crush', exitCode: 1,
        stderr: 'loading config\nAuthorization: Bearer sk-live-0123456789abcdef\nFailed to override models: large model x/y not found\n\n',
      },
    })
    mockSpawnAndStreamJsonl.mockImplementation(async function* () { throw original })
    const events: Array<{ type: string, error?: string }> = []
    const run = (async () => {
      for await (const event of new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'x' })) events.push(event as { type: string, error?: string })
    })()
    await expect(run).rejects.toBe(original)
    const failed = events.find(event => event.type === 'adapter:failed')
    expect(failed?.error).toContain("Process 'crush' exited with code 1")
    expect(failed?.error).toContain('large model x/y not found')
    expect(failed?.error).toContain('[REDACTED]')
    expect(failed?.error).not.toContain('sk-live-0123456789abcdef')
  })

  it('completes an empty terminal text result without synthetic messages', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: '' }
    })
    const events = await collectEvents(new CrushAdapter({ workingDirectory: crushCwd }).execute({ prompt: 'x' }))
    expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:completed'])
    expect(events.at(-1)).toMatchObject({ result: '' })
  })

  it.each(['workspace-write', 'full-access'] as const)('requires explicit no-approval policy for %s', async (sandboxMode) => {
    const events = await collectEvents(new CrushAdapter({ workingDirectory: crushCwd, sandboxMode }).execute({ prompt: 'x' }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'CAPABILITY_DENIED' })
    expect(mockSpawnAndStreamJsonl).not.toHaveBeenCalled()
  })

  it('uses private config policy rather than invented permission flags', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'text_result', content: 'ok' }
    })
    await collectEvents(new CrushAdapter({ workingDirectory: crushCwd, sandboxMode: 'read-only' }).execute({ prompt: 'x' }))
    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).not.toContain('--permission')
    expect(args).toContain('--data-dir')
  })

  it('distinguishes the internal tool loop from observable text transport', () => {
    expect(new CrushAdapter({ workingDirectory: crushCwd }).getCapabilities()).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      emitsToolCalls: false,
      executesToolLoop: true,
      supportsStreaming: false,
      supportsCostUsage: isCrushUsageReaderAvailable(),
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    })
  })
})
