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

import { GitWorktreeManager } from '../git-worktree.js'
import { InvalidGitRefError } from '../ref-validator.js'

describe('GitWorktreeManager — ref validation (SEC-11/12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('create("--evil") throws BEFORE spawning git', async () => {
    const wt = new GitWorktreeManager({ repoDir: '/tmp/repo' })
    await expect(wt.create('--evil')).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('create validates baseBranch argument too', async () => {
    const wt = new GitWorktreeManager({ repoDir: '/tmp/repo' })
    await expect(
      wt.create('feature/ok', '--upload-pack=/tmp/x.sh'),
    ).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('create with valid refs inserts --end-of-options before positionals', async () => {
    const wt = new GitWorktreeManager({
      repoDir: '/tmp/repo',
      worktreeBaseDir: '/tmp/worktrees',
    })
    await wt.create('feature/foo-bar', 'main')
    const args = execFileAsyncMock.mock.calls[0]?.[1] as string[]
    expect(args).toEqual([
      'worktree',
      'add',
      '-b',
      'feature/foo-bar',
      '--end-of-options',
      '/tmp/worktrees/feature/foo-bar',
      'main',
    ])
  })

  it('merge throws before any git invocation when worktreeBranch is flag-shaped', async () => {
    const wt = new GitWorktreeManager({ repoDir: '/tmp/repo' })
    // Validation happens before the try/catch, so it bubbles out as a rejection.
    await expect(wt.merge('--evil', 'main')).rejects.toBeInstanceOf(InvalidGitRefError)
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('merge throws before any git invocation when targetBranch is flag-shaped', async () => {
    const wt = new GitWorktreeManager({ repoDir: '/tmp/repo' })
    await expect(wt.merge('feature/ok', '--upload-pack=x')).rejects.toBeInstanceOf(
      InvalidGitRefError,
    )
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('merge with valid refs uses --end-of-options on every checkout/merge', async () => {
    // Sequence: branch --show-current, checkout target, merge, checkout previous
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'previous-branch\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Merge made', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const wt = new GitWorktreeManager({ repoDir: '/tmp/repo' })
    const result = await wt.merge('feature/foo', 'main')
    expect(result.success).toBe(true)

    const calls = execFileAsyncMock.mock.calls.map((c) => c[1] as string[])
    expect(calls[0]).toEqual(['branch', '--show-current'])
    expect(calls[1]).toEqual(['checkout', '--end-of-options', 'main'])
    expect(calls[2]).toEqual(['merge', '--no-edit', '--end-of-options', 'feature/foo'])
    expect(calls[3]).toEqual(['checkout', '--end-of-options', 'previous-branch'])
  })
})
