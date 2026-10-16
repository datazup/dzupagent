import { test, expect, vi } from 'vitest'
import { handleGitToolError } from '../git/git-errors.js'

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
