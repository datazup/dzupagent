import { describe, it, expect, vi } from 'vitest'
import {
  parseUnifiedDiff,
  applyPatch,
  applyPatchSet,
  PatchParseError,
  type FilePatch,
} from '../vfs/patch-engine.js'

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
