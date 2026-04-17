/**
 * Deep-coverage tests for GitWorktreeManager.
 *
 * Exhaustively exercises create(), remove(), list(), merge() and the underlying
 * exec() plumbing. Uses the same hoisted mock pattern as git-worktree.test.ts so
 * no real git process is spawned.
 */
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

import { GitWorktreeManager, type WorktreeManagerConfig } from '../git/git-worktree.js'

/** Grab all git arg arrays passed to the mocked exec */
function allCalls(): string[][] {
  return execFileAsyncMock.mock.calls.map(call => call[1] as string[])
}

/** Grab the options object of the nth call */
function optsAt(idx: number): Record<string, unknown> {
  return execFileAsyncMock.mock.calls[idx]![2] as Record<string, unknown>
}

describe('GitWorktreeManager — deep coverage', () => {
  let manager: GitWorktreeManager

  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    manager = new GitWorktreeManager({ repoDir: '/repo' })
  })

  // ---------------------------------------------------------------------------
  // constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('defaults worktreeBaseDir to <repoDir>/.forge-worktrees', async () => {
      await manager.create('feat-a')
      const args = allCalls()[0]!
      // Path is last positional arg list entry slot 4: ['worktree','add','-b',branch,dir,base]
      expect(args[4]).toBe('/repo/.forge-worktrees/feat-a')
    })

    it('uses custom worktreeBaseDir when provided', async () => {
      const m = new GitWorktreeManager({ repoDir: '/repo', worktreeBaseDir: '/tmp/wt' })
      await m.create('feat-b')
      const args = allCalls()[0]!
      expect(args[4]).toBe('/tmp/wt/feat-b')
    })

    it('defaults timeoutMs to 30_000', async () => {
      await manager.create('feat-c')
      expect(optsAt(0).timeout).toBe(30_000)
    })

    it('uses custom timeoutMs when provided', async () => {
      const m = new GitWorktreeManager({ repoDir: '/repo', timeoutMs: 5_000 })
      await m.create('feat-d')
      expect(optsAt(0).timeout).toBe(5_000)
    })

    it('uses repoDir as cwd on every exec', async () => {
      const m = new GitWorktreeManager({ repoDir: '/different/repo' })
      await m.create('feat-e')
      await m.list()
      expect(optsAt(0).cwd).toBe('/different/repo')
      expect(optsAt(1).cwd).toBe('/different/repo')
    })

    it('uses 10MB maxBuffer on exec calls', async () => {
      await manager.create('feat-f')
      expect(optsAt(0).maxBuffer).toBe(10 * 1024 * 1024)
    })

    it('accepts all config options together', () => {
      const cfg: WorktreeManagerConfig = {
        repoDir: '/r',
        worktreeBaseDir: '/w',
        timeoutMs: 1234,
      }
      const m = new GitWorktreeManager(cfg)
      expect(m).toBeInstanceOf(GitWorktreeManager)
    })

    it('accepts only required repoDir', () => {
      const m = new GitWorktreeManager({ repoDir: '/only-repo' })
      expect(m).toBeInstanceOf(GitWorktreeManager)
    })
  })

  // ---------------------------------------------------------------------------
  // create()
  // ---------------------------------------------------------------------------
  describe('create()', () => {
    it('spawns exactly one git invocation', async () => {
      await manager.create('feat-x')
      expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    })

    it('invokes git as the binary', async () => {
      await manager.create('feat-x')
      expect(execFileAsyncMock.mock.calls[0]![0]).toBe('git')
    })

    it('passes worktree add subcommand', async () => {
      await manager.create('feat-x')
      const args = allCalls()[0]!
      expect(args[0]).toBe('worktree')
      expect(args[1]).toBe('add')
    })

    it('uses -b flag to create the branch', async () => {
      await manager.create('feat-x')
      const args = allCalls()[0]!
      expect(args[2]).toBe('-b')
      expect(args[3]).toBe('feat-x')
    })

    it('returns WorktreeInfo with branch populated', async () => {
      const info = await manager.create('feat-x')
      expect(info.branch).toBe('feat-x')
    })

    it('returns WorktreeInfo with baseBranch=HEAD when unspecified', async () => {
      const info = await manager.create('feat-x')
      expect(info.baseBranch).toBe('HEAD')
    })

    it('returns WorktreeInfo with baseBranch echoed from caller', async () => {
      const info = await manager.create('feat-y', 'develop')
      expect(info.baseBranch).toBe('develop')
    })

    it('returns absolute dir under worktree base dir', async () => {
      const info = await manager.create('feat-x')
      expect(info.dir).toBe('/repo/.forge-worktrees/feat-x')
    })

    it('forwards custom base branch to git command', async () => {
      await manager.create('feat-y', 'release/1.0')
      expect(allCalls()[0]).toContain('release/1.0')
    })

    it('uses HEAD as last positional when no base branch passed', async () => {
      await manager.create('feat-x')
      const args = allCalls()[0]!
      expect(args[args.length - 1]).toBe('HEAD')
    })

    it('propagates errors when git exits non-zero', async () => {
      execFileAsyncMock.mockRejectedValueOnce(new Error('fatal: branch already exists'))
      await expect(manager.create('feat-dup')).rejects.toThrow('branch already exists')
    })

    it('supports branch names containing slashes (e.g. feature/foo)', async () => {
      const info = await manager.create('feature/foo')
      expect(info.branch).toBe('feature/foo')
      expect(info.dir).toBe('/repo/.forge-worktrees/feature/foo')
    })

    it('supports concurrent creation of multiple worktrees', async () => {
      const [a, b, c] = await Promise.all([
        manager.create('a'),
        manager.create('b'),
        manager.create('c'),
      ])
      expect(a.branch).toBe('a')
      expect(b.branch).toBe('b')
      expect(c.branch).toBe('c')
      expect(execFileAsyncMock).toHaveBeenCalledTimes(3)
    })

    it('each concurrent create uses its own dir', async () => {
      await Promise.all([manager.create('a'), manager.create('b')])
      const dirs = allCalls().map(args => args[4])
      expect(dirs).toEqual(
        expect.arrayContaining(['/repo/.forge-worktrees/a', '/repo/.forge-worktrees/b']),
      )
    })

    it('returns a new object on each call (not memoised)', async () => {
      const i1 = await manager.create('x')
      const i2 = await manager.create('y')
      expect(i1).not.toBe(i2)
    })
  })

  // ---------------------------------------------------------------------------
  // remove()
  // ---------------------------------------------------------------------------
  describe('remove()', () => {
    it('passes --force to git worktree remove', async () => {
      await manager.remove('feat-x')
      expect(allCalls()[0]).toContain('--force')
    })

    it('passes the correct worktree dir to remove', async () => {
      await manager.remove('feat-x')
      expect(allCalls()[0]).toContain('/repo/.forge-worktrees/feat-x')
    })

    it('uses worktree remove subcommand', async () => {
      await manager.remove('feat-x')
      const args = allCalls()[0]!
      expect(args[0]).toBe('worktree')
      expect(args[1]).toBe('remove')
    })

    it('invokes two git calls when deleteBranch=true (default)', async () => {
      await manager.remove('feat-x')
      expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    })

    it('second call is branch -D <name>', async () => {
      await manager.remove('feat-x')
      expect(allCalls()[1]).toEqual(['branch', '-D', 'feat-x'])
    })

    it('invokes only one git call when deleteBranch=false', async () => {
      await manager.remove('feat-x', false)
      expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    })

    it('suppresses errors from branch deletion (branch missing)', async () => {
      let call = 0
      execFileAsyncMock.mockImplementation(() => {
        call += 1
        return call === 2
          ? Promise.reject(new Error('error: branch not found'))
          : Promise.resolve({ stdout: '', stderr: '' })
      })
      await expect(manager.remove('feat-x')).resolves.toBeUndefined()
    })

    it('propagates errors from the worktree remove step', async () => {
      execFileAsyncMock.mockRejectedValueOnce(new Error('worktree does not exist'))
      await expect(manager.remove('missing')).rejects.toThrow('worktree does not exist')
    })

    it('uses custom worktreeBaseDir for remove path', async () => {
      const m = new GitWorktreeManager({ repoDir: '/repo', worktreeBaseDir: '/tmp/forge' })
      await m.remove('feat-x', false)
      expect(allCalls()[0]).toContain('/tmp/forge/feat-x')
    })

    it('remove with deleteBranch=false does not issue branch -D', async () => {
      await manager.remove('feat-x', false)
      for (const args of allCalls()) {
        expect(args).not.toEqual(expect.arrayContaining(['branch', '-D']))
      }
    })

    it('is safe to call remove multiple times (idempotent under mock)', async () => {
      await manager.remove('feat-x')
      await manager.remove('feat-x')
      expect(execFileAsyncMock).toHaveBeenCalledTimes(4)
    })
  })

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------
  describe('list()', () => {
    it('uses --porcelain flag', async () => {
      await manager.list()
      expect(allCalls()[0]).toEqual(['worktree', 'list', '--porcelain'])
    })

    it('returns [] for completely empty stdout', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
      expect(await manager.list()).toEqual([])
    })

    it('returns [] for whitespace/newline only stdout', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '\n\n\n', stderr: '' })
      expect(await manager.list()).toEqual([])
    })

    it('parses a single worktree entry', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n',
        stderr: '',
      })
      const entries = await manager.list()
      expect(entries).toEqual([{ path: '/repo', branch: 'main', head: 'abc123' }])
    })

    it('parses multiple worktree entries', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: [
          'worktree /repo',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /repo/.forge-worktrees/a',
          'HEAD def',
          'branch refs/heads/a',
          '',
          'worktree /repo/.forge-worktrees/b',
          'HEAD 123',
          'branch refs/heads/b',
        ].join('\n'),
        stderr: '',
      })
      const entries = await manager.list()
      expect(entries).toHaveLength(3)
      expect(entries.map(e => e.branch)).toEqual(['main', 'a', 'b'])
    })

    it('strips refs/heads/ prefix from branches', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /x\nHEAD h1\nbranch refs/heads/feature/deep/name\n',
        stderr: '',
      })
      const [entry] = await manager.list()
      expect(entry!.branch).toBe('feature/deep/name')
    })

    it('extracts HEAD SHA correctly', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /x\nHEAD deadbeefcafe\nbranch refs/heads/x\n',
        stderr: '',
      })
      const [entry] = await manager.list()
      expect(entry!.head).toBe('deadbeefcafe')
    })

    it('handles worktree without branch line (detached)', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /x\nHEAD sha\n',
        stderr: '',
      })
      const entries = await manager.list()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.branch).toBe('')
      expect(entries[0]!.head).toBe('sha')
    })

    it('handles worktree without HEAD line', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /x\nbranch refs/heads/main\n',
        stderr: '',
      })
      const entries = await manager.list()
      expect(entries[0]!.head).toBe('')
      expect(entries[0]!.branch).toBe('main')
    })

    it('ignores unknown keys (e.g. locked, prunable)', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout:
          'worktree /x\nHEAD h\nbranch refs/heads/main\nlocked\nprunable\nsomething-else value\n',
        stderr: '',
      })
      const [entry] = await manager.list()
      expect(entry).toEqual({ path: '/x', branch: 'main', head: 'h' })
    })

    it('propagates exec errors', async () => {
      execFileAsyncMock.mockRejectedValue(new Error('git not available'))
      await expect(manager.list()).rejects.toThrow('git not available')
    })

    it('returns an Array instance', async () => {
      execFileAsyncMock.mockResolvedValue({
        stdout: 'worktree /x\nHEAD h\nbranch refs/heads/m\n',
        stderr: '',
      })
      const entries = await manager.list()
      expect(Array.isArray(entries)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // merge()
  // ---------------------------------------------------------------------------
  describe('merge()', () => {
    it('saves current branch, checks out target, merges, restores', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'develop\n', stderr: '' })
        return Promise.resolve({ stdout: 'Fast-forward', stderr: '' })
      })
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(true)
      // Calls: 1) branch --show-current, 2) checkout main, 3) merge feat-x --no-edit, 4) checkout develop
      expect(execFileAsyncMock).toHaveBeenCalledTimes(4)
      expect(allCalls()[0]).toEqual(['branch', '--show-current'])
      expect(allCalls()[1]).toEqual(['checkout', 'main'])
      expect(allCalls()[2]).toEqual(['merge', 'feat-x', '--no-edit'])
      expect(allCalls()[3]).toEqual(['checkout', 'develop'])
    })

    it('trims whitespace from current branch before restoring', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: '   feature/x   \n', stderr: '' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      await manager.merge('feat-x', 'main')
      expect(allCalls()[3]).toEqual(['checkout', 'feature/x'])
    })

    it('detects CONFLICT in stderr and returns success=false', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        if (i === 3)
          return Promise.resolve({
            stdout: '',
            stderr: 'CONFLICT (content): Merge conflict in foo.ts',
          })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(false)
      expect(result.output).toContain('CONFLICT')
    })

    it('detects CONFLICT in stdout and returns success=false', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        if (i === 3) return Promise.resolve({ stdout: 'Auto-merging\nCONFLICT', stderr: '' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(false)
    })

    it('returns success=true on clean merge', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        if (i === 3) return Promise.resolve({ stdout: 'Already up to date.', stderr: '' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(true)
    })

    it('concatenates stdout and stderr in output', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        if (i === 3) return Promise.resolve({ stdout: 'OUT', stderr: 'ERR' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      const result = await manager.merge('feat-x', 'main')
      expect(result.output).toContain('OUT')
      expect(result.output).toContain('ERR')
    })

    it('returns success=false with Error message when exec throws', async () => {
      execFileAsyncMock.mockRejectedValue(new Error('checkout failed: local changes'))
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(false)
      expect(result.output).toContain('checkout failed')
    })

    it('returns success=false with stringified non-Error rejection', async () => {
      execFileAsyncMock.mockRejectedValue('plain string failure')
      const result = await manager.merge('feat-x', 'main')
      expect(result.success).toBe(false)
      expect(result.output).toBe('plain string failure')
    })

    it('uses --no-edit in merge command', async () => {
      let i = 0
      execFileAsyncMock.mockImplementation(() => {
        i += 1
        if (i === 1) return Promise.resolve({ stdout: 'main\n', stderr: '' })
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      await manager.merge('feat-x', 'main')
      expect(allCalls()[2]).toContain('--no-edit')
    })
  })

  // ---------------------------------------------------------------------------
  // exec plumbing (indirect) — cross-cutting assertions
  // ---------------------------------------------------------------------------
  describe('exec plumbing', () => {
    it('every invocation targets the configured repoDir', async () => {
      const m = new GitWorktreeManager({ repoDir: '/custom' })
      await m.create('a')
      await m.list()
      await m.remove('a', false)
      for (let i = 0; i < execFileAsyncMock.mock.calls.length; i++) {
        expect(optsAt(i).cwd).toBe('/custom')
      }
    })

    it('every invocation uses same timeoutMs', async () => {
      const m = new GitWorktreeManager({ repoDir: '/r', timeoutMs: 1_111 })
      await m.create('a')
      await m.list()
      for (let i = 0; i < execFileAsyncMock.mock.calls.length; i++) {
        expect(optsAt(i).timeout).toBe(1_111)
      }
    })

    it('every invocation uses the same maxBuffer', async () => {
      await manager.create('a')
      await manager.list()
      for (let i = 0; i < execFileAsyncMock.mock.calls.length; i++) {
        expect(optsAt(i).maxBuffer).toBe(10 * 1024 * 1024)
      }
    })
  })
})
