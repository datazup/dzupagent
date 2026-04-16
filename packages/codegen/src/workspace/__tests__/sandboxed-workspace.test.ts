import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { LocalWorkspace } from '../local-workspace.js'
import { SandboxedWorkspace } from '../sandboxed-workspace.js'
import type { SandboxProtocol, ExecResult } from '../../sandbox/sandbox-protocol.js'
import type { WorkspaceOptions } from '../types.js'

/**
 * Creates a mock SandboxProtocol where `execute` and `uploadFiles` are
 * vi.fn() stubs that can be inspected by assertions.
 */
function createMockSandbox(): SandboxProtocol & {
  execute: ReturnType<typeof vi.fn>
  uploadFiles: ReturnType<typeof vi.fn>
} {
  return {
    execute: vi.fn<[string, { cwd?: string; timeoutMs?: number }?], Promise<ExecResult>>().mockResolvedValue({
      exitCode: 0,
      stdout: 'mock stdout',
      stderr: '',
      timedOut: false,
    }),
    uploadFiles: vi.fn<[Record<string, string>], Promise<void>>().mockResolvedValue(undefined),
    downloadFiles: vi.fn<[string[]], Promise<Record<string, string>>>().mockResolvedValue({}),
    cleanup: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    isAvailable: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
  }
}

describe('SandboxedWorkspace', () => {
  let tempDir: string
  let inner: LocalWorkspace
  let sandbox: ReturnType<typeof createMockSandbox>
  let ws: SandboxedWorkspace

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `sw-test-${randomUUID()}-`))
    const opts: WorkspaceOptions = {
      rootDir: tempDir,
      search: { provider: 'builtin' },
      command: {
        timeoutMs: 5_000,
        allowedCommands: ['echo', 'node'],
      },
    }
    inner = new LocalWorkspace(opts)
    sandbox = createMockSandbox()
    ws = new SandboxedWorkspace(inner, sandbox)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // 1. readFile delegates to inner LocalWorkspace (not sandbox)
  it('readFile delegates to inner LocalWorkspace', async () => {
    await writeFile(join(tempDir, 'hello.txt'), 'local content', 'utf-8')
    const content = await ws.readFile('hello.txt')
    expect(content).toBe('local content')
    // Sandbox should not have been called
    expect(sandbox.execute).not.toHaveBeenCalled()
    expect(sandbox.downloadFiles).not.toHaveBeenCalled()
  })

  // 2. listFiles delegates to inner LocalWorkspace
  it('listFiles delegates to inner LocalWorkspace', async () => {
    await writeFile(join(tempDir, 'a.ts'), 'export {}', 'utf-8')
    await writeFile(join(tempDir, 'b.js'), 'module.exports = {}', 'utf-8')
    const files = await ws.listFiles('*.ts')
    expect(files).toContain('a.ts')
    expect(files).not.toContain('b.js')
    expect(sandbox.execute).not.toHaveBeenCalled()
  })

  // 3. exists delegates to inner LocalWorkspace
  it('exists delegates to inner LocalWorkspace', async () => {
    await writeFile(join(tempDir, 'present.txt'), 'yes', 'utf-8')
    expect(await ws.exists('present.txt')).toBe(true)
    expect(await ws.exists('missing.txt')).toBe(false)
    expect(sandbox.execute).not.toHaveBeenCalled()
  })

  // 4. search delegates to inner LocalWorkspace
  it('search delegates to inner LocalWorkspace', async () => {
    await writeFile(join(tempDir, 'data.ts'), 'const x = 42\nconst y = 99', 'utf-8')
    const results = await ws.search('const y')
    expect(results.length).toBe(1)
    expect(results[0]!.matchText).toBe('const y')
    expect(sandbox.execute).not.toHaveBeenCalled()
  })

  // 5. writeFile routes through sandbox uploadFiles
  it('writeFile routes through sandbox uploadFiles', async () => {
    await ws.writeFile('out.ts', 'export const z = 1')
    expect(sandbox.uploadFiles).toHaveBeenCalledTimes(1)
    expect(sandbox.uploadFiles).toHaveBeenCalledWith({ 'out.ts': 'export const z = 1' })
  })

  // 6. runCommand routes through sandbox execute
  it('runCommand routes through sandbox execute', async () => {
    const result = await ws.runCommand('echo', ['hello'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('mock stdout')
    expect(sandbox.execute).toHaveBeenCalledTimes(1)
    // The command should be shell-escaped and joined
    expect(sandbox.execute).toHaveBeenCalledWith('echo hello', expect.objectContaining({}))
  })

  // 7. runCommand blocked command returns exitCode 126 without hitting sandbox
  it('runCommand blocks disallowed commands without hitting sandbox', async () => {
    const result = await ws.runCommand('rm', ['-rf', '/'])
    expect(result.exitCode).toBe(126)
    expect(result.stderr).toContain('not in the allowed commands list')
    expect(sandbox.execute).not.toHaveBeenCalled()
  })

  // 8. rootDir and options pass through from inner workspace
  it('rootDir and options pass through from inner workspace', () => {
    expect(ws.rootDir).toBe(inner.rootDir)
    expect(ws.options).toBe(inner.options)
    expect(ws.options.command?.allowedCommands).toEqual(['echo', 'node'])
  })
})
