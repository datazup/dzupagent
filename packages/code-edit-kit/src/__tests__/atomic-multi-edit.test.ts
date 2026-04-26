/**
 * H3 — atomic multi-file edit tool tests.
 *
 * Verifies that `createAtomicMultiEditTool` either applies every edit in the
 * batch or rolls back the partial set on the first failure.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryWorkspaceFS, VirtualFS } from '@dzupagent/codegen'
import {
  createAtomicMultiEditTool,
  type AtomicMultiEditResult,
} from '../atomic-multi-edit.tool.js'

function makeWorkspace(seed: Record<string, string> = {}): InMemoryWorkspaceFS {
  const vfs = new VirtualFS()
  for (const [p, content] of Object.entries(seed)) {
    vfs.write(p, content)
  }
  return new InMemoryWorkspaceFS(vfs)
}

const FILE_A_INITIAL = ['alpha1', 'alpha2', 'alpha3', ''].join('\n')
const FILE_B_INITIAL = ['beta1', 'beta2', 'beta3', ''].join('\n')

const PATCH_A = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' alpha1',
  '-alpha2',
  '+alpha2_modified',
  ' alpha3',
  '',
].join('\n')

const PATCH_B = [
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,3 +1,3 @@',
  ' beta1',
  '-beta2',
  '+beta2_modified',
  ' beta3',
  '',
].join('\n')

// A patch whose context lines do not match — guaranteed to fail to apply.
const BROKEN_PATCH_B = [
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,3 +1,3 @@',
  ' notmatching1',
  '-notmatching2',
  '+notmatching2_modified',
  ' notmatching3',
  '',
].join('\n')

function parse(result: unknown): AtomicMultiEditResult {
  return JSON.parse(String(result)) as AtomicMultiEditResult
}

describe('createAtomicMultiEditTool', () => {
  it('applies every edit when all succeed', async () => {
    const ws = makeWorkspace({ 'a.ts': FILE_A_INITIAL, 'b.ts': FILE_B_INITIAL })
    const tool = createAtomicMultiEditTool(ws)

    const out = parse(
      await tool.invoke({
        edits: [
          { path: 'a.ts', patch: PATCH_A },
          { path: 'b.ts', patch: PATCH_B },
        ],
      }),
    )

    expect(out.applied).toEqual(['a.ts', 'b.ts'])
    expect(out.rolledBack).toEqual([])
    expect(out.error).toBeUndefined()
    expect(await ws.read('a.ts')).toContain('alpha2_modified')
    expect(await ws.read('b.ts')).toContain('beta2_modified')
  })

  it('rolls back the first applied file when a later edit fails', async () => {
    const ws = makeWorkspace({ 'a.ts': FILE_A_INITIAL, 'b.ts': FILE_B_INITIAL })
    const tool = createAtomicMultiEditTool(ws)

    const out = parse(
      await tool.invoke({
        edits: [
          { path: 'a.ts', patch: PATCH_A },
          { path: 'b.ts', patch: BROKEN_PATCH_B },
        ],
      }),
    )

    expect(out.applied).toEqual(['a.ts'])
    expect(out.rolledBack).toEqual(['a.ts'])
    expect(out.error).toBeDefined()
    // a.ts must be back to its pre-batch contents.
    expect(await ws.read('a.ts')).toBe(FILE_A_INITIAL)
    expect(await ws.read('b.ts')).toBe(FILE_B_INITIAL)
  })

  it('reports an error with empty rolledBack when the only edit fails', async () => {
    const ws = makeWorkspace({ 'b.ts': FILE_B_INITIAL })
    const tool = createAtomicMultiEditTool(ws)

    const out = parse(
      await tool.invoke({
        edits: [{ path: 'b.ts', patch: BROKEN_PATCH_B }],
      }),
    )

    expect(out.applied).toEqual([])
    expect(out.rolledBack).toEqual([])
    expect(out.error).toBeDefined()
    expect(await ws.read('b.ts')).toBe(FILE_B_INITIAL)
  })
})
