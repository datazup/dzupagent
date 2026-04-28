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

import { GitExecutor } from '../git/git-executor.js'

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

describe('GitExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGitSuccess()
  })

  describe('constructor', () => {
    it('uses process.cwd() when no cwd provided', () => {
      const executor = new GitExecutor()
      expect(executor).toBeDefined()
    })

    it('accepts custom configuration', () => {
      const executor = new GitExecutor({
        cwd: '/test/repo',
        allowedRoots: ['/test'],
        timeoutMs: 5000,
        maxBuffer: 1024,
      })
      expect(executor).toBeDefined()
    })

    it('rejects cwd outside configured allowed roots', () => {
      expect(() => new GitExecutor({
        cwd: '/etc',
        allowedRoots: ['/test/repo'],
      })).toThrow('allowed workspace root')
    })

    it('rejects traversal outside configured allowed roots', () => {
      expect(() => new GitExecutor({
        cwd: '/test/repo/../outside',
        allowedRoots: ['/test/repo'],
      })).toThrow('allowed workspace root')
    })

    it('accepts cwd inside configured allowed roots', () => {
      const executor = new GitExecutor({
        cwd: '/test/repo/subdir',
        allowedRoots: ['/test/repo'],
      })
      expect(executor).toBeDefined()
    })
  })

  describe('isGitRepo()', () => {
    it('returns true when inside a git repo', async () => {
      mockGitSuccess('true\n')
      const executor = new GitExecutor({ cwd: '/test/repo' })
      expect(await executor.isGitRepo()).toBe(true)
    })

    it('returns false when not inside a git repo', async () => {
      mockGitFailure(new Error('not a git repository'))
      const executor = new GitExecutor({ cwd: '/tmp/not-repo' })
      expect(await executor.isGitRepo()).toBe(false)
    })
  })

  describe('getRepoRoot()', () => {
    it('returns trimmed repo root path', async () => {
      mockGitSuccess('/home/user/project\n')
      const executor = new GitExecutor({ cwd: '/test/repo' })
      expect(await executor.getRepoRoot()).toBe('/home/user/project')
    })
  })

  describe('getCurrentBranch()', () => {
    it('returns current branch name', async () => {
      mockGitSuccess('feature/auth\n')
      const executor = new GitExecutor({ cwd: '/test/repo' })
      expect(await executor.getCurrentBranch()).toBe('feature/auth')
    })

    it('returns detached HEAD hash when on detached HEAD', async () => {
      mockGitSequence([
        { error: new Error('not on a branch') },
        { stdout: 'abc1234\n' },
      ])
      const executor = new GitExecutor({ cwd: '/test/repo' })
      expect(await executor.getCurrentBranch()).toBe('(detached abc1234)')
    })
  })

  describe('status()', () => {
    it('parses clean status', async () => {
      mockGitSequence([
        { stdout: 'main\n' },
        { stdout: '## main...origin/main\n' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const status = await executor.status()

      expect(status.branch).toBe('main')
      expect(status.clean).toBe(true)
      expect(status.files).toHaveLength(0)
    })

    it('parses branch with upstream and ahead/behind info', async () => {
      mockGitSequence([
        { stdout: 'feature/auth\n' },
        { stdout: '## feature/auth...origin/feature/auth [ahead 3, behind 1]\n' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const status = await executor.status()

      expect(status.branch).toBe('feature/auth')
      expect(status.upstream).toBe('origin/feature/auth')
      expect(status.ahead).toBe(3)
      expect(status.behind).toBe(1)
    })

    it('parses modified, added, deleted, and untracked files', async () => {
      const porcelainOutput = [
        '## main',
        'M  src/service.ts',
        ' M src/utils.ts',
        'A  src/new-file.ts',
        'D  src/old-file.ts',
        '?? untracked.ts',
      ].join('\n')

      mockGitSequence([
        { stdout: 'main\n' },
        { stdout: porcelainOutput + '\n' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const status = await executor.status()

      expect(status.clean).toBe(false)
      expect(status.files.length).toBeGreaterThan(0)

      const staged = status.files.filter((f) => f.staged)
      const unstaged = status.files.filter((f) => !f.staged)

      expect(staged.some((f) => f.path === 'src/service.ts' && f.status === 'modified')).toBe(true)
      expect(staged.some((f) => f.path === 'src/new-file.ts' && f.status === 'added')).toBe(true)
      expect(staged.some((f) => f.path === 'src/old-file.ts' && f.status === 'deleted')).toBe(true)
      expect(unstaged.some((f) => f.path === 'src/utils.ts' && f.status === 'modified')).toBe(true)
      expect(unstaged.some((f) => f.path === 'untracked.ts' && f.status === 'untracked')).toBe(true)
    })

    it('parses renamed files', async () => {
      const porcelainOutput = [
        '## main',
        'R  old-name.ts -> new-name.ts',
      ].join('\n')

      mockGitSequence([
        { stdout: 'main\n' },
        { stdout: porcelainOutput + '\n' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const status = await executor.status()

      const renamed = status.files.find((f) => f.status === 'renamed')
      expect(renamed).toBeDefined()
      expect(renamed!.path).toBe('new-name.ts')
      expect(renamed!.originalPath).toBe('old-name.ts')
    })
  })

  describe('log()', () => {
    it('parses git log entries', async () => {
      const logOutput = [
        'abc123full|abc123|Alice|2024-01-15T10:00:00Z|feat: add auth',
        'def456full|def456|Bob|2024-01-14T09:00:00Z|fix: resolve bug',
      ].join('\n')

      mockGitSuccess(logOutput + '\n')

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const entries = await executor.log(2)

      expect(entries).toHaveLength(2)
      expect(entries[0]!.hash).toBe('abc123full')
      expect(entries[0]!.shortHash).toBe('abc123')
      expect(entries[0]!.author).toBe('Alice')
      expect(entries[0]!.date).toBe('2024-01-15T10:00:00Z')
      expect(entries[0]!.message).toBe('feat: add auth')
    })

    it('handles messages with pipe characters', async () => {
      mockGitSuccess('abc|short|Alice|2024-01-15|message with | pipe\n')

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const entries = await executor.log(1)

      expect(entries[0]!.message).toBe('message with | pipe')
    })

    it('returns empty array for empty log', async () => {
      mockGitSuccess('\n')

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const entries = await executor.log()
      expect(entries).toEqual([])
    })
  })

  describe('diff()', () => {
    it('returns diff output and file stats', async () => {
      mockGitSequence([
        { stdout: ' src/service.ts | 10 ++++---\n 1 file changed, 4 insertions(+), 3 deletions(-)\n' },
        { stdout: 'diff --git a/src/service.ts b/src/service.ts\n...' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const result = await executor.diff()

      expect(result.diff).toContain('diff --git')
      expect(result.insertions).toBe(4)
      expect(result.deletions).toBe(3)
    })

    it('passes --cached for staged diff', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.diff({ staged: true })

      expect(calls.some((c) => c.includes('--cached'))).toBe(true)
    })

    it('passes refs for ref-based diff', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.diff({ ref1: 'HEAD~3', ref2: 'HEAD' })

      expect(calls.some((c) => c.includes('HEAD~3') && c.includes('HEAD'))).toBe(true)
    })
  })

  describe('add()', () => {
    it('does nothing for empty paths array', async () => {
      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.add([])
      expect(execFileAsyncMock).not.toHaveBeenCalled()
    })

    it('stages specified files', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.add(['src/a.ts', 'src/b.ts'])

      expect(calls[0]).toContain('add')
      expect(calls[0]).toContain('src/a.ts')
      expect(calls[0]).toContain('src/b.ts')
    })
  })

  describe('addAll()', () => {
    it('stages all changes with -A flag', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.addAll()

      expect(calls[0]).toContain('add')
      expect(calls[0]).toContain('-A')
    })
  })

  describe('commit()', () => {
    it('creates a commit and returns result', async () => {
      mockGitSequence([
        { stdout: '' },
        { stdout: 'abc123hash|feat: add auth module\n' },
        { stdout: '3 files changed, 100 insertions(+), 20 deletions(-)\n' },
      ])

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const result = await executor.commit('feat: add auth module')

      expect(result.hash).toBe('abc123hash')
      expect(result.message).toBe('feat: add auth module')
      expect(result.filesChanged).toBe(3)
    })
  })

  describe('createBranch()', () => {
    it('creates branch with checkout -b', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.createBranch('feature/new')

      expect(calls[0]).toEqual(['checkout', '-b', 'feature/new'])
    })

    it('accepts a start point', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.createBranch('feature/new', 'develop')

      expect(calls[0]).toEqual(['checkout', '-b', 'feature/new', 'develop'])
    })
  })

  describe('switchBranch()', () => {
    it('checks out the specified branch', async () => {
      const calls: string[][] = []
      execFileAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
        calls.push(args)
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      const executor = new GitExecutor({ cwd: '/test/repo' })
      await executor.switchBranch('develop')

      expect(calls[0]).toEqual(['checkout', 'develop'])
    })
  })

  describe('listBranches()', () => {
    it('parses branch list with current indicator', async () => {
      mockGitSuccess('main|*\nfeature/auth|\ndevelop|\n')

      const executor = new GitExecutor({ cwd: '/test/repo' })
      const branches = await executor.listBranches()

      expect(branches).toHaveLength(3)
      expect(branches[0]!.name).toBe('main')
      expect(branches[0]!.current).toBe(true)
      expect(branches[1]!.name).toBe('feature/auth')
      expect(branches[1]!.current).toBe(false)
    })
  })

  describe('headHash()', () => {
    it('returns short HEAD hash', async () => {
      mockGitSuccess('abc1234\n')
      const executor = new GitExecutor({ cwd: '/test/repo' })
      expect(await executor.headHash()).toBe('abc1234')
    })
  })
})
