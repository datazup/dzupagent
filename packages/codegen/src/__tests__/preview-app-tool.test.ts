import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPreviewAppTool } from '../tools/preview-app.tool.js'
import type { SandboxProtocolV2 } from '../sandbox/sandbox-protocol-v2.js'
import type { ExecResult, ExecOptions } from '../sandbox/sandbox-protocol.js'

// ---------------------------------------------------------------------------
// Mock SandboxProtocolV2
// ---------------------------------------------------------------------------

function createMockSandbox(overrides?: Partial<SandboxProtocolV2>): SandboxProtocolV2 {
  return {
    execute: vi.fn<[string, ExecOptions?], Promise<ExecResult>>().mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }),
    uploadFiles: vi.fn<[Record<string, string>], Promise<void>>().mockResolvedValue(undefined),
    downloadFiles: vi.fn<[string[]], Promise<Record<string, string>>>().mockResolvedValue({}),
    cleanup: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    isAvailable: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    startSession: vi.fn().mockResolvedValue({ sessionId: 'session-123' }),
    executeStream: vi.fn().mockImplementation(async function* () {
      yield { type: 'stdout' as const, data: 'Server running on port 3000' }
    }),
    exposePort: vi.fn().mockResolvedValue({ url: 'http://localhost:3000' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPreviewAppTool', () => {
  let sandbox: SandboxProtocolV2

  beforeEach(() => {
    sandbox = createMockSandbox()
  })

  it('creates a tool with name "preview_app"', () => {
    const tool = createPreviewAppTool(sandbox)
    expect(tool.name).toBe('preview_app')
  })

  it('starts a session, exposes port, and returns ready status', async () => {
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.sessionId).toBe('session-123')
    expect(result.url).toBe('http://localhost:3000')
    expect(result.health).toBe('ready')
    expect(sandbox.startSession).toHaveBeenCalledTimes(1)
    expect(sandbox.exposePort).toHaveBeenCalledWith('session-123', 3000)
  })

  it('reuses an existing session when sessionId is provided', async () => {
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({
      command: 'npm start',
      port: 8080,
      sessionId: 'existing-session',
    })
    const result = JSON.parse(rawResult as string)

    expect(result.sessionId).toBe('existing-session')
    expect(sandbox.startSession).not.toHaveBeenCalled()
    expect(sandbox.exposePort).toHaveBeenCalledWith('existing-session', 8080)
  })

  it('returns error when startSession fails', async () => {
    sandbox = createMockSandbox({
      startSession: vi.fn().mockRejectedValue(new Error('Docker not available')),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('error')
    expect(result.message).toContain('Docker not available')
    expect(result.sessionId).toBe('')
  })

  it('returns error when exposePort fails', async () => {
    sandbox = createMockSandbox({
      exposePort: vi.fn().mockRejectedValue(new Error('Port conflict')),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('error')
    expect(result.message).toContain('Port conflict')
    expect(result.sessionId).toBe('session-123')
  })

  it('handles stderr output as ready status', async () => {
    sandbox = createMockSandbox({
      executeStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'stderr' as const, data: 'Listening on http://localhost:3000' }
      }),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('ready')
    expect(result.message).toContain('Listening')
  })

  it('handles process exit with non-zero code as error', async () => {
    sandbox = createMockSandbox({
      executeStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'exit' as const, exitCode: 1, timedOut: false }
      }),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('error')
    expect(result.message).toContain('exited with code 1')
  })

  it('handles process exit with zero code as ready', async () => {
    sandbox = createMockSandbox({
      executeStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'exit' as const, exitCode: 0, timedOut: false }
      }),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('ready')
  })

  it('handles executeStream throwing an error', async () => {
    sandbox = createMockSandbox({
      executeStream: vi.fn().mockImplementation(async function* () {
        throw new Error('Stream broken')
      }),
    })
    const tool = createPreviewAppTool(sandbox)
    const rawResult = await tool.invoke({ command: 'npm run dev', port: 3000 })
    const result = JSON.parse(rawResult as string)

    expect(result.health).toBe('error')
    expect(result.message).toContain('Stream broken')
  })
})
