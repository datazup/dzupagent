/**
 * Atomic-rollback tests for DiskWorkspaceFS.applyPatch (E1-T10).
 *
 * Contract under test:
 *   When a multi-hunk patch is partially successful, the workspace
 *   state MUST be rolled back to the pre-apply snapshot and the returned
 *   WorkspacePatchResult must carry `rolledBack: true`.
 *
 * Note: `parseUnifiedDiff` uses a count-based hunk-body reader (driven by
 * the @@ header's oldCount/newCount), so multi-file diffs parse correctly.
 * The single-file 3-hunk fixture here still exercises the rollback
 * guarantee end-to-end; multi-file parser behavior is covered separately
 * in `patch-engine.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskWorkspaceFS, InMemoryWorkspaceFS } from '../vfs/workspace-fs.js'
import { VirtualFS } from '../vfs/virtual-fs.js'

describe('DiskWorkspaceFS.applyPatch atomic rollback', () => {
  let tmpRoot: string
  let ws: DiskWorkspaceFS

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'atomic-apply-test-'))
    ws = new DiskWorkspaceFS(tmpRoot)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('rolls back the file when a middle hunk in a 3-hunk diff has a context mismatch', async () => {
    // Fixture: one file with 9 known lines. We target 3 separate regions
    // across the file with 3 hunks; the middle hunk will not match.
    const originalLines = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
    ]
    const original = originalLines.join('\n')
    await writeFile(join(tmpRoot, 'target.txt'), original, 'utf-8')

    // Also create a bystander file we expect to remain untouched.
    const bystanderOriginal = 'bystander content\nunchanged\n'
    await writeFile(join(tmpRoot, 'bystander.txt'), bystanderOriginal, 'utf-8')

    // 3 hunks against target.txt:
    //   hunk 0: rewrite line 1        (valid — will apply)
    //   hunk 1: rewrite around line 5 with a WRONG context line (will fail)
    //   hunk 2: rewrite line 9        (valid — would apply)
    const patch = [
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -1,1 +1,1 @@',
      '-line 1',
      '+line 1 MODIFIED',
      '@@ -4,3 +4,3 @@',
      ' line 4',
      '-NOT THE REAL LINE 5',
      '+line 5 MODIFIED',
      ' line 6',
      '@@ -9,1 +9,1 @@',
      '-line 9',
      '+line 9 MODIFIED',
    ].join('\n')

    const result = await ws.applyPatch(patch)

    // (A) Rollback occurred.
    expect(result.rolledBack).toBe(true)

    // (B) The file content is restored to its pre-apply state.
    const targetAfter = await readFile(join(tmpRoot, 'target.txt'), 'utf-8')
    expect(targetAfter).toBe(original)

    // (C) Bystander file untouched (sanity check — we never wrote to it).
    const bystanderAfter = await readFile(join(tmpRoot, 'bystander.txt'), 'utf-8')
    expect(bystanderAfter).toBe(bystanderOriginal)

    // (D) The failing hunk is identified and its index is 1 (0-based middle).
    expect(result.results).toHaveLength(1)
    const fileResult = result.results[0]!
    expect(fileResult.success).toBe(false)
    expect(fileResult.filePath).toBe('target.txt')

    const failingHunk = fileResult.hunkResults.find(
      (h) => !h.applied && h.error !== 'E_ALREADY_APPLIED',
    )
    expect(failingHunk).toBeDefined()
    expect(failingHunk!.hunkIndex).toBe(1)
    expect(failingHunk!.error).toBe('E_CONTEXT_MISMATCH')
  })

  it('rolls back ALL files when a second-file patch fails in a multi-file diff', async () => {
    // Regression for the parseUnifiedDiff greedy-consumption bug: prior
    // to the count-based fix, a 2-file diff collapsed into a single
    // FilePatch, so this scenario could not even be expressed. Now it
    // parses as 2 patches, and a failure in the second file must roll
    // back the successfully-applied first file.
    await writeFile(join(tmpRoot, 'one.txt'), 'one-original\n', 'utf-8')
    await writeFile(join(tmpRoot, 'two.txt'), 'two-original\n', 'utf-8')

    const patch = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-one-original',
      '+one-modified',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-NOT THE REAL LINE',
      '+two-modified',
    ].join('\n')

    const result = await ws.applyPatch(patch)
    expect(result.rolledBack).toBe(true)
    expect(result.results).toHaveLength(2)

    // Both files should be restored to their pre-apply state.
    const oneAfter = await readFile(join(tmpRoot, 'one.txt'), 'utf-8')
    const twoAfter = await readFile(join(tmpRoot, 'two.txt'), 'utf-8')
    expect(oneAfter).toBe('one-original\n')
    expect(twoAfter).toBe('two-original\n')
  })

  it('does not rollback when the entire patch succeeds', async () => {
    const original = 'hello\nworld\n'
    await writeFile(join(tmpRoot, 'ok.txt'), original, 'utf-8')

    const patch = [
      '--- a/ok.txt',
      '+++ b/ok.txt',
      '@@ -1,2 +1,2 @@',
      '-hello',
      '+HELLO',
      ' world',
    ].join('\n')

    const result = await ws.applyPatch(patch)
    expect(result.rolledBack).toBe(false)
    const after = await readFile(join(tmpRoot, 'ok.txt'), 'utf-8')
    expect(after).toBe('HELLO\nworld\n')
  })
})

describe('InMemoryWorkspaceFS.applyPatch — multi-file patch', () => {
  it('applies a 3-file unified diff atomically end-to-end', async () => {
    const fileAOriginal = 'alpha-original\n'
    const fileBOriginal = 'beta-original\n'
    const fileCOriginal = 'gamma-original\n'
    const vfs = new VirtualFS({
      'fileA.txt': fileAOriginal,
      'fileB.ts': fileBOriginal,
      'fileC.md': fileCOriginal,
    })
    const ws = new InMemoryWorkspaceFS(vfs)

    const patch = [
      '--- a/fileA.txt',
      '+++ b/fileA.txt',
      '@@ -1,1 +1,1 @@',
      '-alpha-original',
      '+alpha-modified',
      '--- a/fileB.ts',
      '+++ b/fileB.ts',
      '@@ -1,1 +1,1 @@',
      '-beta-original',
      '+beta-modified',
      '--- a/fileC.md',
      '+++ b/fileC.md',
      '@@ -1,1 +1,1 @@',
      '-gamma-original',
      '+gamma-modified',
    ].join('\n')

    const result = await ws.applyPatch(patch, { rollbackOnFailure: true })

    expect(result.rolledBack).toBe(false)
    expect(result.results).toHaveLength(3)
    for (const fileResult of result.results) {
      expect(fileResult.success).toBe(true)
    }

    expect(await ws.read('fileA.txt')).toBe('alpha-modified\n')
    expect(await ws.read('fileB.ts')).toBe('beta-modified\n')
    expect(await ws.read('fileC.md')).toBe('gamma-modified\n')
  })

  it('rolls back all 3 files when the second file patch fails', async () => {
    const fileAOriginal = 'alpha-original\n'
    const fileBOriginal = 'beta-original\n'
    const fileCOriginal = 'gamma-original\n'
    const vfs = new VirtualFS({
      'fileA.txt': fileAOriginal,
      'fileB.ts': fileBOriginal,
      'fileC.md': fileCOriginal,
    })
    const ws = new InMemoryWorkspaceFS(vfs)

    // fileB has a wrong-context line so its hunk will fail to apply.
    const patch = [
      '--- a/fileA.txt',
      '+++ b/fileA.txt',
      '@@ -1,1 +1,1 @@',
      '-alpha-original',
      '+alpha-modified',
      '--- a/fileB.ts',
      '+++ b/fileB.ts',
      '@@ -1,1 +1,1 @@',
      '-NOT THE REAL LINE',
      '+beta-modified',
      '--- a/fileC.md',
      '+++ b/fileC.md',
      '@@ -1,1 +1,1 @@',
      '-gamma-original',
      '+gamma-modified',
    ].join('\n')

    const result = await ws.applyPatch(patch, { rollbackOnFailure: true })

    expect(result.rolledBack).toBe(true)

    // All three files must be restored to their original contents.
    expect(await ws.read('fileA.txt')).toBe(fileAOriginal)
    expect(await ws.read('fileB.ts')).toBe(fileBOriginal)
    expect(await ws.read('fileC.md')).toBe(fileCOriginal)
  })
})
