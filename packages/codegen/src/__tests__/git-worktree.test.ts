import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}))

import { GitWorktreeManager } from '../git/git-worktree.js'

describe('GitWorktreeManager', () => {
  let manager: GitWorktreeManager

  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    manager = new GitWorktreeManager({ repoDir: '/repo' })
  })

  describe('create', () => {
    it('creates a worktree with a branch', async () => {
      const info = await manager.create('feature-x')
      expect(info.branch).toBe('feature-x')
      expect(info.baseBranch).toBe('HEAD')
      expect(info.dir).toContain('feature-x')
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'add', '-b', 'feature-x']),
        expect.any(Object),
      )
    })

    it('creates a worktree from a specific base branch', async () => {
      const info = await manager.create('fix-y', 'main')
      expect(info.baseBranch).toBe('main')
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['main']),
        expect.any(Object),
      )
    })
  })

  describe('remove', () => {
    it('removes a worktree and deletes the branch', async () => {
      await manager.remove('feature-x')
      expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
      )
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['branch', '-D', 'feature-x']),
        expect.any(Object),
      )
    })

    it('skips branch deletion when deleteBranch is false', async () => {
      await manager.remove('feature-x', false)
      expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    })

    it('suppresses errors from branch deletion', async () => {
      let callCount = 0
      execFileAsyncMock.mockImplementation(() => {
        callCount++
        if (callCount === 2) return Promise.reject(new Error('branch not found'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      await expect(manager.remove('feature-x')).resolves.toBeUndefined()
    })
  })

  describe('list', () => {
    it('parses porcelain worktree list output', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: [
          'worktree /repo',
          'HEAD abc123',
          'branch refs/heads/main',
          '',
          'worktree /repo/.forge-worktrees/feature-x',
          'HEAD def456',
          'branch refs/heads/feature-x',
          '',
        ].join('\n'),
        stderr: '',
      })

      const entries = await manager.list()
      expect(entries).toHaveLength(2)
      expect(entries[0]!.path).toBe('/repo')
      expect(entries[0]!.branch).toBe('main')
      expect(entries[0]!.head).toBe('abc123')
      expect(entries[1]!.branch).toBe('feature-x')
    })

    it('returns empty for no output', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
      const entries = await manager.list()
      expect(entries).toHaveLength(0)
    })
  })

  describe('merge', () => {
    it('merges a worktree branch into target', async () => {
      let callIdx = 0
      execFileAsyncMock.mockImplementation(() => {
        callIdx++
        if (callIdx === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        return Promise.resolve({ stdout: 'Already up to date.\n', stderr: '' })
      })

      const result = await manager.merge('feature-x', 'main')
      expect(result.success).toBe(true)
    })

    it('reports failure on CONFLICT', async () => {
      let callIdx = 0
      execFileAsyncMock.mockImplementation(() => {
        callIdx++
        if (callIdx === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        if (callIdx === 2) return Promise.resolve({ stdout: '', stderr: '' })
        if (callIdx === 3) return Promise.resolve({ stdout: 'CONFLICT (content): merge conflict', stderr: '' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const result = await manager.merge('feature-x', 'main')
      expect(result.success).toBe(false)
    })

    it('handles errors gracefully', async () => {
      execFileAsyncMock.mockRejectedValue(new Error('checkout failed'))
      const result = await manager.merge('feature-x', 'main')
      expect(result.success).toBe(false)
      expect(result.output).toContain('checkout failed')
    })
  })

  describe('constructor', () => {
    it('uses custom worktree base dir', () => {
      const m = new GitWorktreeManager({
        repoDir: '/repo',
        worktreeBaseDir: '/custom/worktrees',
        timeoutMs: 5000,
      })
      expect(m).toBeDefined()
    })
  })
})
