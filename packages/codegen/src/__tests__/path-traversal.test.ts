/**
 * Path traversal security tests for DiskWorkspaceFS.applyPatch.
 *
 * These tests are AUTHORED IN THE FAILING STATE by design.
 * A later agent (E1-T9 / E1-T10) will implement the path guard
 * inside DiskWorkspaceFS.applyPatch and the tests will pass.
 *
 * Contract under test:
 *   - Unified diffs whose target file paths resolve OUTSIDE the
 *     workspace root must cause applyPatch to throw PathSecurityError.
 *   - Diffs targeting files inside the workspace must NOT throw
 *     PathSecurityError (they may return success: false if the file
 *     does not exist, but the security guard must be satisfied).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskWorkspaceFS } from '../vfs/workspace-fs.js'
import { PathSecurityError } from '../vfs/path-security-error.js'

describe('DiskWorkspaceFS.applyPatch path traversal guard', () => {
  let tmpRoot: string
  let ws: DiskWorkspaceFS

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'path-traversal-test-'))
    ws = new DiskWorkspaceFS(tmpRoot)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('throws PathSecurityError for a diff targeting ../../etc/passwd', async () => {
    const patch = [
      '--- a/../../etc/passwd',
      '+++ b/../../etc/passwd',
      '@@ -0,0 +1 @@',
      '+pwned',
    ].join('\n')

    await expect(ws.applyPatch(patch)).rejects.toBeInstanceOf(PathSecurityError)
  })

  it('throws PathSecurityError for a diff targeting ../sibling-dir/file.ts', async () => {
    const patch = [
      '--- a/../sibling-dir/file.ts',
      '+++ b/../sibling-dir/file.ts',
      '@@ -0,0 +1 @@',
      '+export const leaked = true',
    ].join('\n')

    await expect(ws.applyPatch(patch)).rejects.toBeInstanceOf(PathSecurityError)
  })

  it('does NOT throw PathSecurityError for a diff targeting src/valid-file.ts within the workspace', async () => {
    const patch = [
      '--- a/src/valid-file.ts',
      '+++ b/src/valid-file.ts',
      '@@ -0,0 +1 @@',
      '+export const ok = true',
    ].join('\n')

    // The file does not exist yet, so applyPatch may return a result with
    // success: false (hunk mismatch / missing source). What it MUST NOT do
    // is throw PathSecurityError — the path is safely inside the workspace.
    let thrown: unknown = null
    try {
      await ws.applyPatch(patch)
    } catch (err) {
      thrown = err
    }

    expect(thrown).not.toBeInstanceOf(PathSecurityError)
  })
})
