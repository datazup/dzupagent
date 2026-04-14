import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { WorkspaceRunner } from '../vfs/workspace-runner.js'
import type { SandboxProtocol, ExecResult, ExecOptions } from '../sandbox/sandbox-protocol.js'

// ---------------------------------------------------------------------------
// Mock SandboxProtocol
// ---------------------------------------------------------------------------

interface MockSandbox extends SandboxProtocol {
  uploadedFiles: Record<string, string>
  executedCalls: Array<{ command: string; options?: ExecOptions }>
  sandboxFiles: Record<string, string>
  nextResult: ExecResult
}

function createMockSandbox(overrides?: Partial<SandboxProtocol>): MockSandbox {
  const mock: MockSandbox = {
    uploadedFiles: {},
    executedCalls: [],
    sandboxFiles: {},
    nextResult: { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false },

    async uploadFiles(files: Record<string, string>): Promise<void> {
      Object.assign(mock.uploadedFiles, files)
      Object.assign(mock.sandboxFiles, files)
    },
    async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
      mock.executedCalls.push({ command, options })
      return { ...mock.nextResult }
    },
    async downloadFiles(paths: string[]): Promise<Record<string, string>> {
      const result: Record<string, string> = {}
      for (const p of paths) {
        if (p in mock.sandboxFiles) {
          result[p] = mock.sandboxFiles[p]
        }
      }
      return result
    },
    async isAvailable(): Promise<boolean> {
      return true
    },
    async cleanup(): Promise<void> {
      mock.uploadedFiles = {}
      mock.executedCalls = []
      mock.sandboxFiles = {}
    },
  }

  if (overrides) {
    Object.assign(mock, overrides)
  }

  return mock
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceRunner', () => {
  let vfs: VirtualFS
  let sandbox: ReturnType<typeof createMockSandbox>
  let runner: WorkspaceRunner

  beforeEach(() => {
    vfs = new VirtualFS({
      'src/index.ts': 'export const x = 1',
      'src/util.ts': 'export function add(a: number, b: number) { return a + b }',
    })
    sandbox = createMockSandbox()
    runner = new WorkspaceRunner(sandbox)
  })

  it('uploads VFS snapshot to sandbox', async () => {
    await runner.run(vfs, { command: 'echo hello' })

    expect(sandbox.uploadedFiles).toEqual({
      'src/index.ts': 'export const x = 1',
      'src/util.ts': 'export function add(a: number, b: number) { return a + b }',
    })
  })

  it('executes command and returns result', async () => {
    sandbox.nextResult = { exitCode: 0, stdout: 'test output', stderr: '', timedOut: false }

    const result = await runner.run(vfs, { command: 'npm test' })

    expect(result.stdout).toBe('test output')
    expect(result.stderr).toBe('')
    expect(sandbox.executedCalls).toHaveLength(1)
    expect(sandbox.executedCalls[0].command).toBe('npm test')
  })

  it('reports success for exit code 0', async () => {
    sandbox.nextResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }

    const result = await runner.run(vfs, { command: 'true' })

    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('reports failure for non-zero exit code', async () => {
    sandbox.nextResult = { exitCode: 1, stdout: '', stderr: 'Error: tests failed', timedOut: false }

    const result = await runner.run(vfs, { command: 'npm test' })

    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('Error: tests failed')
  })

  it('tracks execution duration', async () => {
    const result = await runner.run(vfs, { command: 'echo fast' })

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.durationMs).toBe('number')
  })

  it('passes cwd and timeoutMs to sandbox', async () => {
    await runner.run(vfs, {
      command: 'npm test',
      cwd: '/workspace/src',
      timeoutMs: 30_000,
    })

    expect(sandbox.executedCalls[0].options).toEqual({
      cwd: '/workspace/src',
      timeoutMs: 30_000,
    })
  })

  it('uses default timeout of 60_000 when not specified', async () => {
    await runner.run(vfs, { command: 'npm test' })

    expect(sandbox.executedCalls[0].options?.timeoutMs).toBe(60_000)
  })

  it('propagates timedOut flag', async () => {
    sandbox.nextResult = { exitCode: -1, stdout: '', stderr: 'timeout', timedOut: true }

    const result = await runner.run(vfs, { command: 'sleep 999' })

    expect(result.timedOut).toBe(true)
  })

  it('syncs modified files back to VFS when syncBack is true', async () => {
    // Simulate the sandbox modifying a file after upload
    const originalExecute = sandbox.execute.bind(sandbox)
    sandbox.execute = async (command: string, options?: ExecOptions) => {
      // Simulate command modifying a file in the sandbox
      sandbox.sandboxFiles['src/index.ts'] = 'export const x = 42'
      return originalExecute(command, options)
    }

    const result = await runner.run(vfs, { command: 'transform', syncBack: true })

    expect(result.modifiedFiles).toEqual(['src/index.ts'])
    expect(vfs.read('src/index.ts')).toBe('export const x = 42')
    // Unmodified file should remain unchanged
    expect(vfs.read('src/util.ts')).toBe('export function add(a: number, b: number) { return a + b }')
  })

  it('does not sync when syncBack is false', async () => {
    sandbox.execute = async () => {
      sandbox.sandboxFiles['src/index.ts'] = 'modified content'
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }

    const result = await runner.run(vfs, { command: 'transform', syncBack: false })

    expect(result.modifiedFiles).toBeUndefined()
    // VFS should be unchanged
    expect(vfs.read('src/index.ts')).toBe('export const x = 1')
  })

  it('does not sync when syncBack is not specified (default false)', async () => {
    sandbox.execute = async () => {
      sandbox.sandboxFiles['src/index.ts'] = 'modified content'
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }

    const result = await runner.run(vfs, { command: 'transform' })

    expect(result.modifiedFiles).toBeUndefined()
    expect(vfs.read('src/index.ts')).toBe('export const x = 1')
  })

  it('only syncs specified syncPaths when provided', async () => {
    sandbox.execute = async () => {
      sandbox.sandboxFiles['src/index.ts'] = 'changed index'
      sandbox.sandboxFiles['src/util.ts'] = 'changed util'
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }

    const result = await runner.run(vfs, {
      command: 'transform',
      syncBack: true,
      syncPaths: ['src/index.ts'],
    })

    expect(result.modifiedFiles).toEqual(['src/index.ts'])
    expect(vfs.read('src/index.ts')).toBe('changed index')
    // util.ts was not in syncPaths, so it should not be synced
    expect(vfs.read('src/util.ts')).toBe('export function add(a: number, b: number) { return a + b }')
  })

  it('returns empty modifiedFiles when nothing changed during sync', async () => {
    // Sandbox files remain identical to uploaded snapshot
    const result = await runner.run(vfs, { command: 'echo noop', syncBack: true })

    expect(result.modifiedFiles).toEqual([])
  })

  it('handles sandbox execution error gracefully', async () => {
    const failingSandbox = createMockSandbox({
      async execute(): Promise<ExecResult> {
        throw new Error('Docker daemon not running')
      },
    })
    const failRunner = new WorkspaceRunner(failingSandbox)

    const result = await failRunner.run(vfs, { command: 'npm test' })

    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('Docker daemon not running')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('isAvailable delegates to sandbox', async () => {
    expect(await runner.isAvailable()).toBe(true)

    const unavailableSandbox = createMockSandbox({
      async isAvailable() {
        return false
      },
    })
    const unavailableRunner = new WorkspaceRunner(unavailableSandbox)
    expect(await unavailableRunner.isAvailable()).toBe(false)
  })

  it('cleanup delegates to sandbox', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined)
    const cleanableSandbox = createMockSandbox({
      cleanup: cleanupFn,
    })
    const cleanRunner = new WorkspaceRunner(cleanableSandbox)

    await cleanRunner.cleanup()

    expect(cleanupFn).toHaveBeenCalledOnce()
  })

  it('works with empty VFS', async () => {
    const emptyVfs = new VirtualFS()
    const result = await runner.run(emptyVfs, { command: 'echo empty' })

    expect(result.success).toBe(true)
    expect(sandbox.uploadedFiles).toEqual({})
  })
})
