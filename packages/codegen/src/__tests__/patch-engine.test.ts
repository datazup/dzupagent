import { describe, it, expect, vi } from 'vitest'
import {
  parseUnifiedDiff,
  applyPatch,
  applyPatchSet,
  PatchParseError,
  type FilePatch,
} from '../vfs/patch-engine.js'
import { InMemoryWorkspaceFS } from '../vfs/workspace-fs.js'
import { VirtualFS } from '../vfs/virtual-fs.js'

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff', () => {
  it('parses a simple single-hunk diff', () => {
    const diff = [
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2_modified',
      ' line3',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.oldPath).toBe('src/index.ts')
    expect(patches[0]!.newPath).toBe('src/index.ts')
    expect(patches[0]!.hunks).toHaveLength(1)

    const hunk = patches[0]!.hunks[0]!
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldCount).toBe(3)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newCount).toBe(3)
    expect(hunk.lines).toEqual([
      { type: 'context', content: 'line1' },
      { type: 'remove', content: 'line2' },
      { type: 'add', content: 'line2_modified' },
      { type: 'context', content: 'line3' },
    ])
  })

  it('parses multi-hunk diff', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,3 +10,4 @@',
      ' x',
      ' y',
      '+z_new',
      ' z',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.hunks).toHaveLength(2)
    expect(patches[0]!.hunks[0]!.oldStart).toBe(1)
    expect(patches[0]!.hunks[1]!.oldStart).toBe(10)
    expect(patches[0]!.hunks[1]!.newCount).toBe(4)
  })

  it('parses multi-file diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1234567..abcdefg 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old_a',
      '+new_a',
      ' keep',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,2 +1,2 @@',
      '-old_b',
      '+new_b',
      ' keep',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(2)
    expect(patches[0]!.oldPath).toBe('a.ts')
    expect(patches[1]!.oldPath).toBe('b.ts')
  })

  it('parses add-only hunks (new file)', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/new-file.ts',
      '@@ -0,0 +1,3 @@',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.oldPath).toBe('/dev/null')
    expect(patches[0]!.newPath).toBe('new-file.ts')
    const hunk = patches[0]!.hunks[0]!
    expect(hunk.oldCount).toBe(0)
    expect(hunk.newCount).toBe(3)
    expect(hunk.lines.every((l) => l.type === 'add')).toBe(true)
  })

  it('parses remove-only hunks (deleted file)', () => {
    const diff = [
      '--- a/old-file.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-line1',
      '-line2',
      '-line3',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.newPath).toBe('/dev/null')
    const hunk = patches[0]!.hunks[0]!
    expect(hunk.newCount).toBe(0)
    expect(hunk.lines.every((l) => l.type === 'remove')).toBe(true)
  })

  it('handles missing newline at end of file marker', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    const hunk = patches[0]!.hunks[0]!
    // The "\ No newline..." lines should be skipped
    expect(hunk.lines).toEqual([
      { type: 'remove', content: 'old' },
      { type: 'add', content: 'new' },
    ])
  })

  it('returns E_PARSE for malformed input', () => {
    expect(() => parseUnifiedDiff('this is not a diff')).toThrow(PatchParseError)
  })

  it('throws PatchParseError when +++ is missing after ---', () => {
    const diff = '--- a/file.ts\nnot a plus line'
    expect(() => parseUnifiedDiff(diff)).toThrow(PatchParseError)
    expect(() => parseUnifiedDiff(diff)).toThrow('Expected +++ line')
  })

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('  ')).toEqual([])
  })

  it('parses hunk header with single-line counts (no comma)', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    const hunk = patches[0]!.hunks[0]!
    expect(hunk.oldStart).toBe(5)
    expect(hunk.oldCount).toBe(1)
    expect(hunk.newStart).toBe(5)
    expect(hunk.newCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Multi-file regression tests (parseUnifiedDiff greedy-consumption bug)
  // -------------------------------------------------------------------------

  it('regression: single-file diff still works after multi-file fix', () => {
    // Ensures the hunk-count-based body parser does not regress the
    // original single-file path.
    const diff = [
      '--- a/src/only.ts',
      '+++ b/src/only.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-second',
      '+SECOND',
      ' third',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.oldPath).toBe('src/only.ts')
    expect(patches[0]!.hunks).toHaveLength(1)
    expect(patches[0]!.hunks[0]!.lines).toEqual([
      { type: 'context', content: 'first' },
      { type: 'remove', content: 'second' },
      { type: 'add', content: 'SECOND' },
      { type: 'context', content: 'third' },
    ])
  })

  it('parses two-file diff WITHOUT diff --git separator', () => {
    // This is the exact bug scenario: two `--- a/...` file headers
    // back-to-back with no `diff --git` marker. Prior to the fix, the
    // hunk body loop would swallow `--- a/second.ts` and `+++ b/second.ts`
    // as remove/add lines, collapsing the diff into a single file.
    const diff = [
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1,2 +1,2 @@',
      '-first_old',
      '+first_new',
      ' keep',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1,2 +1,2 @@',
      '-second_old',
      '+second_new',
      ' keep',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(2)

    expect(patches[0]!.oldPath).toBe('first.ts')
    expect(patches[0]!.newPath).toBe('first.ts')
    expect(patches[0]!.hunks).toHaveLength(1)
    expect(patches[0]!.hunks[0]!.lines).toEqual([
      { type: 'remove', content: 'first_old' },
      { type: 'add', content: 'first_new' },
      { type: 'context', content: 'keep' },
    ])

    expect(patches[1]!.oldPath).toBe('second.ts')
    expect(patches[1]!.newPath).toBe('second.ts')
    expect(patches[1]!.hunks).toHaveLength(1)
    expect(patches[1]!.hunks[0]!.lines).toEqual([
      { type: 'remove', content: 'second_old' },
      { type: 'add', content: 'second_new' },
      { type: 'context', content: 'keep' },
    ])
  })

  it('parses three-file diff with mixed add/modify/delete', () => {
    const diff = [
      // File 1: modify
      '--- a/modify.ts',
      '+++ b/modify.ts',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      // File 2: add (new file)
      '--- /dev/null',
      '+++ b/created.ts',
      '@@ -0,0 +1,2 @@',
      '+brand_new_1',
      '+brand_new_2',
      // File 3: delete
      '--- a/removed.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone_1',
      '-gone_2',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(3)

    // File 1: modify
    expect(patches[0]!.oldPath).toBe('modify.ts')
    expect(patches[0]!.newPath).toBe('modify.ts')
    expect(patches[0]!.hunks).toHaveLength(1)
    expect(patches[0]!.hunks[0]!.lines).toEqual([
      { type: 'context', content: 'alpha' },
      { type: 'remove', content: 'beta' },
      { type: 'add', content: 'BETA' },
      { type: 'context', content: 'gamma' },
    ])

    // File 2: add
    expect(patches[1]!.oldPath).toBe('/dev/null')
    expect(patches[1]!.newPath).toBe('created.ts')
    expect(patches[1]!.hunks).toHaveLength(1)
    expect(patches[1]!.hunks[0]!.oldCount).toBe(0)
    expect(patches[1]!.hunks[0]!.newCount).toBe(2)
    expect(patches[1]!.hunks[0]!.lines).toEqual([
      { type: 'add', content: 'brand_new_1' },
      { type: 'add', content: 'brand_new_2' },
    ])

    // File 3: delete
    expect(patches[2]!.oldPath).toBe('removed.ts')
    expect(patches[2]!.newPath).toBe('/dev/null')
    expect(patches[2]!.hunks).toHaveLength(1)
    expect(patches[2]!.hunks[0]!.oldCount).toBe(2)
    expect(patches[2]!.hunks[0]!.newCount).toBe(0)
    expect(patches[2]!.hunks[0]!.lines).toEqual([
      { type: 'remove', content: 'gone_1' },
      { type: 'remove', content: 'gone_2' },
    ])
  })

  it('empty diff edge case returns an empty array (no throw)', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('\n')).toEqual([])
    expect(parseUnifiedDiff('   \n  \n')).toEqual([])
  })

  it('parses two-file diff with multiple hunks per file (boundary stress test)', () => {
    // Each file has two hunks; the bug class manifests at the boundary
    // between the last hunk of file 1 and the `--- a/second.ts` of file 2.
    const diff = [
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1,2 +1,2 @@',
      '-a1',
      '+A1',
      ' a2',
      '@@ -10,2 +10,2 @@',
      '-a10',
      '+A10',
      ' a11',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1,2 +1,2 @@',
      '-b1',
      '+B1',
      ' b2',
      '@@ -20,2 +20,2 @@',
      '-b20',
      '+B20',
      ' b21',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(2)
    expect(patches[0]!.oldPath).toBe('first.ts')
    expect(patches[0]!.hunks).toHaveLength(2)
    expect(patches[1]!.oldPath).toBe('second.ts')
    expect(patches[1]!.hunks).toHaveLength(2)

    // Sanity-check that no header line was swallowed into a hunk body.
    for (const p of patches) {
      for (const h of p.hunks) {
        for (const l of h.lines) {
          expect(l.content.startsWith('-- a/')).toBe(false)
          expect(l.content.startsWith('++ b/')).toBe(false)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

describe('applyPatch', () => {
  it('applies a simple replacement hunk', () => {
    const content = 'line1\nline2\nline3'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: 'context', content: 'line1' },
            { type: 'remove', content: 'line2' },
            { type: 'add', content: 'LINE2' },
            { type: 'context', content: 'line3' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.content).toBe('line1\nLINE2\nline3')
    expect(result.hunkResults).toHaveLength(1)
    expect(result.hunkResults[0]!.applied).toBe(true)
    expect(result.hunkResults[0]!.appliedAtLine).toBe(1)
  })

  it('applies add-only hunk', () => {
    const content = 'line1\nline2'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 4,
          lines: [
            { type: 'context', content: 'line1' },
            { type: 'add', content: 'new1' },
            { type: 'add', content: 'new2' },
            { type: 'context', content: 'line2' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.content).toBe('line1\nnew1\nnew2\nline2')
  })

  it('applies remove-only hunk', () => {
    const content = 'line1\nline2\nline3\nline4'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 1,
          oldCount: 4,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: 'context', content: 'line1' },
            { type: 'remove', content: 'line2' },
            { type: 'remove', content: 'line3' },
            { type: 'context', content: 'line4' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.content).toBe('line1\nline4')
  })

  it('applies multiple hunks with line offset tracking', () => {
    // 12 lines of content
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`)
    const content = lines.join('\n')

    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          // First hunk: replace line2 (adds 1 extra line, net +1)
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 4,
          lines: [
            { type: 'context', content: 'line1' },
            { type: 'remove', content: 'line2' },
            { type: 'add', content: 'line2a' },
            { type: 'add', content: 'line2b' },
            { type: 'context', content: 'line3' },
          ],
        },
        {
          // Second hunk at line 10: should account for +1 offset
          oldStart: 10,
          oldCount: 3,
          newStart: 11,
          newCount: 3,
          lines: [
            { type: 'context', content: 'line10' },
            { type: 'remove', content: 'line11' },
            { type: 'add', content: 'LINE11' },
            { type: 'context', content: 'line12' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.hunkResults).toHaveLength(2)
    expect(result.hunkResults[0]!.applied).toBe(true)
    expect(result.hunkResults[1]!.applied).toBe(true)

    const resultLines = result.content!.split('\n')
    expect(resultLines[1]).toBe('line2a')
    expect(resultLines[2]).toBe('line2b')
    // line11 should be replaced
    expect(resultLines).toContain('LINE11')
    expect(resultLines).not.toContain('line11')
  })

  it('reports E_CONTEXT_MISMATCH when context lines differ', () => {
    const content = 'alpha\nbeta\ngamma'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: 'context', content: 'WRONG_CONTEXT' },
            { type: 'remove', content: 'beta' },
            { type: 'add', content: 'BETA' },
            { type: 'context', content: 'gamma' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(false)
    expect(result.hunkResults[0]!.applied).toBe(false)
    expect(result.hunkResults[0]!.error).toBe('E_CONTEXT_MISMATCH')
  })

  it('reports E_ALREADY_APPLIED when content already matches', () => {
    // Content already has the "after" state
    const content = 'line1\nLINE2\nline3'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: 'context', content: 'line1' },
            { type: 'remove', content: 'line2' },
            { type: 'add', content: 'LINE2' },
            { type: 'context', content: 'line3' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    // Not a failure — just already applied
    expect(result.hunkResults[0]!.applied).toBe(false)
    expect(result.hunkResults[0]!.error).toBe('E_ALREADY_APPLIED')
  })

  it('fuzzy matches hunks within +/-3 lines', () => {
    // Content has 2 extra lines at the beginning compared to what the hunk expects
    const content = 'extra1\nextra2\nalpha\nbeta\ngamma'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          // Hunk says it starts at line 1, but actual content is at line 3
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: 'context', content: 'alpha' },
            { type: 'remove', content: 'beta' },
            { type: 'add', content: 'BETA' },
            { type: 'context', content: 'gamma' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.hunkResults[0]!.applied).toBe(true)
    // Applied at line 3 (1-based), 2 lines later than expected
    expect(result.hunkResults[0]!.appliedAtLine).toBe(3)
    expect(result.content).toBe('extra1\nextra2\nalpha\nBETA\ngamma')
  })

  it('preserves unmodified content', () => {
    const content = 'line1\nline2\nline3\nline4\nline5'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 2,
          oldCount: 3,
          newStart: 2,
          newCount: 3,
          lines: [
            { type: 'context', content: 'line2' },
            { type: 'remove', content: 'line3' },
            { type: 'add', content: 'LINE3' },
            { type: 'context', content: 'line4' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    const resultLines = result.content!.split('\n')
    expect(resultLines[0]).toBe('line1')   // before hunk
    expect(resultLines[4]).toBe('line5')   // after hunk
    expect(resultLines[2]).toBe('LINE3')   // modified
  })

  it('handles hunk at end of file', () => {
    const content = 'line1\nline2\nline3'
    const patch: FilePatch = {
      oldPath: 'file.ts',
      newPath: 'file.ts',
      hunks: [
        {
          oldStart: 2,
          oldCount: 2,
          newStart: 2,
          newCount: 2,
          lines: [
            { type: 'context', content: 'line2' },
            { type: 'remove', content: 'line3' },
            { type: 'add', content: 'LINE3' },
          ],
        },
      ],
    }

    const result = applyPatch(content, patch)
    expect(result.success).toBe(true)
    expect(result.content).toBe('line1\nline2\nLINE3')
  })
})

// ---------------------------------------------------------------------------
// applyPatchSet
// ---------------------------------------------------------------------------

describe('applyPatchSet', () => {
  it('applies patches to multiple files', async () => {
    const files = new Map<string, string>([
      ['a.ts', 'aaa\nbbb'],
      ['b.ts', 'xxx\nyyy'],
    ])

    const patches: FilePatch[] = [
      {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'remove', content: 'aaa' },
              { type: 'add', content: 'AAA' },
              { type: 'context', content: 'bbb' },
            ],
          },
        ],
      },
      {
        oldPath: 'b.ts',
        newPath: 'b.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'context', content: 'xxx' },
              { type: 'remove', content: 'yyy' },
              { type: 'add', content: 'YYY' },
            ],
          },
        ],
      },
    ]

    const readFile = vi.fn(async (path: string) => files.get(path) ?? null)
    const writeFile = vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    })

    const { results, rolledBack } = await applyPatchSet(patches, readFile, writeFile)
    expect(rolledBack).toBe(false)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.success)).toBe(true)
    expect(files.get('a.ts')).toBe('AAA\nbbb')
    expect(files.get('b.ts')).toBe('xxx\nYYY')
  })

  it('rolls back all changes on failure when rollbackOnFailure is true', async () => {
    const files = new Map<string, string>([
      ['a.ts', 'aaa\nbbb'],
      ['b.ts', 'xxx\nyyy'],
    ])

    const patches: FilePatch[] = [
      {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'remove', content: 'aaa' },
              { type: 'add', content: 'AAA' },
              { type: 'context', content: 'bbb' },
            ],
          },
        ],
      },
      {
        // This will fail — context doesn't match
        oldPath: 'b.ts',
        newPath: 'b.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'context', content: 'WRONG' },
              { type: 'remove', content: 'yyy' },
              { type: 'add', content: 'YYY' },
            ],
          },
        ],
      },
    ]

    const readFile = vi.fn(async (path: string) => files.get(path) ?? null)
    const writeFile = vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    })

    const { results, rolledBack } = await applyPatchSet(
      patches, readFile, writeFile, { rollbackOnFailure: true },
    )

    expect(rolledBack).toBe(true)
    // a.ts should be rolled back to original
    expect(files.get('a.ts')).toBe('aaa\nbbb')
  })

  it('applies partial changes when rollbackOnFailure is false', async () => {
    const files = new Map<string, string>([
      ['a.ts', 'aaa\nbbb'],
      ['b.ts', 'xxx\nyyy'],
    ])

    const patches: FilePatch[] = [
      {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'remove', content: 'aaa' },
              { type: 'add', content: 'AAA' },
              { type: 'context', content: 'bbb' },
            ],
          },
        ],
      },
      {
        // This will fail
        oldPath: 'b.ts',
        newPath: 'b.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'context', content: 'WRONG' },
              { type: 'remove', content: 'yyy' },
              { type: 'add', content: 'YYY' },
            ],
          },
        ],
      },
    ]

    const readFile = vi.fn(async (path: string) => files.get(path) ?? null)
    const writeFile = vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    })

    const { results, rolledBack } = await applyPatchSet(
      patches, readFile, writeFile, { rollbackOnFailure: false },
    )

    expect(rolledBack).toBe(false)
    expect(results[0]!.success).toBe(true)
    expect(results[1]!.success).toBe(false)
    // a.ts should keep the change
    expect(files.get('a.ts')).toBe('AAA\nbbb')
    // b.ts should be unchanged
    expect(files.get('b.ts')).toBe('xxx\nyyy')
  })

  it('handles missing files with E_FILE_NOT_FOUND', async () => {
    const files = new Map<string, string>()

    const patches: FilePatch[] = [
      {
        oldPath: 'missing.ts',
        newPath: 'missing.ts',
        hunks: [
          {
            oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
            lines: [
              { type: 'context', content: 'foo' },
              { type: 'remove', content: 'bar' },
              { type: 'add', content: 'BAR' },
            ],
          },
        ],
      },
    ]

    const readFile = vi.fn(async (_path: string) => null)
    const writeFile = vi.fn()

    const { results } = await applyPatchSet(patches, readFile, writeFile)
    expect(results).toHaveLength(1)
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toBe('E_FILE_NOT_FOUND')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('handles new file creation with add-only hunks', async () => {
    const files = new Map<string, string>()

    const patches: FilePatch[] = [
      {
        oldPath: '/dev/null',
        newPath: 'new-file.ts',
        hunks: [
          {
            oldStart: 0, oldCount: 0, newStart: 1, newCount: 2,
            lines: [
              { type: 'add', content: 'line1' },
              { type: 'add', content: 'line2' },
            ],
          },
        ],
      },
    ]

    const readFile = vi.fn(async (path: string) => files.get(path) ?? null)
    const writeFile = vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    })

    const { results } = await applyPatchSet(patches, readFile, writeFile)
    expect(results).toHaveLength(1)
    expect(results[0]!.success).toBe(true)
    expect(files.get('new-file.ts')).toContain('line1')
    expect(files.get('new-file.ts')).toContain('line2')
  })
})

// ---------------------------------------------------------------------------
// Integration: parseUnifiedDiff + applyPatch
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff + applyPatch integration', () => {
  it('parses and applies a real-world-style diff', () => {
    const original = [
      'import { foo } from "./foo"',
      '',
      'export function main() {',
      '  const x = foo()',
      '  console.log(x)',
      '}',
    ].join('\n')

    const diff = [
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -1,6 +1,7 @@',
      ' import { foo } from "./foo"',
      '+import { bar } from "./bar"',
      ' ',
      ' export function main() {',
      '-  const x = foo()',
      '-  console.log(x)',
      '+  const x = foo()',
      '+  const y = bar()',
      '+  console.log(x, y)',
      ' }',
    ].join('\n')

    const patches = parseUnifiedDiff(diff)
    expect(patches).toHaveLength(1)

    const result = applyPatch(original, patches[0]!)
    expect(result.success).toBe(true)

    const expected = [
      'import { foo } from "./foo"',
      'import { bar } from "./bar"',
      '',
      'export function main() {',
      '  const x = foo()',
      '  const y = bar()',
      '  console.log(x, y)',
      '}',
    ].join('\n')

    expect(result.content).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Integration: InMemoryWorkspaceFS — 3-file patch end-to-end
//
// These tests exercise the full pipeline:
//   parseUnifiedDiff  →  InMemoryWorkspaceFS.applyPatch  →  ws.read
//
// The workspace is purely in-memory (VirtualFS), so no disk I/O or Docker
// dependencies are introduced.
// ---------------------------------------------------------------------------

describe('InMemoryWorkspaceFS — 3-file unified diff integration', () => {
  // Shared initial file contents.  Each file has multiple lines so hunks
  // carry real context lines, exercising the context-matching path of
  // applyPatch as well as the multi-file boundary logic of parseUnifiedDiff.
  const srcA = [
    'export const VERSION = "1.0.0"',
    'export const NAME = "alpha"',
    'export const DEBUG = false',
  ].join('\n') + '\n'

  const srcB = [
    'import { VERSION } from "./a"',
    '',
    'export function greet(name: string): string {',
    '  return `Hello, ${name}! v${VERSION}`',
    '}',
  ].join('\n') + '\n'

  const srcC = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    'Initial release',
  ].join('\n') + '\n'

  function makeWorkspace(): InMemoryWorkspaceFS {
    const vfs = new VirtualFS({
      'src/a.ts': srcA,
      'src/b.ts': srcB,
      'src/c.md': srcC,
    })
    return new InMemoryWorkspaceFS(vfs)
  }

  // -------------------------------------------------------------------------
  // Happy path: all 3 files patched successfully
  // -------------------------------------------------------------------------

  // The same 3-file diff string is reused across all tests in this block.
  // srcC line 5 is "Initial release" (no leading punctuation) so the diff
  // remove line is simply "-Initial release".
  const THREE_FILE_PATCH = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' export const VERSION = "1.0.0"',
    '-export const NAME = "alpha"',
    '+export const NAME = "beta"',
    ' export const DEBUG = false',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -3,3 +3,3 @@',
    ' export function greet(name: string): string {',
    '-  return `Hello, ${name}! v${VERSION}`',
    '+  return `Hi, ${name}! v${VERSION}`',
    ' }',
    '--- a/src/c.md',
    '+++ b/src/c.md',
    '@@ -4,2 +4,2 @@',
    ' ',
    '-Initial release',
    '+Rename alpha to beta',
  ].join('\n')

  it('parseUnifiedDiff returns exactly 3 FilePatch objects for a 3-file diff', () => {
    const patches = parseUnifiedDiff(THREE_FILE_PATCH)

    expect(patches).toHaveLength(3)

    expect(patches[0]!.oldPath).toBe('src/a.ts')
    expect(patches[0]!.newPath).toBe('src/a.ts')
    expect(patches[0]!.hunks).toHaveLength(1)

    expect(patches[1]!.oldPath).toBe('src/b.ts')
    expect(patches[1]!.newPath).toBe('src/b.ts')
    expect(patches[1]!.hunks).toHaveLength(1)

    expect(patches[2]!.oldPath).toBe('src/c.md')
    expect(patches[2]!.newPath).toBe('src/c.md')
    expect(patches[2]!.hunks).toHaveLength(1)
  })

  it('applies a 3-file patch end-to-end and reads back the modified content', async () => {
    const ws = makeWorkspace()

    const result = await ws.applyPatch(THREE_FILE_PATCH, { rollbackOnFailure: true })

    // Overall result
    expect(result.rolledBack).toBe(false)
    expect(result.results).toHaveLength(3)
    for (const fileResult of result.results) {
      expect(fileResult.success).toBe(true)
    }

    // Read back each file and verify the post-patch state exactly.
    const afterA = await ws.read('src/a.ts')
    expect(afterA).toContain('export const NAME = "beta"')
    expect(afterA).not.toContain('export const NAME = "alpha"')
    // Lines not touched by the hunk must remain unchanged.
    expect(afterA).toContain('export const VERSION = "1.0.0"')
    expect(afterA).toContain('export const DEBUG = false')

    const afterB = await ws.read('src/b.ts')
    expect(afterB).toContain('return `Hi, ${name}! v${VERSION}`')
    expect(afterB).not.toContain('return `Hello, ${name}! v${VERSION}`')
    // Unmodified lines are preserved.
    expect(afterB).toContain('import { VERSION } from "./a"')
    expect(afterB).toContain('export function greet(name: string): string {')

    const afterC = await ws.read('src/c.md')
    expect(afterC).toContain('Rename alpha to beta')
    expect(afterC).not.toContain('Initial release')
    // Unmodified markdown lines are preserved.
    expect(afterC).toContain('# Changelog')
    expect(afterC).toContain('## Unreleased')
  })

  // -------------------------------------------------------------------------
  // Negative path: bad hunk for file 2 → atomic rollback of all 3 files
  // -------------------------------------------------------------------------

  it('rolls back all 3 files atomically when the second file patch has a context mismatch', async () => {
    const ws = makeWorkspace()

    // src/a.ts: valid hunk — will be written then rolled back on failure.
    // src/b.ts: bad remove line → E_CONTEXT_MISMATCH → triggers rollback.
    // src/c.md: would be valid, but is never reached (rollbackOnFailure
    //           aborts processing after the first failure).
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' export const VERSION = "1.0.0"',
      '-export const NAME = "alpha"',
      '+export const NAME = "beta"',
      ' export const DEBUG = false',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -3,3 +3,3 @@',
      ' export function greet(name: string): string {',
      '-  return `WRONG CONTENT THAT DOES NOT EXIST`',
      '+  return `Hi, ${name}! v${VERSION}`',
      ' }',
      '--- a/src/c.md',
      '+++ b/src/c.md',
      '@@ -4,2 +4,2 @@',
      ' ',
      '-Initial release',
      '+Rename alpha to beta',
    ].join('\n')

    const result = await ws.applyPatch(patch, { rollbackOnFailure: true })

    // The rollback must have fired.
    expect(result.rolledBack).toBe(true)

    // The first file's result is reported (applyPatchSet stops at first failure
    // when rollbackOnFailure is true, so results length may be 1 or 2
    // depending on whether the failed file's result is included; assert
    // at least the failed file was detected).
    const failedResult = result.results.find((r) => !r.success)
    expect(failedResult).toBeDefined()
    expect(failedResult!.filePath).toBe('src/b.ts')

    const failingHunk = failedResult!.hunkResults.find(
      (h) => !h.applied && h.error !== 'E_ALREADY_APPLIED',
    )
    expect(failingHunk).toBeDefined()
    expect(failingHunk!.error).toBe('E_CONTEXT_MISMATCH')

    // All 3 files must contain exactly their original content — no partial
    // writes should survive the rollback.
    expect(await ws.read('src/a.ts')).toBe(srcA)
    expect(await ws.read('src/b.ts')).toBe(srcB)
    expect(await ws.read('src/c.md')).toBe(srcC)
  })
})
