import { describe, it, expect, vi } from 'vitest'
import { InMemoryWorkspaceFS, VirtualFS } from '@dzupagent/codegen'
import {
  createApplyPatchTool,
  countDiffLines,
  extractDiffFiles,
} from './apply-patch.tool.js'
import type {
  ValidationHook,
  ValidationHookResult,
  ValidationHookContext,
  EditPolicy,
} from '../types.js'

function makeWorkspace(seed: Record<string, string> = {}): InMemoryWorkspaceFS {
  const vfs = new VirtualFS()
  for (const [path, content] of Object.entries(seed)) {
    vfs.write(path, content)
  }
  return new InMemoryWorkspaceFS(vfs)
}

const VALID_DIFF = [
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2_modified',
  ' line3',
  '',
].join('\n')

const INITIAL_FILE = ['line1', 'line2', 'line3', ''].join('\n')

describe('countDiffLines', () => {
  it('counts + and - lines excluding file headers', () => {
    const { added, removed } = countDiffLines(VALID_DIFF)
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })

  it('returns zero for an empty diff', () => {
    expect(countDiffLines('')).toEqual({ added: 0, removed: 0 })
  })

  it('handles multi-file / multi-hunk diffs', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '+new1',
      '+new2',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,2 +1,1 @@',
      '-old',
      ' kept',
      '',
    ].join('\n')
    const { added, removed } = countDiffLines(diff)
    expect(added).toBe(2)
    expect(removed).toBe(1)
  })
})

describe('extractDiffFiles', () => {
  it('returns destination paths stripped of a/b prefix', () => {
    expect(extractDiffFiles(VALID_DIFF)).toEqual(['src/index.ts'])
  })
})

describe('createApplyPatchTool — happy path', () => {
  it('applies a valid diff and reports correct line counts', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const tool = createApplyPatchTool(ws)

    const result = await tool.invoke({ diff: VALID_DIFF })

    expect(result).toContain('Patch applied to 1 file')
    expect(result).toContain('+1/-1 lines')
    expect(result).toContain('src/index.ts')

    // Confirm the write landed.
    const updated = await ws.read('src/index.ts')
    expect(updated).toContain('line2_modified')
    expect(updated).not.toContain('\nline2\n')
  })
})

describe('createApplyPatchTool — pre-apply hook rejection', () => {
  it('aborts before patching when a hook returns { valid: false }', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })

    const runSpy = vi.fn(
      async (_ctx: ValidationHookContext): Promise<ValidationHookResult> => ({
        valid: false,
        reason: 'forbidden content',
      }),
    )

    const hook: ValidationHook = {
      name: 'deny-everything',
      trigger: 'always',
      failureAction: 'rollback',
      run: runSpy,
    }
    const policy: EditPolicy = {
      preferPatch: true,
      maxDirectWriteLines: 5,
      requireValidationAfterWrite: true,
      hooks: [hook],
    }

    const tool = createApplyPatchTool(ws, { policy })
    const result = await tool.invoke({ diff: VALID_DIFF })

    expect(result).toContain('rejected by policy')
    expect(result).toContain('deny-everything')
    expect(result).toContain('forbidden content')

    // The hook must have seen pre_apply stage and the file should remain
    // unchanged on disk.
    expect(runSpy).toHaveBeenCalledTimes(1)
    const call = runSpy.mock.calls[0]!
    expect(call[0]!.stage).toBe('pre_apply')
    expect(call[0]!.filesModified).toEqual(['src/index.ts'])
    expect(call[0]!.linesAdded).toBe(1)
    expect(call[0]!.linesRemoved).toBe(1)

    const unchanged = await ws.read('src/index.ts')
    expect(unchanged).toBe(INITIAL_FILE)
  })
})

describe('createApplyPatchTool — post-apply hook failure', () => {
  it('applies the patch but surfaces the post-hook failure', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })

    const hook: ValidationHook = {
      name: 'type-check',
      trigger: 'after_patch',
      failureAction: 'warn',
      run: async (ctx) => {
        if (ctx.stage === 'post_apply') {
          return { valid: false, reason: 'tsc reported 1 error' }
        }
        return { valid: true }
      },
    }
    const policy: EditPolicy = {
      preferPatch: true,
      maxDirectWriteLines: 5,
      requireValidationAfterWrite: true,
      hooks: [hook],
    }

    const tool = createApplyPatchTool(ws, { policy })
    const result = await tool.invoke({ diff: VALID_DIFF })

    // Post-validation reports failure to the caller
    expect(result).toContain('post-validation failed')
    expect(result).toContain('type-check')
    expect(result).toContain('tsc reported 1 error')

    // The patch WAS applied (post-apply hook runs after the write).
    const updated = await ws.read('src/index.ts')
    expect(updated).toContain('line2_modified')
  })

  it('returns success when all post hooks pass', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })

    const hook: ValidationHook = {
      name: 'always-ok',
      trigger: 'always',
      failureAction: 'warn',
      run: () => ({ valid: true }),
    }
    const policy: EditPolicy = {
      preferPatch: true,
      maxDirectWriteLines: 5,
      requireValidationAfterWrite: true,
      hooks: [hook],
    }
    const tool = createApplyPatchTool(ws, { policy })

    const result = await tool.invoke({ diff: VALID_DIFF })
    expect(result).toContain('Patch applied to 1 file')
    expect(result).toContain('+1/-1 lines')
  })
})

describe('createApplyPatchTool — malformed input', () => {
  it('returns a graceful error for a malformed diff', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const tool = createApplyPatchTool(ws)

    const bogus = 'this is not a diff at all\njust some text\n'
    const result = await tool.invoke({ diff: bogus })

    // Malformed diffs produce either a parse error ("apply_patch failed: …")
    // or result in zero successful files ("Patch applied 0 files…").
    expect(
      result.startsWith('apply_patch failed') ||
        result.startsWith('Patch applied 0 files') ||
        result.startsWith('Patch rejected'),
    ).toBe(true)

    // File on disk must remain untouched.
    const unchanged = await ws.read('src/index.ts')
    expect(unchanged).toBe(INITIAL_FILE)
  })
})

describe('createApplyPatchTool — descriptor-only hook (no run())', () => {
  it('skips hooks that have no in-process runner', async () => {
    const ws = makeWorkspace({ 'src/index.ts': INITIAL_FILE })
    const policy: EditPolicy = {
      preferPatch: true,
      maxDirectWriteLines: 5,
      requireValidationAfterWrite: true,
      hooks: [
        {
          name: 'tsc-descriptor',
          trigger: 'after_patch',
          failureAction: 'warn',
          command: ['tsc', '--noEmit'],
          // no run() — should be ignored
        },
      ],
    }
    const tool = createApplyPatchTool(ws, { policy })
    const result = await tool.invoke({ diff: VALID_DIFF })
    expect(result).toContain('Patch applied to 1 file')
  })
})
