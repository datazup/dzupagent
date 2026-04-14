import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted so the mock is available when vi.mock factory runs
const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue(['file1.ts', 'file2.ts']),
}))

import { mkdir, readdir } from 'node:fs/promises'
import { CheckpointManager } from '../vfs/checkpoint-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGitSuccess(stdout = '', stderr = '') {
  execFileAsyncMock.mockResolvedValue({ stdout, stderr })
}

function mockGitFailure(error = new Error('git failed')) {
  execFileAsyncMock.mockRejectedValue(error)
}

function mockGitSequence(results: Array<{ stdout?: string; stderr?: string; error?: Error }>) {
  let callIndex = 0
  execFileAsyncMock.mockImplementation(() => {
    const result = results[Math.min(callIndex, results.length - 1)]!
    callIndex++
    if (result.error) return Promise.reject(result.error)
    return Promise.resolve({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CheckpointManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(readdir).mockResolvedValue(['file1.ts', 'file2.ts'] as never)
    mockGitSuccess()
  })

  describe('constructor', () => {
    it('uses default config values when none provided', () => {
      const mgr = new CheckpointManager()
      expect(mgr).toBeDefined()
    })

    it('accepts custom configuration', () => {
      const mgr = new CheckpointManager({
        baseDir: '/tmp/custom-checkpoints',
        maxSnapshots: 10,
        timeoutMs: 5000,
        maxFiles: 100,
      })
      expect(mgr).toBeDefined()
    })
  })

  describe('newTurn()', () => {
    it('allows re-snapshotting a directory after newTurn', async () => {
      mockGitSequence([
        // First ensureCheckpoint:
        { stdout: '' }, // rev-parse --git-dir
        { stdout: '' }, // add -A
        { error: new Error('changes exist') }, // diff --cached --quiet
        { stdout: '' }, // commit
        { stdout: 'abc123\n' }, // rev-parse HEAD
        { stdout: '2\n' }, // rev-list --count
        // Second call after newTurn:
        { stdout: '' }, // rev-parse --git-dir
        { stdout: '' }, // add -A
        { error: new Error('changes exist') }, // diff --cached --quiet
        { stdout: '' }, // commit
        { stdout: 'def456\n' }, // rev-parse HEAD
        { stdout: '3\n' }, // rev-list --count
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })

      const result1 = await mgr.ensureCheckpoint('/test/dir', 'first snapshot')
      expect(result1.status).toBe('created')
      if (result1.status === 'created') expect(result1.checkpointId).toBe('abc123')

      // Second call without newTurn should be deduped
      const result2 = await mgr.ensureCheckpoint('/test/dir', 'deduped')
      expect(result2.status).toBe('deduplicated')

      // After newTurn, should allow new checkpoint
      mgr.newTurn()
      const result3 = await mgr.ensureCheckpoint('/test/dir', 'after turn')
      expect(result3.status).toBe('created')
      if (result3.status === 'created') expect(result3.checkpointId).toBe('def456')
    })
  })

  describe('ensureCheckpoint()', () => {
    it('returns skipped status for root directory', async () => {
      const mgr = new CheckpointManager()
      const result = await mgr.ensureCheckpoint('/', 'should skip root')
      expect(result.status).toBe('skipped')
      if (result.status === 'skipped') expect(result.reason).toContain('unsafe directory')
    })

    it('returns skipped status for home directory', async () => {
      const mgr = new CheckpointManager()
      const home = process.env['HOME'] ?? ''
      if (home) {
        const result = await mgr.ensureCheckpoint(home, 'should skip home')
        expect(result.status).toBe('skipped')
        if (result.status === 'skipped') expect(result.reason).toContain('unsafe directory')
      }
    })

    it('returns skipped status when directory has too many files', async () => {
      const manyFiles = Array.from({ length: 60_000 }, (_, i) => `file${i}.ts`)
      vi.mocked(readdir).mockResolvedValue(manyFiles as never)

      const mgr = new CheckpointManager({ maxFiles: 50_000 })
      const result = await mgr.ensureCheckpoint('/test/dir', 'too many files')
      expect(result.status).toBe('skipped')
      if (result.status === 'skipped') expect(result.reason).toContain('maxFiles')
    })

    it('returns failed status when readdir fails (directory does not exist)', async () => {
      vi.mocked(readdir).mockRejectedValue(new Error('ENOENT'))

      const mgr = new CheckpointManager()
      const result = await mgr.ensureCheckpoint('/nonexistent', 'missing dir')
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.error).toBe('ENOENT')
    })

    it('returns created status with commit hash on successful snapshot', async () => {
      mockGitSequence([
        { stdout: '' }, // rev-parse --git-dir
        { stdout: '' }, // add -A
        { error: new Error('has changes') }, // diff --cached --quiet
        { stdout: '' }, // commit
        { stdout: 'abc1234567890\n' }, // rev-parse HEAD
        { stdout: '5\n' }, // rev-list --count
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.ensureCheckpoint('/test/project', 'before edit')
      expect(result.status).toBe('created')
      if (result.status === 'created') expect(result.checkpointId).toBe('abc1234567890')
    })

    it('returns deduplicated status when there are no changes to snapshot', async () => {
      mockGitSequence([
        { stdout: '' }, // rev-parse --git-dir
        { stdout: '' }, // add -A
        { stdout: '' }, // diff --cached --quiet (no changes)
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.ensureCheckpoint('/test/project', 'no changes')
      expect(result.status).toBe('deduplicated')
    })

    it('returns failed status on git failure (non-fatal)', async () => {
      mockGitFailure(new Error('git not found'))

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.ensureCheckpoint('/test/project', 'git error')
      expect(result.status).toBe('failed')
      if (result.status === 'failed') expect(result.error).toBe('git not found')
    })

    it('returns deduplicated status within the same turn', async () => {
      mockGitSequence([
        { stdout: '' }, // rev-parse
        { stdout: '' }, // add -A
        { error: new Error('has changes') }, // diff --cached --quiet
        { stdout: '' }, // commit
        { stdout: 'first-hash\n' }, // rev-parse HEAD
        { stdout: '1\n' }, // rev-list --count
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result1 = await mgr.ensureCheckpoint('/test/dir', 'first')
      const result2 = await mgr.ensureCheckpoint('/test/dir', 'second')

      expect(result1.status).toBe('created')
      if (result1.status === 'created') expect(result1.checkpointId).toBe('first-hash')
      expect(result2.status).toBe('deduplicated')
    })

    it('creates shadow directory via mkdir', async () => {
      mockGitSequence([
        { stdout: '' }, // rev-parse
        { stdout: '' }, // add -A
        { stdout: '' }, // diff --cached --quiet (no changes)
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/shadow-test' })
      await mgr.ensureCheckpoint('/test/project', 'test')

      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/shadow-test/'),
        { recursive: true },
      )
    })
  })

  describe('list()', () => {
    it('parses git log output into checkpoint entries', async () => {
      const gitLog = [
        'abc123|2024-01-15T10:00:00Z|before edit',
        'def456|2024-01-15T09:00:00Z|initial snapshot',
      ].join('\n')

      mockGitSuccess(gitLog)

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const entries = await mgr.list('/test/project')

      expect(entries).toHaveLength(2)
      expect(entries[0]!.hash).toBe('abc123')
      expect(entries[0]!.timestamp).toBe('2024-01-15T10:00:00Z')
      expect(entries[0]!.reason).toBe('before edit')
      expect(entries[1]!.hash).toBe('def456')
    })

    it('returns empty array on git failure', async () => {
      mockGitFailure()

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const entries = await mgr.list('/test/project')
      expect(entries).toEqual([])
    })

    it('handles empty log output', async () => {
      mockGitSuccess('')

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const entries = await mgr.list('/test/project')
      expect(entries).toEqual([])
    })

    it('handles reason with pipe characters', async () => {
      mockGitSuccess('abc123|2024-01-15T10:00:00Z|reason with | pipe | chars')

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const entries = await mgr.list('/test/project')

      expect(entries).toHaveLength(1)
      expect(entries[0]!.reason).toBe('reason with | pipe | chars')
    })
  })

  describe('diff()', () => {
    it('parses name-status and shortstat output', async () => {
      mockGitSequence([
        { stdout: '' }, // add -A
        { stdout: 'A\tnew-file.ts\nM\tchanged.ts\nD\tremoved.ts\n' }, // diff --name-status
        { stdout: '3 files changed, 15 insertions(+), 5 deletions(-)' }, // diff --shortstat
      ])

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.diff('/test/project', 'abc123')

      expect(result).not.toBeNull()
      expect(result!.added).toContain('new-file.ts')
      expect(result!.modified).toContain('changed.ts')
      expect(result!.deleted).toContain('removed.ts')
      expect(result!.stats.filesChanged).toBe(3)
      expect(result!.stats.insertions).toBe(15)
      expect(result!.stats.deletions).toBe(5)
    })

    it('returns null on failure', async () => {
      mockGitFailure()

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.diff('/test/project', 'abc123')
      expect(result).toBeNull()
    })
  })

  describe('restore()', () => {
    it('creates a pre-rollback snapshot and restores checkpoint', async () => {
      const argLog: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        argLog.push(args)
        if (args.includes('--cached') && args.includes('--quiet')) {
          return Promise.reject(new Error('changes'))
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return Promise.resolve({ stdout: 'pre-rollback-hash\n', stderr: '' })
        }
        if (args.includes('rev-list')) {
          return Promise.resolve({ stdout: '3\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.restore('/test/project', 'target-hash')

      expect(result).toBe(true)
      const checkoutCall = argLog.find(
        (c) => c.includes('checkout') && c.includes('target-hash'),
      )
      expect(checkoutCall).toBeDefined()
    })

    it('returns false on failure', async () => {
      mockGitFailure()

      const mgr = new CheckpointManager({ baseDir: '/tmp/test-cp' })
      const result = await mgr.restore('/test/project', 'abc123')
      expect(result).toBe(false)
    })
  })
})
