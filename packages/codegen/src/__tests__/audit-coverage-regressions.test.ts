import { test, expect, vi } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withContainedFile } from '../sandbox/contained-file.js'
import { handleGitToolError } from '../git/git-errors.js'

test('configured root ancestors cannot redirect staging through a symlink', async () => {
  const base = await mkdtemp(join(tmpdir(), 'root-containment-'))
  try {
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'victim'), 'original')
    await symlink(join(base, 'outside'), join(base, 'alias'))
    await expect(withContainedFile(join(base, 'alias', 'nested'), join(base, 'alias', 'nested', 'file'), true, constants.O_CREAT | constants.O_WRONLY, async file => file.writeFile('bad'))).rejects.toThrow(/symlink/)
    expect(await readFile(join(base, 'outside', 'victim'), 'utf8')).toBe('original')
    await expect(readFile(join(base, 'outside', 'nested', 'file'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(withContainedFile(base, join(base, '..', 'escape'), true, constants.O_CREAT | constants.O_WRONLY, async () => undefined)).rejects.toThrow(/traversal/)
    await expect(withContainedFile(base, base, false, constants.O_RDONLY, async () => undefined)).rejects.toThrow(/traversal/)
    await expect(withContainedFile(base, join(base, 'outside'), false, constants.O_RDONLY, async () => undefined)).rejects.toThrow(/regular file/)
  } finally { await rm(base, { recursive: true, force: true }) }
})
test('git failures classify alternate diagnostics without exposing raw output to callers', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cases: Array<[string, string]> = [['not a git repository', 'not_a_repo'], ['pre-commit', 'hook_failed'], ['pre-push', 'hook_failed'], ['hook', 'hook_failed'], ['husky', 'hook_failed'], ['merge conflict', 'merge_conflict'], ['conflict', 'merge_conflict'], ['unmerged', 'merge_conflict'], ['authentication', 'auth_failed'], ['permission denied', 'auth_failed'], ['could not read from remote', 'auth_failed'], ['access denied', 'auth_failed'], ['already exists', 'ref_error'], ['not a valid', 'ref_error'], ['did not match any', 'ref_error'], ['unknown revision', 'ref_error'], ['pathspec', 'ref_error'], ['timed out', 'timeout'], ['etimedout', 'timeout'], ['nothing to commit', 'nothing_to_commit'], ['no changes added', 'nothing_to_commit'], ['unexpected', 'git_command_failed']]
    for (const [message, category] of cases) {
      expect(handleGitToolError('fixture', message + ' PRIVATE_MARKER')).not.toContain('PRIVATE_MARKER')
      expect(JSON.parse(String(log.mock.calls.at(-1)![0])).category).toBe(category)
    }
  } finally { log.mockRestore() }
})
