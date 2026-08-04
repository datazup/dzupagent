import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlySandbox } from './fly-sandbox.js'

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FlySandbox file transfer safety', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uploadFiles() passes file path as argv without a shell', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse({ exit_code: 0, stdout: '', stderr: '' }))
    const sb = new FlySandbox({ apiToken: 'tok', appName: 'app' })
    ;(sb as unknown as Record<string, unknown>)['machineId'] = 'mach-pre'

    await sb.uploadFiles({ 'src/foo.ts': 'content' })

    const execCall = fetchSpy.mock.calls.find((c) => (c[0] as string).includes('/exec'))
    expect(execCall).toBeDefined()
    const body = JSON.parse((execCall![1] as RequestInit).body as string) as { cmd: string[] }
    expect(body.cmd).not.toEqual(expect.arrayContaining(['sh', '-c']))
    expect(body.cmd).toEqual(expect.arrayContaining(['src/foo.ts']))
  })

  it('uploadFiles() rejects shell metacharacters in file paths before exec', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse({ exit_code: 0, stdout: '', stderr: '' }))
    const sb = new FlySandbox({ apiToken: 'tok', appName: 'app' })
    ;(sb as unknown as Record<string, unknown>)['machineId'] = 'mach-pre'

    await expect(sb.uploadFiles({ 'foo; touch /pwned': 'content' })).rejects.toThrow('Invalid sandbox file path')

    const execCalls = fetchSpy.mock.calls.filter((c) => (c[0] as string).includes('/exec'))
    expect(execCalls).toHaveLength(0)
  })
})
