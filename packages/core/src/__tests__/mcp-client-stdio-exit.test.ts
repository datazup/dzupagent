/**
 * Regression tests for RF-CODE-02 — MCP stdio client must gate success on the
 * child process's exit code. Partial stdout output from a non-zero-exiting
 * child must NOT be treated as success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter, Readable } from 'node:stream'

// ---- child_process mock ----------------------------------------------------

interface StdinMock {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

type ChildMock = EventEmitter & {
  stdout: Readable
  stderr: Readable
  stdin: StdinMock
}

interface MakeChildOpts {
  stdout?: string
  stderr?: string
  exitCode: number | null
}

function makeChild(opts: MakeChildOpts): ChildMock {
  const child = new EventEmitter() as ChildMock
  child.stdout = Readable.from(opts.stdout ?? '')
  child.stderr = Readable.from(opts.stderr ?? '')
  child.stdin = { write: vi.fn(), end: vi.fn() }

  // Fire close after stdout fully drains, so the consumer sees all data first.
  child.stdout.on('end', () => {
    setImmediate(() => child.emit('close', opts.exitCode))
  })
  return child
}

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

// ---------------------------------------------------------------------------

const { spawn } = await import('node:child_process')
const spawnMock = spawn as ReturnType<typeof vi.fn>

const { MCPClient } = await import('../mcp/mcp-client.js')
import type { MCPServerConfig } from '../mcp/mcp-types.js'

const stdioConfig: MCPServerConfig = {
  id: 'test-stdio',
  name: 'Test stdio MCP',
  transport: 'stdio',
  url: '/usr/bin/true',
  args: [],
  timeoutMs: 1000,
}

describe('MCPClient stdio — exit-code gating (RF-CODE-02)', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('rejects (does not connect) when child exits non-zero even with partial stdout', async () => {
    // Child writes a *plausible-looking* tools/list response then crashes.
    const partial = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{ name: 'malicious', description: 'should not be visible', inputSchema: { type: 'object' } }],
      },
    })
    spawnMock.mockReturnValueOnce(makeChild({
      stdout: `${partial}\n`,
      stderr: 'segfault: reticulating splines\n',
      exitCode: 139,
    }))

    const client = new MCPClient()
    client.addServer(stdioConfig)

    const ok = await client.connect(stdioConfig.id)
    expect(ok).toBe(false)

    const status = client.getStatus()
    expect(status[0]?.state).toBe('error')
    // Diagnostic must include the exit code and stderr summary.
    expect(status[0]?.lastError).toMatch(/exited with code 139/i)
    expect(status[0]?.lastError).toMatch(/segfault/)
    // No tools must have leaked out of a failed connect.
    expect(client.getEagerTools()).toHaveLength(0)
  })

  it('rejects when child exits with null code (signal-killed) even with stdout', async () => {
    const partial = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'sigterm-tool', description: 'x', inputSchema: { type: 'object' } }] },
    })
    spawnMock.mockReturnValueOnce(makeChild({
      stdout: `${partial}\n`,
      stderr: '',
      exitCode: null, // signal-terminated children report code === null
    }))

    const client = new MCPClient()
    client.addServer(stdioConfig)
    const ok = await client.connect(stdioConfig.id)
    expect(ok).toBe(false)

    const status = client.getStatus()
    expect(status[0]?.lastError).toMatch(/exited with code/i)
    expect(client.getEagerTools()).toHaveLength(0)
  })

  it('connects successfully when child exits with code 0 and emits valid tools/list', async () => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{ name: 'echo', description: 'echo tool', inputSchema: { type: 'object' } }],
      },
    })
    spawnMock.mockReturnValueOnce(makeChild({
      stdout: `${payload}\n`,
      exitCode: 0,
    }))

    const client = new MCPClient()
    client.addServer(stdioConfig)
    const ok = await client.connect(stdioConfig.id)
    expect(ok).toBe(true)

    const tools = client.getEagerTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('echo')
  })

  it('invokeTool surfaces an error result when the child exits non-zero on tool call', async () => {
    // 1st spawn: discovery (clean exit)
    const discoveryPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{ name: 'flaky', description: 'flaky', inputSchema: { type: 'object' } }],
      },
    })
    spawnMock.mockReturnValueOnce(makeChild({ stdout: `${discoveryPayload}\n`, exitCode: 0 }))

    // 2nd spawn: tools/call returns *something* on stdout but exits non-zero.
    const partialResult = JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      result: { content: [{ type: 'text', text: 'half-written response' }] },
    })
    spawnMock.mockReturnValueOnce(makeChild({
      stdout: `${partialResult}\n`,
      stderr: 'panic at tool boundary',
      exitCode: 1,
    }))

    const client = new MCPClient()
    client.addServer(stdioConfig)
    expect(await client.connect(stdioConfig.id)).toBe(true)

    const result = await client.invokeTool('flaky', {})
    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/Tool invocation failed/i)
    // The exit code and stderr must be surfaced.
    expect(text).toMatch(/exited with code 1/i)
    expect(text).toMatch(/panic at tool boundary/)
  })
})
