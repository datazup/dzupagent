import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mock so vi.mock factories can see it.
const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}))

import { GitExecutor } from '../git-executor.js'
import { InvalidGitRefError } from '../ref-validator.js'

describe('GitExecutor — ref validation (SEC-11/12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('createBranch("--evil", "main") throws BEFORE spawning git', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await expect(exec.createBranch('--evil', 'main')).rejects.toBeInstanceOf(
      InvalidGitRefError,
    )
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('createBranch validates the startPoint argument', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await expect(
      exec.createBranch('feature/ok', '--upload-pack=/tmp/x.sh'),
    ).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('createBranch with a valid ref inserts --end-of-options before positionals', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.createBranch('feature/foo-bar', 'main')
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    const args = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(args).toEqual([
      'checkout',
      '-b',
      '--end-of-options',
      'feature/foo-bar',
      'main',
    ])
  })

  it('createBranch without startPoint omits the trailing positional', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.createBranch('feature/no-start')
    const args = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(args).toEqual(['checkout', '-b', '--end-of-options', 'feature/no-start'])
  })

  it('switchBranch("--evil") throws before spawning git', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await expect(exec.switchBranch('--evil')).rejects.toBeInstanceOf(
      InvalidGitRefError,
    )
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('switchBranch with a valid ref inserts --end-of-options', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.switchBranch('main')
    const args = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(args).toEqual(['checkout', '--end-of-options', 'main'])
  })

  it('commit message that looks like a flag is still accepted (passed via -m value)', async () => {
    // Sequence: commit, log, diff --stat
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc|the message', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' 1 file changed', stderr: '' })

    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.commit('--this-looks-like-a-flag')
    const args = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(args).toEqual(['commit', '-m', '--this-looks-like-a-flag'])
  })
})

describe('GitExecutor.diff — ref validation (SEC-C-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('rejects a ref1 that begins with -- BEFORE spawning git', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await expect(
      exec.diff({ ref1: '--output=/home/user/.ssh/authorized_keys' }),
    ).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('validates ref2 as well as ref1', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await expect(
      exec.diff({ ref1: 'main', ref2: '--upload-pack=/tmp/x.sh' }),
    ).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects refs carrying shell or option metacharacters', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    for (const ref of ['foo;rm -rf /', 'foo bar', 'foo^', 'foo..bar', '-c']) {
      await expect(exec.diff({ ref1: ref })).rejects.toBeInstanceOf(
        InvalidGitRefError,
      )
    }
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('inserts --end-of-options AFTER --stat so the stat flag stays a flag', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.diff({ ref1: 'main', ref2: 'feature/foo' })
    const statArgs = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    const diffArgs = execFileAsyncMock.mock.calls[1]?.[1] as string[]
    expect(statArgs).toEqual([
      'diff',
      '--stat',
      '--end-of-options',
      'main',
      'feature/foo',
    ])
    expect(diffArgs).toEqual([
      'diff',
      '--end-of-options',
      'main',
      'feature/foo',
    ])
  })

  it('keeps pathspecs after the -- separator', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.diff({ ref1: 'main', paths: ['src/a.ts'] })
    const diffArgs = execFileAsyncMock.mock.calls[1]?.[1] as string[]
    expect(diffArgs).toEqual([
      'diff',
      '--end-of-options',
      'main',
      '--',
      'src/a.ts',
    ])
  })

  it('leaves the staged path unchanged', async () => {
    const exec = new GitExecutor({ cwd: '/tmp/repo' })
    await exec.diff({ staged: true })
    const statArgs = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(statArgs).toEqual(['diff', '--cached', '--stat'])
  })
})
